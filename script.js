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
const stats = document.getElementById('stats');

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

  if (pool.length >= 5) {
    // Wrap around so there are books ABOVE and BELOW the highlighted one
    // (2 above, 1 in the bar, 2 below) and the reel looks full before a spin.
    const n = pool.length;
    renderList([pool[n - 2], pool[n - 1], pool[0], pool[1], pool[2]]);
    reel.style.top = (78 - 2 * itemH) + 'px';
  } else {
    renderList(pool);
    reel.style.top = '78px';
  }
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
    stats.textContent = `${books.length} books · ${new Set(books.map(b => b[2])).size} genres · open the menu for more`;
    renderShelf();
    fillSuggestGenres();
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
      addToShelf(winner); // and remember it on this browser's shelf
      // Now that the reel has actually settled, reveal the result.
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
// MY SHELF — your recent spins per genre, saved in this browser
// (localStorage). Nothing here goes to Supabase; it's just a
// personal memory so you never lose track of a book you landed on.
// Shape saved: { "Fantasy": [ {id, title, author}, ... newest first ], ... }
// -----------------------------------------------------------
const SHELF_KEY = 'pickabook_shelf';
const SHELF_LIMIT = 30; // untagged spins kept per genre. Tagged books are never removed.

const menuToggle = document.getElementById('menuToggle');
const menuDrawer = document.getElementById('menuDrawer');
const menuScrim = document.getElementById('menuScrim');
const menuClose = document.getElementById('menuClose');
const drawerBack = document.getElementById('drawerBack');
const drawerTitle = document.getElementById('drawerTitle');
const menuView = document.getElementById('menuView');
const shelfView = document.getElementById('shelfView');
const suggestView = document.getElementById('suggestView');
const trackerView = document.getElementById('trackerView');
const timerView = document.getElementById('timerView');
const shelfRows = document.getElementById('shelfRows');
const shelfDetail = document.getElementById('shelfDetail');
const shelfClear = document.getElementById('shelfClear');

function loadShelf() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
}

function saveShelf(shelf) {
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(shelf));
  } catch (e) {
    console.error('Could not save shelf:', e);
  }
}

function addToShelf(book) {
  const [title, author, genre, id] = book;
  const shelf = loadShelf();
  const row = (shelf[genre] || []).filter(b => b.id !== id); // no duplicates
  row.unshift({ id, title, author });                         // newest first
  // Keep every tagged book; only untagged ones are capped, oldest dropped first.
  const tags = loadTags();
  let untagged = 0;
  shelf[genre] = row.filter(b => {
    if (tags[b.id]) return true;
    untagged++;
    return untagged <= SHELF_LIMIT;
  });
  saveShelf(shelf);
  renderShelf();
}

// Slightly different spine heights so the shelf looks natural.
function spineHeight(id) {
  return 92 + ((Number(id) * 7) % 5) * 6;
}

function shortTitle(title, h) {
  const max = Math.floor((h - 26) / 5.6);
  return title.length > max ? title.slice(0, max - 1).trimEnd() + '…' : title;
}

// Tags (want / reading / read) live in their own storage, separate from
// the shelf, because untagged spins eventually rotate off the shelf —
// but the reading tracker needs to remember every book you finished.
// Shape: { "<bookId>": { tag, title, author, finishedAt } }
const TAGS_KEY = 'pickabook_tags';
const TAG_LABELS = { want: 'Want to read', reading: 'Reading', read: 'Read' };
let selectedShelfId = null;

function loadTags() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAGS_KEY));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
}

function saveTags(tags) {
  try {
    localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
  } catch (e) {
    console.error('Could not save tags:', e);
  }
}

// Tapping a tag sets it; tapping the same tag again removes it.
function setTag(item, tag) {
  const tags = loadTags();
  const cur = tags[item.id];
  if (cur && cur.tag === tag) {
    delete tags[item.id];
  } else {
    const keepDate = cur && cur.tag === 'read' && tag === 'read';
    tags[item.id] = {
      tag,
      title: item.title,
      author: item.author,
      finishedAt: tag === 'read' ? (keepDate ? cur.finishedAt : new Date().toISOString()) : null
    };
  }
  saveTags(tags);
  renderShelf();
}

function renderShelf() {
  const shelf = loadShelf();
  const tags = loadTags();
  const names = [...new Set([...books.map(b => b[2]), ...Object.keys(shelf)])].sort();
  shelfRows.textContent = '';
  let selectedItem = null;

  names.forEach(name => {
    const items = shelf[name] || [];
    const group = document.createElement('div');
    group.className = 'shelf-genre';

    const label = document.createElement('div');
    label.className = 'shelf-genre-name';
    label.textContent = name;

    const row = document.createElement('div');
    row.className = 'shelf-row';

    const slots = Math.max(6, items.length); // always show at least 6 places on the shelf
    for (let i = 0; i < slots; i++) {
      const item = items[i];
      if (!item) {
        const slot = document.createElement('div');
        slot.className = 'shelf-slot';
        row.appendChild(slot);
        continue;
      }
      const h = spineHeight(item.id);
      const tag = tags[item.id] ? tags[item.id].tag : null;
      const isSelected = item.id === selectedShelfId;
      if (isSelected) selectedItem = item;

      const spine = document.createElement('button');
      spine.type = 'button';
      spine.className = `spine c${Number(item.id) % 5}` + (tag ? ` t-${tag}` : '') + (isSelected ? ' out' : '');
      spine.style.height = h + 'px';
      spine.setAttribute('aria-label', `${item.title} by ${item.author}` + (tag ? ` (${TAG_LABELS[tag]})` : ''));
      const t = document.createElement('span');
      t.className = 'spine-title';
      t.textContent = shortTitle(item.title, h);
      spine.appendChild(t);
      spine.addEventListener('click', () => {
        shelfRows.querySelectorAll('.spine.out').forEach(s => s.classList.remove('out'));
        spine.classList.add('out');
        selectedShelfId = item.id;
        showShelfDetail(item);
      });
      row.appendChild(spine);
    }

    group.appendChild(label);
    group.appendChild(row);
    shelfRows.appendChild(group);
  });

  if (selectedItem) {
    showShelfDetail(selectedItem);
  } else {
    selectedShelfId = null;
    shelfDetail.textContent = Object.keys(shelf).length
      ? 'Tap a spine to pull it out.'
      : 'Spin for a book to start filling your shelf.';
  }
}

function showShelfDetail(item) {
  const tags = loadTags();
  const current = tags[item.id] ? tags[item.id].tag : null;

  shelfDetail.textContent = '';
  const t = document.createElement('strong');
  t.textContent = item.title;
  const a = document.createElement('div');
  a.textContent = item.author;

  const tagRow = document.createElement('div');
  tagRow.className = 'tag-row';
  Object.entries(TAG_LABELS).forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-btn' + (key === current ? ' on' : '');
    b.setAttribute('aria-pressed', String(key === current));
    b.textContent = label;
    b.addEventListener('click', () => setTag(item, key));
    tagRow.appendChild(b);
  });

  const link = document.createElement('a');
  link.href = 'https://www.google.com/search?q=' + encodeURIComponent(`${item.title} ${item.author}`);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Look it up →';
  shelfDetail.append(t, a, tagRow, link);
}

// The drawer has two "views": the list of menu options, and the
// screen for whichever option you picked (so far just the shelf).
// To add another option later: add a <li> in index.html and add
// its view here.
function showView(view) {
  const views = { shelf: shelfView, tracker: trackerView, timer: timerView, suggest: suggestView };
  const titles = { shelf: 'My shelf', tracker: 'Tracker', timer: 'Reading timer', suggest: 'Suggest a book' };
  menuView.hidden = view in views;
  Object.entries(views).forEach(([name, el]) => { el.hidden = name !== view; });
  drawerBack.hidden = !(view in views);
  drawerTitle.textContent = titles[view] || 'Menu';
  if (view === 'shelf') renderShelf();
  if (view === 'tracker') renderTracker();
  if (view === 'timer') renderTimer();
}

function setMenuOpen(open) {
  menuDrawer.classList.toggle('open', open);
  menuScrim.classList.toggle('open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  if (open) showView('menu'); // always start at the list
  (open ? menuClose : menuToggle).focus();
}

menuToggle.addEventListener('click', () => setMenuOpen(!menuDrawer.classList.contains('open')));
menuClose.addEventListener('click', () => setMenuOpen(false));
menuScrim.addEventListener('click', () => setMenuOpen(false));
drawerBack.addEventListener('click', () => showView('menu'));
document.querySelectorAll('.menu-item').forEach(btn =>
  btn.addEventListener('click', () => showView(btn.dataset.view)));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuDrawer.classList.contains('open')) setMenuOpen(false);
});
shelfClear.addEventListener('click', () => {
  if (confirm('Clear your shelf? Your reading tracker is kept.')) {
    saveShelf({});
    selectedShelfId = null;
    renderShelf();
  }
});


// -----------------------------------------------------------
// SUGGEST A BOOK — sends the form to a separate "book_suggestions"
// table in Supabase with status "pending". It never touches the
// real "books" table, so nothing shows up on the reel until you
// approve it yourself in the Supabase dashboard.
// -----------------------------------------------------------
const suggestForm = document.getElementById('suggestForm');
const sugTitle = document.getElementById('sugTitle');
const sugAuthor = document.getElementById('sugAuthor');
const sugGenre = document.getElementById('sugGenre');
const sugSubmit = document.getElementById('sugSubmit');
const sugStatus = document.getElementById('sugStatus');
const SUG_COOLDOWN_MS = 30000; // stops accidental double-sends / spam

function fillSuggestGenres() {
  const genres = [...new Set(books.map(b => b[2]))].sort();
  sugGenre.textContent = '';
  [...genres, 'Other / not sure'].forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    sugGenre.appendChild(opt);
  });
}

suggestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = sugTitle.value.trim();
  const author = sugAuthor.value.trim();
  if (!title || !author) {
    sugStatus.textContent = 'Please fill in the title and author.';
    return;
  }

  let last = 0;
  try { last = Number(localStorage.getItem('pickabook_last_suggest')) || 0; } catch (err) {}
  if (Date.now() - last < SUG_COOLDOWN_MS) {
    sugStatus.textContent = 'One sec — wait a moment before sending another.';
    return;
  }

  sugSubmit.disabled = true;
  sugStatus.textContent = 'Sending…';
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/book_suggestions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, author, genre: sugGenre.value })
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    try { localStorage.setItem('pickabook_last_suggest', String(Date.now())); } catch (err) {}
    suggestForm.reset();
    sugStatus.textContent = 'Thanks! Your suggestion is in for review.';
  } catch (err) {
    console.error('Could not send suggestion:', err);
    sugStatus.textContent = 'Could not send that — please try again later.';
  } finally {
    sugSubmit.disabled = false;
  }
});

// -----------------------------------------------------------
// TRACKER — counts books you've tagged "Read", by month, and
// shows progress toward a monthly goal. All saved in this browser.
// -----------------------------------------------------------
const GOAL_KEY = 'pickabook_goal';
const goalLabel = document.getElementById('goalLabel');
const goalCount = document.getElementById('goalCount');
const goalFill = document.getElementById('goalFill');
const goalInput = document.getElementById('goalInput');
const goalSave = document.getElementById('goalSave');
const monthBars = document.getElementById('monthBars');
const trackerExtra = document.getElementById('trackerExtra');
const trackerSub = document.getElementById('trackerSub');

function monthKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function loadGoal() {
  try { return Number(localStorage.getItem(GOAL_KEY)) || 0; } catch (e) { return 0; }
}

function renderTracker() {
  const tags = Object.values(loadTags());
  const counts = {};
  tags.filter(t => t.tag === 'read' && t.finishedAt).forEach(t => {
    const k = monthKey(new Date(t.finishedAt));
    counts[k] = (counts[k] || 0) + 1;
  });

  const now = new Date();
  const goal = loadGoal();
  const doneNow = counts[monthKey(now)] || 0;
  const monthName = now.toLocaleString('default', { month: 'long' });

  goalLabel.textContent = goal && doneNow >= goal ? `${monthName} goal reached 🎉` : `${monthName}`;
  goalCount.textContent = goal ? `${doneNow} / ${goal} books` : `${doneNow} read`;
  goalFill.style.width = goal ? Math.min(100, (doneNow / goal) * 100) + '%' : '0%';
  goalInput.value = goal || '';

  // January to December of the current year
  const year = now.getFullYear();
  trackerSub.textContent = `Books read in ${year}`;
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(year, i, 1);
    months.push({ name: d.toLocaleString('default', { month: 'short' }), n: counts[monthKey(d)] || 0 });
  }
  const max = Math.max(1, goal, ...months.map(m => m.n));
  monthBars.textContent = '';
  months.forEach(m => {
    const row = document.createElement('div');
    row.className = 'month-row';
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = m.name;
    const track = document.createElement('div');
    track.className = 'm-track';
    const fill = document.createElement('div');
    fill.className = 'm-fill';
    fill.style.width = (m.n / max) * 100 + '%';
    track.appendChild(fill);
    const n = document.createElement('span');
    n.className = 'm-count';
    n.textContent = m.n;
    row.append(name, track, n);
    monthBars.appendChild(row);
  });

  const reading = tags.filter(t => t.tag === 'reading').length;
  const want = tags.filter(t => t.tag === 'want').length;
  trackerExtra.textContent = `Reading now: ${reading} · Want to read: ${want}`;
}

goalSave.addEventListener('click', () => {
  const v = parseInt(goalInput.value, 10);
  try {
    if (Number.isFinite(v) && v >= 1) localStorage.setItem(GOAL_KEY, String(Math.min(v, 99)));
    else localStorage.removeItem(GOAL_KEY);
  } catch (e) {}
  renderTracker();
});

// -----------------------------------------------------------
// READING TIMER — a pomodoro: a reading session, then a break.
// It uses the clock time it should end at (not "count down by 1
// each second"), so it stays accurate even if the tab is in the
// background. Closing the menu does NOT stop it.
// -----------------------------------------------------------
const SESSIONS_KEY = 'pickabook_sessions';
const timerMode = document.getElementById('timerMode');
const timerDisplay = document.getElementById('timerDisplay');
const timerStart = document.getElementById('timerStart');
const timerReset = document.getElementById('timerReset');
const focusMins = document.getElementById('focusMins');
const breakMins = document.getElementById('breakMins');
const timerSessions = document.getElementById('timerSessions');

let timerKind = 'focus';   // 'focus' or 'break'
let timerRunning = false;
let timerEndAt = 0;
let timerLeftMs = Number(focusMins.value) * 60000;
let timerInterval = null;

function timerDuration() {
  return Number(timerKind === 'focus' ? focusMins.value : breakMins.value) * 60000;
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const sec = String(total % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function todayKey() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function sessionsToday() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY));
    return raw && raw.date === todayKey() ? Number(raw.count) || 0 : 0;
  } catch (e) { return 0; }
}

function addSession() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({ date: todayKey(), count: sessionsToday() + 1 }));
  } catch (e) {}
}

function renderTimer() {
  const left = timerRunning ? timerEndAt - Date.now() : timerLeftMs;
  timerDisplay.textContent = formatTime(left);
  timerMode.textContent = timerKind === 'focus' ? 'Reading session' : 'Break — stretch and rest your eyes';
  timerStart.textContent = timerRunning ? 'Pause' : 'Start';
  const n = sessionsToday();
  timerSessions.textContent = n ? `Sessions finished today: ${n}` : '';
  document.title = timerRunning ? `${formatTime(left)} · pickabook` : 'pickabook';
}

// A soft two-note chime when a session ends (respects the mute button).
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playChime() {
  if (!soundOn) return;
  try {
    const ctx = getAudio();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + i * 0.25;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 1.05);
    });
  } catch (e) {}
}

function timerTick() {
  if (timerEndAt - Date.now() <= 0) {
    clearInterval(timerInterval);
    timerRunning = false;
    if (timerKind === 'focus') addSession();
    timerKind = timerKind === 'focus' ? 'break' : 'focus';
    timerLeftMs = timerDuration();
    playChime();
  }
  renderTimer();
}

timerStart.addEventListener('click', () => {
  if (timerRunning) {
    timerLeftMs = timerEndAt - Date.now();
    timerRunning = false;
    clearInterval(timerInterval);
  } else {
    try { getAudio(); } catch (e) {} // created on a click so the chime is allowed to play later
    timerEndAt = Date.now() + timerLeftMs;
    timerRunning = true;
    timerInterval = setInterval(timerTick, 250);
  }
  renderTimer();
});

timerReset.addEventListener('click', () => {
  clearInterval(timerInterval);
  timerRunning = false;
  timerLeftMs = timerDuration();
  renderTimer();
});

[focusMins, breakMins].forEach(sel => sel.addEventListener('change', () => {
  if (!timerRunning) timerLeftMs = timerDuration();
  renderTimer();
}));

// -----------------------------------------------------------
// MINI STORYBOOKS — tiny clickable books scattered around the page.
// Each entry: [name, cover color, x%, y%, phone x%, phone y%, tilt°]
// (x/y = where it sits on wide screens, in the side margins;
//  phone x/y = where it sits in the scatter area on small screens.)
// Palette: the "fig" palette.
// -----------------------------------------------------------
const MINI_BOOKS = [
  ['Peach',          '#E18079',  7, 22,   3,  3, -12],
  ['Juniper',        '#817F3E', 16, 38,  27,  8,   8],
  ['Deep Raspberry', '#862C4D',  5, 50,  51,  2,  14],
  ['Rose',           '#D8ADAA', 13, 66,  75,  6,  -7],
  ['Lilac',          '#B385A2',  6, 80,  11, 38,  10],
  ['Plum',           '#503447', 18, 86,  35, 34, -13],
  ['Burnt Copper',   '#88241E', 88, 18,  59, 40,  12],
  ['Millstone Grey', '#444D4C', 80, 34,  78, 36,  -8],
  ['Berry',          '#B25074', 92, 45,   2, 72, -15],
  ['Poppy',          '#D65341', 84, 60,  26, 76,   6],
  ['Cream',          '#E9D8C0', 94, 72,  52, 70,  14],
  ['Sagewood',       '#507555', 82, 84,  74, 74, -10]
];
const MINI_BOOKS_OPEN_AT = [1, 4, 6, 9]; // which ones start open

function buildMiniBooks() {
  const field = document.getElementById('bookField');
  if (!field) return;
  MINI_BOOKS.forEach(([name, color, x, y, mx, my, r], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const startOpen = MINI_BOOKS_OPEN_AT.includes(i);
    b.className = 'mini-book' + (startOpen ? ' open' : '');
    b.style.setProperty('--bk', color);
    b.style.setProperty('--x', x);
    b.style.setProperty('--y', y);
    b.style.setProperty('--mx', mx);
    b.style.setProperty('--my', my);
    b.style.setProperty('--r', r + 'deg');
    b.setAttribute('aria-pressed', String(startOpen));
    b.setAttribute('aria-label', `${name} book`);
    b.innerHTML = '<span class="mb"><span class="mb-base"></span><span class="mb-page"></span>' +
      '<span class="mb-cover"><span class="mb-front"></span><span class="mb-back"></span></span></span>';
    b.addEventListener('click', () => {
      const open = b.classList.toggle('open');
      b.setAttribute('aria-pressed', String(open));
      if (typeof playTick === 'function') playTick(); // soft tick, respects the mute button
    });
    field.appendChild(b);
  });
}
buildMiniBooks();

// -----------------------------------------------------------
// 8. WIRE UP THE GENRE DROPDOWN + KICK EVERYTHING OFF
// -----------------------------------------------------------
genreSelect.addEventListener('change', renderPreview);

// This is the very first thing that runs when the page loads —
// it goes and fetches your real books from Supabase.
loadBooksFromSupabase();
