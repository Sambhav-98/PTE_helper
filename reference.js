const fs = require('fs');

// A small stopword list keeps keyword search from matching on filler words.
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','of','to','and','in','on','for',
  'how','what','why','when','where','do','does','did','i','my','me','can','you','your','please',
  'should','with','this','that','it','as','at','by','from','or','but','if','so','not','no','yes',
  'give','tell','about','get','got','have','has','had','will','would','could','which','who','into'
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []);
}

function extractQueryTerms(query) {
  const terms = tokenize(query).filter(t => t.length > 2 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

/**
 * Parses an already-in-memory PDF buffer into an array of per-page plain
 * text. Used by both the local-file path and the Google Drive path below,
 * so neither one needs to write anything to disk first.
 */
async function parsePdfBuffer(buffer) {
  const pdfParse = require('pdf-parse');
  const pages = [];

  function pagerender(pageData) {
    return pageData.getTextContent().then(tc => {
      const text = tc.items.map(item => item.str).join(' ');
      pages.push(text);
      return text;
    });
  }

  await pdfParse(buffer, { pagerender });
  return pages;
}

/**
 * Reads a PDF from local disk and returns an array of per-page plain text.
 * The PDF itself is never written anywhere else — this only reads it
 * into memory long enough to build a searchable index.
 */
async function parsePdfPages(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parsePdfBuffer(buffer);
}

/**
 * Pulls a Google Drive file ID out of a full share link, a "uc?id=" link,
 * or a bare ID typed in directly.
 */
function extractDriveFileId(input) {
  const trimmed = (input || '').trim();
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]{10,})/,   // .../file/d/FILE_ID/view
    /[?&]id=([a-zA-Z0-9_-]{10,})/  // .../uc?id=FILE_ID
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Fetches a Google Drive file's bytes into memory, given its file ID.
 * The file must be shared as "Anyone with the link" (this makes an
 * unauthenticated request — there's no Google login involved).
 *
 * Small files download directly. Files over roughly 25MB get an HTML
 * "Google can't scan this file for viruses" interstitial instead of the
 * file itself, so this also handles that case by extracting the one-time
 * confirm token embedded in that page's hidden form and re-requesting.
 *
 * This depends on the current structure of Google's warning page, which
 * is not a documented/stable API — if Google changes that page's markup,
 * this will need updating.
 */
async function fetchGoogleDriveFile(fileId) {
  const initialUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  let res = await fetch(initialUrl, { redirect: 'follow' });

  if (!res.ok) {
    throw new Error(`Google Drive returned HTTP ${res.status} — check that the file is shared as "Anyone with the link."`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    // Small file — Drive served the bytes directly.
    return Buffer.from(await res.arrayBuffer());
  }

  // Large file — Drive returned the virus-scan warning page. Extract the
  // hidden form fields (id, confirm token, uuid, etc.) and resubmit them.
  const html = await res.text();
  const cookie = res.headers.get('set-cookie') || '';

  const actionMatch = html.match(/id="download-form"\s+action="([^"]+)"/);
  const action = actionMatch ? actionMatch[1] : 'https://drive.usercontent.google.com/download';

  const inputs = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)];
  if (!inputs.length) {
    throw new Error('Google Drive returned an unexpected page instead of the file. Double-check the file ID and that sharing is set to "Anyone with the link."');
  }

  const params = new URLSearchParams();
  for (const [, name, value] of inputs) params.set(name, value);

  res = await fetch(`${action}?${params.toString()}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'follow'
  });

  const finalType = res.headers.get('content-type') || '';
  if (!res.ok || finalType.includes('text/html')) {
    throw new Error('Google Drive still returned a page instead of the file — sharing permissions may be wrong, or Google changed its download flow.');
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Turns raw per-page text into { page, text } chunks, skipping blank pages. */
function buildChunks(pages) {
  const chunks = [];
  pages.forEach((text, idx) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) chunks.push({ page: idx + 1, text: clean });
  });
  return chunks;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Very small keyword-overlap search — no external services, no embeddings.
 * Matches on whole words only (not raw substrings), since a spurious
 * partial-word hit would otherwise surface as a visible "Personal
 * reference" citation in the UI even when it's not actually relevant.
 * Returns the top few chunks that share the most distinct query terms.
 */
function searchChunks(query, chunks, topK = 3) {
  const queryTerms = extractQueryTerms(query);
  if (!queryTerms.length || !chunks.length) return [];

  const termRegexes = queryTerms.map(term => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'));

  const scored = chunks
    .map(c => {
      let score = 0;
      for (const re of termRegexes) {
        if (re.test(c.text)) score += 1;
      }
      return { ...c, score };
    })
    .filter(c => c.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Builds a short, hard-capped excerpt block from matched chunks.
 * maxChars caps the TOTAL excerpt content returned for a single question —
 * this is what keeps the feature to "a couple of short paragraphs for
 * context" rather than ever approaching bulk reproduction of the source.
 */
function buildExcerptBlock(matches, maxChars = 900) {
  let used = 0;
  const parts = [];
  for (const m of matches) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    let text = m.text;
    if (text.length > remaining) text = text.slice(0, remaining).trim() + '…';
    parts.push(`[Reference, p.${m.page}] ${text}`);
    used += text.length;
  }
  return parts.join('\n\n');
}

module.exports = {
  parsePdfPages,
  parsePdfBuffer,
  buildChunks,
  searchChunks,
  buildExcerptBlock,
  extractDriveFileId,
  fetchGoogleDriveFile
};
