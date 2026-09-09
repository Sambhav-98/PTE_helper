const zlib = require('zlib');
const reference = require('./reference');

// Figure extraction is deliberately separate from reference.js's text
// parsing, and pins a different bundled build of pdf.js. The v1.10 build
// that pdf-parse uses for text decodes JPEG via the browser's Image
// object, which doesn't exist in Node and throws — and most real ebook
// figures are JPEG. v2.0.550 decodes JPEG in pure JS. Text extraction is
// left on the build it already works with rather than migrated.
const PDFJS_BUILD = './node_modules/pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js';

const ENABLED = (process.env.LIBRARY_FIGURES || 'on').toLowerCase() !== 'off';
// A page's figures are fetched only when a question actually lands on that
// page, and the whole attempt is abandoned if it takes too long — an
// answer that arrives without a diagram beats one that never arrives.
const TIMEOUT_MS = Number(process.env.LIBRARY_FIGURE_TIMEOUT_MS) || 25000;

// Vision tokens scale with pixels, so anything larger is downscaled first.
const MAX_DIMENSION = 1024;
// Below this, it's a logo, a rule, an icon or a bullet — not a figure
// worth spending tokens on.
const MIN_DIMENSION = 180;
const MAX_ASPECT = 8;
const MAX_IMAGES_PER_PAGE = 2;

// Encoded PNGs only — never the source PDF. A figure is a few KB where the
// book it came from is tens of MB, so this stays small while sparing a
// repeat Drive download when a student asks two questions about one page.
const cache = new Map();
const CACHE_LIMIT = 40;
// Two questions arriving together about the same book should trigger one
// download, not two.
const inFlight = new Map();

/* ---------------------------------------------------------
   PNG encoding — pdf.js hands back raw pixels, and a PNG is
   just a header plus zlib-deflated scanlines, so Node's own
   zlib covers this with no image library.
--------------------------------------------------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function encodePng(width, height, pixels, channels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = channels === 4 ? 6 : 2;     // colour type: RGBA or RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** Box-average downscale. Cheap, dependency-free, and good enough for a diagram. */
function downscale(pixels, width, height, channels, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return { pixels, width, height };

  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(outW * outH * channels);
  const xRatio = width / outW;
  const yRatio = height / outH;

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      for (let c = 0; c < channels; c++) {
        let sum = 0, count = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            sum += pixels[(sy * width + sx) * channels + c];
            count++;
          }
        }
        out[(y * outW + x) * channels + c] = count ? Math.round(sum / count) : 0;
      }
    }
  }
  return { pixels: out, width: outW, height: outH };
}

/* ---------------------------------------------------------
   Extraction
--------------------------------------------------------- */

/** Is this image plausibly a figure, rather than a logo, rule or icon? */
function looksLikeFigure(width, height) {
  if (!width || !height) return false;
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) return false;
  const aspect = Math.max(width, height) / Math.min(width, height);
  return aspect <= MAX_ASPECT;
}

/**
 * Pulls the figures off specific pages of an already-downloaded PDF.
 *
 * pdf.js parses pages lazily, so asking for pages 42 and 61 of a 443-page
 * book does not parse the other 441 — the download is the slow part, not
 * this.
 */
async function extractFromBuffer(buffer, pages) {
  const pdfjs = require(PDFJS_BUILD);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const results = [];

  for (const pageNum of pages) {
    if (pageNum < 1 || pageNum > doc.numPages) continue;
    let page;
    try {
      page = await doc.getPage(pageNum);
    } catch { continue; }

    let ops;
    try {
      ops = await page.getOperatorList();
    } catch { continue; }

    const names = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintJpegXObject) {
        const name = ops.argsArray[i][0];
        if (typeof name === 'string' && !names.includes(name)) names.push(name);
      }
    }

    const found = [];
    for (const name of names) {
      let obj = null;
      try {
        obj = await new Promise(resolve => {
          try { page.objs.get(name, resolve); } catch { resolve(null); }
        });
      } catch { obj = null; }
      if (!obj || !obj.data || !looksLikeFigure(obj.width, obj.height)) continue;

      // kind 2 = RGB_24BPP, 3 = RGBA_32BPP. Anything else (1bpp stencil
      // masks, mostly) is skipped rather than guessed at.
      const channels = obj.kind === 3 ? 4 : obj.kind === 2 ? 3 : 0;
      if (!channels || obj.data.length < obj.width * obj.height * channels) continue;

      found.push({ obj, channels, area: obj.width * obj.height });
    }

    // Biggest first: on a page with a chart and a decorative flourish, the
    // chart is the one worth the tokens.
    found.sort((a, b) => b.area - a.area);

    for (const { obj, channels } of found.slice(0, MAX_IMAGES_PER_PAGE)) {
      const scaled = downscale(Buffer.from(obj.data), obj.width, obj.height, channels, MAX_DIMENSION);
      results.push({
        page: pageNum,
        width: scaled.width,
        height: scaled.height,
        base64: encodePng(scaled.width, scaled.height, scaled.pixels, channels).toString('base64')
      });
    }
  }

  return results;
}

function cacheKey(bookId, page) { return `${bookId}:${page}`; }

function readCache(bookId, pages) {
  const hits = [];
  const misses = [];
  for (const page of pages) {
    const key = cacheKey(bookId, page);
    if (cache.has(key)) {
      // null is a real, useful answer: "this page has no figures". Caching
      // it stops a text-only page triggering a fresh download every time.
      const value = cache.get(key);
      if (value) hits.push(...value);
    } else {
      misses.push(page);
    }
  }
  return { hits, misses };
}

function writeCache(bookId, pages, found) {
  for (const page of pages) {
    const forPage = found.filter(f => f.page === page);
    cache.set(cacheKey(bookId, page), forPage.length ? forPage : null);
  }
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })
  ]);
}

/**
 * Returns the figures on the given pages of a library book, downloading the
 * PDF from Drive only if something is actually missing from the cache.
 *
 * The book's id is its Drive file id, so nothing extra needs storing to
 * find it again. The downloaded buffer is released as soon as extraction
 * finishes — only the small encoded PNGs are kept, which is what keeps
 * this affordable on a small instance.
 *
 * Never throws: a failure here should cost the student a diagram, not
 * their answer.
 */
async function getFigures(bookId, pages) {
  if (!ENABLED || !bookId || !pages || !pages.length) return [];
  const wanted = [...new Set(pages)].filter(p => Number.isInteger(p) && p > 0);
  if (!wanted.length) return [];

  const { hits, misses } = readCache(bookId, wanted);
  if (!misses.length) return hits;

  const key = `${bookId}:${misses.join(',')}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      let buffer = null;
      try {
        buffer = await reference.fetchGoogleDriveFile(bookId);
        const found = await extractFromBuffer(buffer, misses);
        writeCache(bookId, misses, found);
        return found;
      } finally {
        buffer = null; // release the big one immediately
        inFlight.delete(key);
      }
    })());
  }

  try {
    const fetched = await withTimeout(inFlight.get(key), TIMEOUT_MS, 'figure extraction timed out');
    return [...hits, ...fetched];
  } catch (err) {
    console.log(`Figures: skipped for book ${bookId} p.${misses.join(',')} — ${err.message}`);
    return hits;
  }
}

module.exports = {
  getFigures,
  isEnabled: () => ENABLED,
  // exported for testing
  extractFromBuffer,
  encodePng,
  downscale,
  looksLikeFigure
};
