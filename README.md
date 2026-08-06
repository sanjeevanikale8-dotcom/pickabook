# Toss&Turn — Random Book Generator

A slot-machine style website that scrolls through book titles and lands
on a random one, filterable by genre. Books are stored in a real
Supabase (Postgres) database instead of being hardcoded into the site.

## Files in this folder

| File | What it does |
|---|---|
| `index.html` | The page structure — the box, the buttons, the dropdown. No styling or logic lives here, just the skeleton. |
| `styles.css` | All visual styling — colors, fonts, spacing, the reel animation setup. |
| `script.js` | All the logic — fetching books from Supabase, filtering by genre, running the spin animation. |
| `data/authors.csv` | Batch 1 — the first 108 authors imported into the `authors` table. |
| `data/genres.csv` | The 12 genres, imported into the `genres` table (covers both batches — no new genres were needed for batch 2). |
| `data/books.csv` | Batch 1 — the first 117 books, linked to authors/genres by ID. |
| `data/authors_batch2_new.csv` | Batch 2 — 104 additional authors added later, on top of the original 108 (212 total). |
| `data/books_batch2.csv` | Batch 2 — 134 additional books added later, on top of the original 117 (251 total). |

To run the site: open `index.html` in any browser. It needs an internet
connection, since it fetches book data live from Supabase every time it loads.

## How the pieces connect

```
index.html  →  loads styles.css (how it looks)
            →  loads script.js  (how it behaves)

script.js   →  on page load, calls Supabase's API over the internet
            →  Supabase looks up the "books" table
            →  for each book, it also follows the links to "authors"
               and "genres" and sends back their names
            →  script.js uses that data to fill the dropdown and reel
```

## The database schema

Three tables, related to each other instead of one big flat list —
this is what makes it a relational database rather than a spreadsheet.

```
authors                genres                  books
--------                --------                --------
id  (number, unique)    id  (number, unique)    id         (number, unique)
name (text)             name (text)             title      (text)
                                                 author_id  → points to authors.id
                                                 genre_id   → points to genres.id
```

Each book doesn't store the author's name directly — it stores a
number (`author_id`) that points at a row in the `authors` table.
Same for `genre_id`. This means if an author's name is ever misspelled,
you fix it in ONE place (the `authors` table) instead of hunting down
every book that mentions them.

## Where your data actually lives

Nothing is stored inside these files. All 117 books, 108 authors, and
12 genres live in your Supabase project's database, in the cloud.
These files just know how to *ask* for that data and display it.

To add, edit, or remove books going forward, you have two options:
1. Open your Supabase dashboard → Table Editor → edit rows directly
2. Send me an updated list and I'll prepare new CSVs to import

## The Supabase connection

`script.js` contains two values near the top:

```js
const SUPABASE_URL = 'https://ipjublppyuobozsbmnwp.supabase.co';
const SUPABASE_ANON_KEY = '...';
```

The `SUPABASE_URL` is your project's unique address. The
`SUPABASE_ANON_KEY` is a public key — safe to have visible in the
website's code, because it can only do what your table policies
(Row Level Security) allow. Right now those policies are set to
public read/write, which is fine for a personal/portfolio project
without a login system, but worth knowing if you ever expand this.
