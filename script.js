/* ==========================================================
   TOSS & TURN — main logic
   This file does three jobs:
     1. Fetch real book data from your Supabase database
     2. Build/update the genre filter dropdown
     3. Run the spinning-reel animation and pick a winner
   ========================================================== */

// -----------------------------------------------------------
// 1. SUPABASE CONNECTION DETAILS
// -----------------------------------------------------------
// SUPABASE_URL is the address of your project's API.
// SUPABASE_ANON_KEY is a public identifier — safe to expose in
// client-side code. It does NOT grant admin power; what it can
// read/write is controlled entirely by the RLS policies you set
// up in the Supabase dashboard (we made them public-read/write).
const SUPABASE_URL = 'https://ipjublppyuobozsbmnwp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwanVibHBweXVvYm96c2JtbndwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NDU3NTcsImV4cCI6MjEwMTQyMTc1N30.cOj-2R0XglDLkgdLkk2gSzI_wlmyamGqY2vM7_TMfj4';

// -----------------------------------------------------------
// 2. STATE
// books starts empty. It gets filled in by loadBooksFromSupabase()
// once the page loads and the network request comes back.
// Each entry is shaped like: [title, authorName, genreName]
// -----------------------------------------------------------
let books = [];
let spinning = false;
let currentWinner = null;
let soundOn = true; // toggled by the mute button

// -----------------------------------------------------------
// 3. GRAB REFERENCES TO THE HTML ELEMENTS WE'LL CONTROL
// document.getElementById finds the element with that id
// attribute in index.html, so we can read/change it from here.
// -----------------------------------------------------------
const genreSelect = document.getElementById('genreSelect');
const reel = document.getElementById('reel');
const spinBtn = document.getElementById('spinBtn');
const muteBtn = document.getElementById('muteBtn');
const resultBox = document.getElementById('resultBox');
const readBtn = document.getElementById('readBtn');
const footnote = document.getElementById('footnote');

const itemH = 64; // must match .reel-item's height in styles.css

// -----------------------------------------------------------
// SOUND — a single short "tick" synthesized with the Web Audio
// API, instead of loading an audio file from somewhere. This
// keeps the site self-contained (no extra assets to host).
// -----------------------------------------------------------
let audioCtx = null;

function playTick() {
  if (!soundOn) return;

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // This mimics the iOS keyboard/scroll-wheel click style: extremely
  // short, dry, almost no pitch — more a "tak" of texture than a note.
  // It's built from a tiny burst of filtered noise, not a musical tone.
  const now = audioCtx.currentTime;
  const duration = 0.012; // 12ms — much shorter than the marimba version
  const bufferSize = Math.floor(audioCtx.sampleRate * duration);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const decay = 1 - i / bufferSize;
    data[i] = (Math.random() * 2 - 1) * decay * decay; // steep decay = "dry" feel
  }

  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;

  // A low-pass filter keeps it dull/soft rather than crisp static —
  // this is what makes it feel like a muted physical click. A higher
  // cutoff here lets more high-frequency content through, raising
  // the perceived pitch of the click.
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3600;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.4;

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);

  noise.start(now);
}

muteBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  muteBtn.textContent = soundOn ? '🔊' : '🔇';
  muteBtn.setAttribute('aria-label', soundOn ? 'Mute sound' : 'Unmute sound');
});

// -----------------------------------------------------------
// THEME TOGGLE — switches between the dark "matcha" palette
// (sage green background) and the light "strawberry" palette
// (blush pink background). Both sets of colors live in
// styles.css as CSS variables; this just flips which set is
// active by adding/removing a data-theme attribute on <html>.
// -----------------------------------------------------------
const themeToggle = document.getElementById('themeToggle');
let isLightMode = false;

themeToggle.addEventListener('click', () => {
  isLightMode = !isLightMode;
  document.documentElement.setAttribute('data-theme', isLightMode ? 'light' : 'dark');
  themeToggle.textContent = isLightMode ? '☀️' : '🌙';
  themeToggle.setAttribute(
    'aria-label',
    isLightMode ? 'Switch to dark mode' : 'Switch to light mode'
  );
});

// -----------------------------------------------------------
// 4. RENDER HELPERS
// -----------------------------------------------------------

// Takes an array of [title, author, genre] and turns it into
// the actual HTML rows shown inside the reel.
function renderList(list) {
  reel.innerHTML = list.map(b => `
    <div class="reel-item">
      <div class="title">${b[0]}</div>
      <div class="author">${b[1]}</div>
    </div>`).join('');
}

// Looks at whatever is currently in `books`, pulls out the unique
// genre names, and rebuilds the <select> dropdown's <option> list.
function rebuildGenreOptions() {
  const genres = [...new Set(books.map(b => b[2]))].sort();
  genreSelect.innerHTML = '<option value="all">All genres</option>' +
    genres.map(g => `<option value="${g}">${g}</option>`).join('');
}

// Shows a small preview (first 6 books) matching the selected genre,
// before the user has actually spun anything.
function renderPreview() {
  const genre = genreSelect.value;
  const pool = genre === 'all' ? books : books.filter(b => b[2] === genre);
  renderList(pool.slice(0, 6));
  resultBox.style.display = 'none';
  footnote.textContent = '';
  currentWinner = null;
}

// -----------------------------------------------------------
// 5. FETCH BOOKS FROM SUPABASE
// This is the core "database" part of the app. It asks Supabase's
// auto-generated REST API for every row in the "books" table, and
// uses the ?select=... query to also follow the author_id/genre_id
// links and bring back the actual names (a SQL join, done for you).
// -----------------------------------------------------------
async function loadBooksFromSupabase() {
  spinBtn.disabled = true;
  footnote.textContent = 'Loading books…';

  try {
    const url = `${SUPABASE_URL}/rest/v1/books?select=id,title,authors(name),genres(name)`;

    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const data = await response.json();

    // Supabase returns rows shaped like:
    // { title: "Dune", authors: { name: "Frank Herbert" }, genres: { name: "Science Fiction" } }
    // We reshape that into the simpler [title, author, genre] array
    // the rest of this file already knows how to work with.
    books = data.map(row => [
      row.title,
      row.authors ? row.authors.name : 'Unknown author',
      row.genres ? row.genres.name : 'Uncategorized',
      row.id
    ]);

    rebuildGenreOptions();
    renderPreview();
    spinBtn.disabled = false;
    footnote.textContent = '';
  } catch (err) {
    footnote.textContent = 'Could not load books — check your connection and try refreshing.';
    console.error('Supabase fetch failed:', err);
  }
}
// -----------------------------------------------------------
// Logs a spin to Supabase by inserting one new row into the
// "spins" table. This is a POST request (writing data) instead
// of the GET requests we've used so far (reading data).
// -----------------------------------------------------------
async function logSpin(bookId) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/spins`;

    await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ book_id: bookId })
    });
  } catch (err) {
    console.error('Could not log spin:', err);
  }
}
// -----------------------------------------------------------
// 6. THE SPIN ANIMATION
// This runs the reel by hand, frame by frame, instead of letting
// CSS animate it. Driving it in JS lets us know exactly when a
// new row crosses the highlighted window, so we can play a tick
// at that exact moment — like a real slot machine.
// -----------------------------------------------------------

// Eases from fast to slow, similar feel to the old CSS curve —
// starts quick, decelerates smoothly into the stop.
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

spinBtn.addEventListener('click', () => {
  if (spinning) return; // ignore clicks while already spinning
  spinning = true;
  spinBtn.disabled = true;
  resultBox.style.display = 'none';
  footnote.textContent = '';

  // Filter down to just the selected genre (or everything, if "all")
  const genre = genreSelect.value;
  const pool = genre === 'all' ? books : books.filter(b => b[2] === genre);

  if (pool.length === 0) {
    spinning = false;
    spinBtn.disabled = false;
    footnote.textContent = 'No books found in that genre yet.';
    return;
  }

  // Shuffle the pool randomly, then repeat it enough times to fill
  // a long scrolling reel (so the animation has room to spin).
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const reelLen = Math.max(40, pool.length * 4);
  const sequence = [];
  for (let i = 0; i < reelLen; i++) sequence.push(shuffled[i % shuffled.length]);

  // The book 6 rows from the end of the sequence is the one that will
  // land in the highlighted window — that's our "winner".
  const winnerIndex = reelLen - 6;
  const winner = sequence[winnerIndex];
  currentWinner = winner;

  renderList(sequence);

  // Reset the reel to the top instantly before spinning
  reel.style.top = '78px';

  const startTop = 78;
  const finalTop = 78 - (winnerIndex * itemH);
  const duration = 3200; // milliseconds, matches the old animation length
  const startTime = performance.now();
  let lastRowCrossed = 0; // tracks which row we last played a tick for

  function frame(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1); // progress from 0 to 1
    const eased = easeOutCubic(t);
    const currentTop = startTop + (finalTop - startTop) * eased;
    reel.style.top = currentTop + 'px';

    // How many full rows has the reel moved so far? Every time this
    // number increases, a new title has crossed the window — tick.
    const rowsCrossed = Math.floor((startTop - currentTop) / itemH);
    if (rowsCrossed > lastRowCrossed) {
      playTick();
      lastRowCrossed = rowsCrossed;
    }

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      // Main spin is done — now run a short "bounce" phase instead of
      // just stopping dead. The reel overshoots slightly past the
      // winner, then springs back, like it has a little physical
      // weight to it rather than snapping to a stop.
      runBounce(finalTop, winner);
    }
  }

  requestAnimationFrame(frame);
});

// -----------------------------------------------------------
// The bounce: a decaying oscillation layered on top of the final
// resting position. It swings past finalTop, back the other way
// a little less far, and settles — each swing smaller than the
// last, which is what reads as "springy" rather than mechanical.
// -----------------------------------------------------------
function runBounce(finalTop, winner) {
  const bounceDuration = 420; // milliseconds
  const amplitude = 10;       // how far it overshoots, in pixels
  const oscillations = 2.5;   // how many swings before settling
  const bounceStart = performance.now();

  function bounceFrame(now) {
    const elapsed = now - bounceStart;
    const t = Math.min(elapsed / bounceDuration, 1);

    // A sine wave that fades out as t approaches 1 — each swing
    // is smaller than the last, ending exactly at 0 (finalTop).
    const decay = 1 - t;
    const offset = amplitude * decay * Math.sin(t * Math.PI * 2 * oscillations);

    reel.style.top = (finalTop + offset) + 'px';


    if (t < 1) {
      requestAnimationFrame(bounceFrame);
    } else {
      reel.style.top = finalTop + 'px';
      logSpin(winner[3]); // log this spin to Supabase
      // Now that the reel has actually settled, reveal the result.// Now that the reel has actually settled, reveal the result.
      spinning = false;
      spinBtn.disabled = false;
      resultBox.style.display = 'block';
      footnote.textContent = `Landed on "${winner[0]}" by ${winner[1]}`;
    }
  }

  requestAnimationFrame(bounceFrame);
}

// -----------------------------------------------------------
// 7. "READ THIS BOOK" BUTTON
// Currently opens a Google search for the winning book. Swap this
// out for a synopsis modal, an ebook link, etc. whenever you want.
// -----------------------------------------------------------
readBtn.addEventListener('click', () => {
  if (!currentWinner) return;
  const query = encodeURIComponent(`${currentWinner[0]} ${currentWinner[1]}`);
  window.open(`https://www.google.com/search?q=${query}`, '_blank');
});

// -----------------------------------------------------------
// 8. WIRE UP THE GENRE DROPDOWN + KICK EVERYTHING OFF
// -----------------------------------------------------------
genreSelect.addEventListener('change', renderPreview);

// This is the very first thing that runs when the page loads —
// it goes and fetches your real books from Supabase.
loadBooksFromSupabase();
