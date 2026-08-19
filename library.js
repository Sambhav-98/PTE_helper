const reference = require('./reference');

// The Library is configured entirely via the LIBRARY_BOOKS env var — a JSON
// array of { title, driveUrl }. Nothing is ever written to local disk, so
// this works on hosting tiers with an ephemeral filesystem (e.g. Render's
// free plan): every server start re-fetches each PDF from Google Drive into
// memory and rebuilds the search index, exactly like reference.js already
// does for the single Personal Reference PDF.
//
// To add/remove a book: edit LIBRARY_BOOKS in your host's env var settings
// and redeploy/restart. There is no in-app upload — nothing else has a
// durable place to persist a runtime change on a free-tier host.

// In-memory only: [{ id, title, pageCount, chunks: [{page, text, bookId, bookTitle}] }]
let books = [];
let lastInitError = null;
// True from the moment init() starts until every configured book has been
// attempted. The server starts accepting requests before this finishes
// (large PDFs take real time to fetch + parse), so callers can use this to
// show "still loading" instead of mistaking an in-progress load for a
// failure.
let isLoading = false;

function parseConfig() {
  const raw = process.env.LIBRARY_BOOKS;
  if (!raw || !raw.trim()) return [];
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LIBRARY_BOOKS is not valid JSON — ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error('LIBRARY_BOOKS must be a JSON array.');
  return entries
    .map((e, i) => ({ title: (e && e.title && String(e.title).trim()) || `Untitled ebook ${i + 1}`, driveUrl: e && e.driveUrl }))
    .filter(e => e.driveUrl);
}

// Books larger than this are skipped with a clear log message rather than
// risking an OOM crash mid-parse — especially important on free-tier hosts
// with a small RAM ceiling (e.g. Render's 512MB), where a single
// image-heavy PDF can spike memory well past its own file size during
// parsing. Override with LIBRARY_MAX_FILE_MB if your host has more RAM.
const MAX_FILE_MB = Number(process.env.LIBRARY_MAX_FILE_MB) || 120;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

/**
 * Fetches every configured book from Google Drive and rebuilds the
 * in-memory chunk index. Called once at server startup. A single book
 * failing to load (bad link, sharing not set to "Anyone with the link",
 * Drive's download-flow page changing, or exceeding the size guardrail) is
 * logged and skipped rather than taking down the whole app.
 */
async function init() {
  books = [];
  lastInitError = null;
  isLoading = true;

  try {
    let configured;
    try {
      configured = parseConfig();
    } catch (err) {
      lastInitError = err.message;
      console.log(`Library: ${err.message}`);
      return;
    }

    if (!configured.length) {
      console.log('Library: no books configured (LIBRARY_BOOKS is empty or unset).');
      return;
    }

    for (const { title, driveUrl } of configured) {
      let buffer = null;
      try {
        const fileId = reference.extractDriveFileId(driveUrl);
        if (!fileId) throw new Error('could not extract a Google Drive file ID from the link.');
        buffer = await reference.fetchGoogleDriveFile(fileId);
        if (buffer.length > MAX_FILE_BYTES) {
          const mb = (buffer.length / (1024 * 1024)).toFixed(1);
          throw new Error(`file is ${mb}MB, over the ${MAX_FILE_MB}MB limit — compress it (downsample images) or raise LIBRARY_MAX_FILE_MB if your host has enough RAM.`);
        }
        const pages = await reference.parsePdfBuffer(buffer);
        const rawChunks = reference.buildChunks(pages);
        const bookId = fileId;
        const chunks = rawChunks.map(c => ({ ...c, bookId, bookTitle: title }));
        books.push({ id: bookId, title, pageCount: pages.length, chunks });
        console.log(`Library: loaded "${title}" — ${pages.length} pages.`);
      } catch (err) {
        console.log(`Library: failed to load "${title}" — ${err.message}`);
      } finally {
        buffer = null; // let it be GC'd before the next book starts parsing
      }
    }

    console.log(`Library: ready — ${books.length}/${configured.length} book(s) loaded, ${totalChunks()} chunks indexed in memory.`);
  } finally {
    isLoading = false;
  }
}

function totalChunks() {
  return books.reduce((sum, b) => sum + b.chunks.length, 0);
}

function listBooks() {
  return books.map(b => ({ id: b.id, title: b.title, pageCount: b.pageCount }));
}

function isEmpty() {
  return books.length === 0;
}

function allChunks() {
  return books.flatMap(b => b.chunks);
}

function configuredCount() {
  try {
    return parseConfig().length;
  } catch {
    return 0;
  }
}

/**
 * Keyword search across every book's chunks at once, reusing the same
 * search that already powers the personal-reference feature. This is the
 * "chunking" layer that keeps the app cheap: no matter how many ebooks are
 * configured, each chat/generate call only ever sends a handful of
 * matched, capped excerpts to the model — never the whole library.
 */
function search(query, topK = 5) {
  return reference.searchChunks(query, allChunks(), topK);
}

/** Same capped-excerpt idea as reference.js, labeled per-book instead of generic "Reference". */
function buildExcerptBlock(matches, maxChars = 3500) {
  let used = 0;
  const parts = [];
  for (const m of matches) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    let text = m.text;
    if (text.length > remaining) text = text.slice(0, remaining).trim() + '…';
    parts.push(`[${m.bookTitle}, p.${m.page}] ${text}`);
    used += text.length;
  }
  return parts.join('\n\n');
}

module.exports = {
  init,
  listBooks,
  isEmpty,
  search,
  buildExcerptBlock,
  configuredCount,
  isLoading: () => isLoading,
  getLastInitError: () => lastInitError
};
