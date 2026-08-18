const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const reference = require('./reference');

// Uploaded PDFs live on disk under data/library-files (same "data/" dir the
// app already gitignores and uses for notes/tasks/etc). Only a manifest
// (id, title, filename, page count, upload date) is persisted separately —
// the actual searchable chunk index is rebuilt into memory from the PDFs
// on every server start, exactly like reference.js already does for the
// single personal-reference PDF.
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'library-files');
const MANIFEST_FILE = path.join(DATA_DIR, 'library.json');

// In-memory only: [{ id, title, pageCount, uploadedAt, chunks: [{page, text, bookId, bookTitle}] }]
let books = [];

async function ensureDirs() {
  await fs.mkdir(FILES_DIR, { recursive: true });
}

async function readManifest() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(MANIFEST_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeManifest(entries) {
  await ensureDirs();
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(entries, null, 2));
}

function titleFromFilename(originalName) {
  return String(originalName || 'Untitled ebook')
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled ebook';
}

/**
 * Rebuilds the in-memory chunk index from whatever's on disk. Called once
 * at server startup. Any manifest entry whose file is missing (e.g. the
 * disk was wiped on a free hosting tier without a persistent volume) is
 * silently dropped rather than crashing the app.
 */
async function init() {
  const manifest = await readManifest();
  const survivors = [];
  books = [];

  for (const entry of manifest) {
    try {
      const filePath = path.join(FILES_DIR, entry.filename);
      const buffer = await fs.readFile(filePath);
      const pages = await reference.parsePdfBuffer(buffer);
      const rawChunks = reference.buildChunks(pages);
      const chunks = rawChunks.map(c => ({ ...c, bookId: entry.id, bookTitle: entry.title }));
      books.push({
        id: entry.id,
        title: entry.title,
        pageCount: pages.length,
        uploadedAt: entry.uploadedAt,
        chunks
      });
      survivors.push(entry);
    } catch (err) {
      console.log(`Library: skipping "${entry.title}" — ${err.message}`);
    }
  }

  if (survivors.length !== manifest.length) await writeManifest(survivors);
  console.log(`Library: ready — ${books.length} ebook(s), ${totalChunks()} chunks indexed in memory.`);
}

function totalChunks() {
  return books.reduce((sum, b) => sum + b.chunks.length, 0);
}

/** Parses and stores a newly uploaded PDF. Returns its public summary. */
async function addBook(buffer, originalName) {
  await ensureDirs();
  const id = crypto.randomUUID();
  const title = titleFromFilename(originalName);
  const filename = `${id}.pdf`;

  // Parse first — if the PDF is corrupt/unreadable, fail before writing
  // anything to disk or touching the manifest.
  const pages = await reference.parsePdfBuffer(buffer);
  const rawChunks = reference.buildChunks(pages);
  if (!rawChunks.length) {
    throw new Error('No extractable text found in this PDF (it may be scanned images without OCR).');
  }

  await fs.writeFile(path.join(FILES_DIR, filename), buffer);

  const entry = { id, title, filename, uploadedAt: new Date().toISOString() };
  const manifest = await readManifest();
  manifest.push(entry);
  await writeManifest(manifest);

  const chunks = rawChunks.map(c => ({ ...c, bookId: id, bookTitle: title }));
  const book = { id, title, pageCount: pages.length, uploadedAt: entry.uploadedAt, chunks };
  books.push(book);

  return { id, title, pageCount: pages.length, uploadedAt: entry.uploadedAt };
}

async function removeBook(id) {
  const manifest = await readManifest();
  const entry = manifest.find(e => e.id === id);
  if (!entry) return false;

  try {
    await fs.unlink(path.join(FILES_DIR, entry.filename));
  } catch {
    // File already gone — fine, still remove it from the manifest/index below.
  }

  await writeManifest(manifest.filter(e => e.id !== id));
  books = books.filter(b => b.id !== id);
  return true;
}

function listBooks() {
  return books
    .map(b => ({ id: b.id, title: b.title, pageCount: b.pageCount, uploadedAt: b.uploadedAt }))
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

function isEmpty() {
  return books.length === 0;
}

function allChunks() {
  return books.flatMap(b => b.chunks);
}

/**
 * Keyword search across every book's chunks at once, reusing the same
 * search that already powers the personal-reference feature. This is the
 * "chunking" layer the app relies on to stay cheap: no matter how many
 * ebooks are in the library, each chat/generate call only ever sends a
 * handful of matched, capped excerpts to the model — never the whole
 * library — which keeps API traffic and token cost flat as the library
 * grows instead of scaling with its size.
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
  addBook,
  removeBook,
  listBooks,
  isEmpty,
  search,
  buildExcerptBlock
};
