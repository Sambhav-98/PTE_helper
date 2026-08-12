const reference = require('./reference');

// Supported file extensions for uploaded sources.
const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.md'];

/**
 * Extracts plain text from an uploaded file buffer, based on its extension.
 * PDFs reuse the same in-memory parser as the personal reference material
 * feature; plain text and markdown files are just read as UTF-8.
 */
async function extractText(buffer, ext) {
  if (ext === '.pdf') {
    const pages = await reference.parsePdfBuffer(buffer);
    return pages.join('\n\n');
  }
  return buffer.toString('utf8');
}

/**
 * Splits text into chunks for keyword search, trying to break on a
 * paragraph or sentence boundary near the target size rather than
 * cutting mid-sentence, for slightly cleaner excerpts.
 */
function chunkText(text, chunkSize = 1500) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  let i = 0;

  while (i < clean.length) {
    let end = Math.min(i + chunkSize, clean.length);

    if (end < clean.length) {
      const window = clean.slice(i, end);
      const lastParagraph = window.lastIndexOf('\n\n');
      const lastSentence = window.lastIndexOf('. ');
      const breakPoint = Math.max(lastParagraph, lastSentence);
      if (breakPoint > chunkSize * 0.5) {
        end = i + breakPoint + 1;
      }
    }

    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push({ text: piece });
    i = end;
  }

  return chunks;
}

module.exports = { SUPPORTED_EXTENSIONS, extractText, chunkText };
