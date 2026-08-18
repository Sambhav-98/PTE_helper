# PTE Prep Hub

A NotebookLM-style study app for the PTE Academic handbook (Ultimate Language Academy), backed by OpenAI. The handbook content lives in `knowledge.js` and is used as grounding context for every chat answer. The OpenAI API key lives only on the server, in a `.env` file — it's never sent to or stored in the browser.

Three panels, like NotebookLM, plus a calendar:
- **Sources** (left) — the handbook, broken into sections.
- **Chat** (center) — ask anything; answers are grounded only in the handbook.
- **Studio** (right) — three tabs:
  - **Dashboard** — two circular progress rings (Roadmap completion, Task completion), a quick stats card (notes saved, tasks scheduled), and the original quick-facts / task-weight reference.
  - **Roadmap** — a step-by-step, phase-by-phase study plan built from the handbook's own task-priority data, with a checklist you can tick off as you go.
  - **Notebook** — save any chat reply with one click, or write your own notes. Everything persists on the server.
- **Calendar** (opens from the top bar, on any screen size) — a month view where students can add tasks to specific days, check them off, and delete them. Task counts show as dots on each day; completion feeds the Dashboard's "Tasks" ring.

## Optional: your own personal reference material

You can point the app at a PDF you personally own (e.g. a practice-test book) for extra context, **without ever copying that file into this project**. There are two ways to point at it — use whichever fits your hosting situation.

### Option A — a local file path (`REFERENCE_PDF_PATH`)

Best when your server has real persistent storage: your own VPS, or a Render instance on a paid plan with a [persistent disk](https://render.com/docs/disks) attached. Render's free tier has an *ephemeral* filesystem, so a local path won't survive a redeploy there — use Option B instead in that case.

1. Keep the PDF wherever you like on your server — it does *not* need to be inside this project folder. (If you do put it in a `reference/` folder here for convenience, it's already gitignored, along with any `*.pdf`.)
2. In `.env`:
   ```
   REFERENCE_PDF_PATH=/absolute/path/to/your-book.pdf
   ```
3. Restart the server.

### Option B — a Google Drive link (`REFERENCE_PDF_DRIVE_URL`)

Works on free hosting tiers (including Render's free plan) because nothing needs to persist on disk — the file is fetched fresh into memory every time the server starts.

1. Upload the PDF to Google Drive and set its sharing to **"Anyone with the link" → Viewer**. (This makes the file fetchable by an unauthenticated request — it's not indexed or searchable by Google, but anyone who has the exact link/ID could access it, similar in spirit to an unguessable S3 link. It is not the same as keeping it fully private to your account.)
2. Copy the share link, and in `.env`:
   ```
   REFERENCE_PDF_DRIVE_URL=https://drive.google.com/file/d/YOUR_FILE_ID/view?usp=sharing
   ```
   (A bare file ID works too.)
3. Restart the server.

**A caveat worth knowing:** Drive doesn't offer a documented public API for this — the app uses the same trick tools like `gdown` use, extracting a one-time confirmation token from Drive's "can't scan this file for viruses" interstitial page (which appears for files over ~25MB). This depends on the current structure of that page, which Google could change without notice and silently break this feature. If it stops working, check the server logs (`Reference material: ...`) for the specific error, and consider switching to Option A or a dedicated file host (S3/R2 presigned URL, etc.) if you need something more durable.

If both env vars are set, `REFERENCE_PDF_PATH` takes priority; Google Drive is only tried if no local file is found.

Either way, once loaded, the Sources panel shows "Personal Reference — Connected · N pages · local file" or "· Google Drive". When a chat answer draws on it, a small "Personal reference · p. N" badge appears under that reply in the chat — so it's always visible when (and which pages) your own material contributed, rather than blending in silently with the handbook content.

**How it stays lightweight and copyright-safe by design, regardless of which option you use:**
- The PDF is never copied into this project, never committed to git, never uploaded anywhere by the app itself.
- `reference.js` parses it into memory only (a few seconds at startup, even from a fresh Drive fetch) and builds a small keyword-search index. Nothing extracted from it is written to disk.
- On each chat message, the server does a keyword search over that index and pulls back at most 2–3 short excerpts, **hard-capped at 900 characters total** (roughly a paragraph or two) — never the full document, and never even a full page.
- The system prompt explicitly instructs the model to paraphrase those excerpts rather than quote them at length, and to refer to it generically as "your reference material."
- If neither env var is set, or loading fails for any reason, the app just runs without it — nothing else breaks.

This is meant for supplementary, on-demand context from something you already own, not for turning the app into a way to read the whole book through chat.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Open `.env` and add your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-your-real-key-here
   OPENAI_MODEL=gpt-4o-mini
   PORT=3000
   REFERENCE_PDF_PATH=
   ```
   (Leave `REFERENCE_PDF_PATH` blank unless you're using the optional personal reference feature described below.)

4. Start the server:
   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project structure

```
pte-prep-hub/
├── server.js         Express server — loads .env, calls OpenAI, serves the frontend, exposes the API
├── knowledge.js       The handbook content, split into named sections
├── roadmap.js          The step-by-step study plan (phases + steps + "why it matters")
├── reference.js          On-demand PDF excerpt search (parses, chunks, keyword-searches, caps output — see below)
├── storage.js           Tiny JSON-file read/write helpers for notes, roadmap progress, and tasks
├── index.html             Frontend (Sources / Chat / Studio: Dashboard, Roadmap, Notebook / Calendar modal)
├── data/                    Created automatically at runtime — notes.json, progress.json, tasks.json (gitignored)
├── .env.example         Template for your local .env (copy, don't edit directly)
├── .env                  Your real secrets — gitignored, created by you
└── package.json
```

Note: the server only exposes `index.html` itself over HTTP (via `GET /`) — it does not serve the project directory as a whole, so `server.js`, `knowledge.js`, and `.env` are never reachable by a browser.

## How it works

- The frontend never talks to OpenAI directly. It calls local endpoints only:
  - `POST /api/chat` — sends the conversation, gets back `{ reply, reference }`, where `reference` is `null` unless your personal reference material contributed relevant excerpts to that specific answer, in which case it's `{ pages: [...] }`
  - `GET /api/health` — reports whether a server-side key is configured (no key value is ever returned)
  - `GET /api/sources` — returns just the section titles for the left panel
  - `GET /api/roadmap` — returns the study plan with each step's current done/not-done state
  - `POST /api/roadmap/progress` — toggles one step (`{ stepId, done }`)
  - `GET /api/notes` — returns all saved notes, newest first
  - `POST /api/notes` — saves a note (`{ title, content, type }`, where `type` is `"manual"` or `"chat"`)
  - `DELETE /api/notes/:id` — deletes a note
  - `GET /api/tasks` — returns all calendar tasks
  - `POST /api/tasks` — creates a task (`{ date: "YYYY-MM-DD", title }`)
  - `PUT /api/tasks/:id` — updates a task (`{ done }` and/or `{ title }` and/or `{ date }`)
  - `DELETE /api/tasks/:id` — deletes a task
  - `GET /api/reference-status` — reports whether a personal reference PDF is loaded, its page count, and which source loaded it (`"local"` or `"gdrive"`) — never its path, filename, or content
- `server.js` builds a system prompt from `knowledge.js` on every chat request and sends it to OpenAI's Chat Completions API using the key from `.env`.
- Because the key stays server-side, this is safe to deploy publicly (e.g. Render, Railway, Fly.io, a VPS) without exposing your OpenAI key to visitors.
- Notes and roadmap progress are stored in flat JSON files under `data/` via `storage.js`, and are shared by anyone using the deployed app (there's no login system — this is built for one student's own instance, not multi-tenant use).

## A note on data persistence

`data/notes.json`, `data/progress.json`, and `data/tasks.json` live on the server's local disk. That's fine for local use or a VPS with a persistent volume, but **on Render's free tier the disk is ephemeral** — it resets on every redeploy or restart, which would wipe saved notes and roadmap progress. If you want that data to survive redeploys:
- Attach a [Render persistent disk](https://render.com/docs/disks) (paid) mounted at the `data/` path, or
- Swap `storage.js` for a real database (e.g. a free-tier Postgres or SQLite-on-a-volume) — the rest of the app doesn't need to change, since everything already goes through the small `getNotes` / `saveNotes` / `getProgress` / `saveProgress` interface in `storage.js`.

## Extending this later

The `.env` file is a natural place to add more configuration as this grows — for example:
- A different model per environment (`OPENAI_MODEL`)
- Rate limiting or auth settings
- A database URL if you add persistent chat history
- Alternate providers (Anthropic, etc.) if you want to switch or add options

Just add new keys to `.env.example` (with placeholder values) and `.env` (with real ones), then read them in `server.js` via `process.env.YOUR_KEY`.
