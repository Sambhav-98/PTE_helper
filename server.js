require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SOURCES } = require('./knowledge');
const { ROADMAP } = require('./roadmap');
const storage = require('./storage');
const reference = require('./reference');
const library = require('./library');
const figures = require('./figures');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const REFERENCE_PDF_PATH = process.env.REFERENCE_PDF_PATH;
const REFERENCE_PDF_DRIVE_URL = process.env.REFERENCE_PDF_DRIVE_URL;

// Holds the parsed reference index in memory once loaded. Stays empty if
// nothing is configured, or if loading fails — the app works fine either
// way.
let referenceChunks = [];
let referencePageCount = 0;
let referenceReady = false;
let referenceSource = null; // 'local' | 'gdrive' | null

app.use(express.json());

// Serve only index.html — not the whole project directory — so files like
// server.js, knowledge.js, and .env are never reachable over HTTP.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * Loads a personal reference PDF, if configured. Two sources are supported,
 * tried in this order:
 *   1. REFERENCE_PDF_PATH — a local file. Best when the server has real
 *      persistent storage (your own VPS, or a Render paid instance with a
 *      persistent disk attached).
 *   2. REFERENCE_PDF_DRIVE_URL — a Google Drive share link or file ID.
 *      Fetched fresh into memory on every start. Works on free hosting
 *      tiers with no persistent disk at all (e.g. Render's free plan),
 *      since nothing needs to survive a restart.
 *
 * Either way, nothing derived from the PDF is ever written to disk —
 * it's parsed into memory and stays only in this running process. If
 * neither is configured (or loading fails), this silently no-ops and the
 * app runs exactly as it did before.
 */
async function initReference() {
  try {
    let pages;

    if (REFERENCE_PDF_PATH && fs.existsSync(REFERENCE_PDF_PATH)) {
      console.log('Reference material: parsing local PDF (in memory only)...');
      pages = await reference.parsePdfPages(REFERENCE_PDF_PATH);
      referenceSource = 'local';
    } else if (REFERENCE_PDF_DRIVE_URL) {
      const fileId = reference.extractDriveFileId(REFERENCE_PDF_DRIVE_URL);
      if (!fileId) {
        console.log('Reference material: could not extract a file ID from REFERENCE_PDF_DRIVE_URL.');
        return;
      }
      console.log('Reference material: fetching PDF from Google Drive (in memory only)...');
      const buffer = await reference.fetchGoogleDriveFile(fileId);
      pages = await reference.parsePdfBuffer(buffer);
      referenceSource = 'gdrive';
    } else {
      if (REFERENCE_PDF_PATH) {
        console.log(`Reference material: REFERENCE_PDF_PATH is set but no file was found at ${REFERENCE_PDF_PATH}`);
      }
      return;
    }

    referenceChunks = reference.buildChunks(pages);
    referencePageCount = pages.length;
    referenceReady = true;
    console.log(`Reference material: ready — ${pages.length} pages indexed in memory (source: ${referenceSource}).`);
  } catch (err) {
    console.log(`Reference material: failed to load — ${err.message}`);
  }
}

/**
 * Builds the chat system prompt. The uploaded Library (see library.js) is
 * the primary knowledge source whenever it has anything relevant to the
 * current question — libraryExcerpt is a handful of matched, capped chunks,
 * never the whole library, which is what keeps this cheap regardless of how
 * many ebooks get uploaded. The built-in handbook (knowledge.js) is always
 * included too, but framed as a fallback/supplement so the model reaches
 * for it only when the library doesn't cover something.
 */
function buildSystemPrompt(libraryExcerpt) {
  const kb = SOURCES.map(s => `## ${s.title}\n${s.content.trim()}`).join('\n\n');
  const hasLibrary = Boolean(libraryExcerpt);

  const librarySection = hasLibrary
    ? `LIBRARY MATERIAL (primary source — excerpts from your institution's own uploaded ebooks, matched to the student's question):\n${libraryExcerpt}\n\n`
    : '';
  const handbookLabel = hasLibrary
    ? 'SUPPLEMENTARY HANDBOOK CONTENT (fall back to this only for anything the Library material above doesn\'t cover):'
    : 'HANDBOOK CONTENT:';

  return `You are the study assistant embedded in "PTE Prep Hub." Answer the user's questions using ONLY the material provided below${hasLibrary ? ', prioritizing the Library material as the primary source' : ''}.

Rules:
- Ground every answer in the material below. Do not invent facts, numbers, or templates that aren't in it.
- If the answer isn't covered below, say so plainly and suggest the closest related topic instead of guessing.
- Be concise, practical, and exam-focused — this is for a student actively preparing for the PTE Academic test.
- When helpful, format with short paragraphs or bullet points (use "- " for bullets, "**text**" for bold). Don't use headers.
- When you draw from a specific handbook section, you can mention its name naturally (e.g. "As covered in Read Aloud...").
- When you draw from Library material, paraphrase it in your own words rather than quoting it at length.

${librarySection}${handbookLabel}
${kb}`;
}

// Lets the frontend show a simple "connected / not connected" indicator
// without ever exposing the key itself.
app.get('/api/health', (req, res) => {
  res.json({ connected: Boolean(OPENAI_API_KEY), model: MODEL });
});

/**
 * Builds grounding material for practice-test generation. This draws from
 * the Library (the institution's own uploaded ebooks) ONLY — the built-in
 * handbook in knowledge.js is deliberately not used here, so practice
 * material always reflects what the students are actually studying from.
 *
 * Three cases, all capped the same way chat is so cost stays flat:
 *   - a book + a topic  → keyword search inside that one book
 *   - a book, no topic  → an evenly-spaced sample from across that book
 *   - a topic, no book  → keyword search across the whole library
 *
 * Returns `contextText: ''` when the Library has nothing to offer; callers
 * turn that into a clear message rather than silently generating from
 * somewhere else.
 */
function buildStudyContext(bookId, topic, useReference) {
  const query = (topic || '').trim();
  let matches = [];

  if (!library.isEmpty()) {
    if (bookId && query) {
      matches = library.searchVaried(query, 5, bookId);
      // Nothing in that book on that topic — fall back to a spread of the
      // book itself rather than jumping to a different source entirely.
      if (!matches.length) matches = library.sampleChunks(bookId, 4);
    } else if (bookId) {
      matches = library.sampleChunks(bookId, 4);
    } else if (query) {
      matches = library.searchVaried(query, 5);
      if (!matches.length) matches = library.sampleChunks(null, 4);
    }
  }

  const { block: contextText, sources } = matches.length
    ? library.buildLabelledExcerpts(matches, 3500)
    : { block: '', sources: [] };

  let refBlock = '';
  if (useReference && referenceReady && referenceChunks.length && query) {
    const refMatches = reference.searchChunks(query, referenceChunks, 2);
    if (refMatches.length) refBlock = reference.buildExcerptBlock(refMatches, 700);
  }

  return { contextText, refBlock, sources };
}

/**
 * Shared guard for both generate endpoints: the Library is the only source
 * for practice material now, so a missing/empty/still-loading library is an
 * explicit, explainable state rather than a silent fallback. Returns an
 * error string, or null when it's fine to proceed.
 */
function libraryUnavailableReason() {
  if (library.isLoading()) {
    return 'Your Library is still loading — give it a moment and try again.';
  }
  if (library.isEmpty()) {
    return 'Practice sets are generated from your Library, which is currently empty. Add ebooks via LIBRARY_BOOKS on the server, then try again.';
  }
  return null;
}

/**
 * Keeps only questions the UI can actually render. A question with three
 * options, a missing stem, or an answerIndex pointing past the end of the
 * list would otherwise crash the review screen when it tries to display
 * the correct answer — better to drop one bad question than break the
 * whole test.
 */
function validQuestions(questions) {
  return questions.filter(q =>
    q &&
    typeof q.question === 'string' && q.question.trim() &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every(o => typeof o === 'string' && o.trim()) &&
    Number.isInteger(q.answerIndex) &&
    q.answerIndex >= 0 && q.answerIndex < q.options.length
  );
}

/**
 * Resolves each question's `sourceId` into a real citation the UI can show:
 * book title, page number, and the passage the question came from.
 *
 * The id comes back from the model, so it can be missing or made up. An
 * unrecognised id is dropped rather than guessed at — a question with no
 * citation is fine, but a citation pointing at the wrong page would send a
 * student to read something that doesn't answer their mistake. Where the
 * whole test came from a single excerpt, that one is used as the fallback.
 */
function attachSources(questions, sources) {
  const byId = new Map(sources.map(src => [src.id, src]));
  const only = sources.length === 1 ? sources[0] : null;

  return questions.map(q => {
    const match = byId.get(String(q.sourceId || '').trim()) || only || null;
    const { sourceId, ...rest } = q;
    if (!match) return rest;
    return {
      ...rest,
      source: {
        book: match.book,
        page: match.page,
        // Trimmed for display — the point is enough context to recognise
        // the passage, not to reproduce a page of the book in the UI.
        excerpt: match.text.length > 400 ? match.text.slice(0, 400).trim() + '…' : match.text
      }
    };
  });
}

/**
 * Shuffles each question's options and rewrites answerIndex to match.
 *
 * Language models overwhelmingly place the correct answer first, so
 * without this the answer is option A most of the time and the quiz
 * becomes guessable without reading the material. Questions the model
 * returned in an unexpected shape are passed through untouched.
 */
function shuffleQuizOptions(questions) {
  return questions.map(q => {
    if (!Array.isArray(q.options) || q.options.length < 2) return q;
    if (typeof q.answerIndex !== 'number' || !q.options[q.answerIndex]) return q;

    const correct = q.options[q.answerIndex];
    const options = [...q.options];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { ...q, options, answerIndex: options.indexOf(correct) };
  });
}

/**
 * Turns a list of already-seen question texts into a prompt block telling
 * the model not to reuse them. Material variation alone isn't quite
 * enough — overlapping excerpts still tempt the model back to the same
 * few obvious questions — so recent ones are named explicitly.
 */
function buildAvoidBlock(avoid) {
  if (!Array.isArray(avoid)) return '';
  const recent = avoid
    .filter(q => typeof q === 'string' && q.trim())
    .slice(0, 20)
    .map(q => `- ${q.trim().slice(0, 200)}`);
  if (!recent.length) return '';
  return `\n\nThe student has already been asked the following. Do NOT repeat any of them, and do NOT ask a lightly reworded version of them — cover different points from the material instead:\n${recent.join('\n')}`;
}

/**
 * Calls OpenAI with a system+user prompt and parses the reply as JSON.
 * Used by practice-test generation, which needs structured output rather
 * than free-form chat text.
 */
/**
 * Pulls a JSON value out of a model reply that may be wrapped in prose or
 * code fences. Tries the whole string first, then falls back to the
 * outermost {...} or [...] in it.
 */
function extractJson(raw) {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to substring extraction */ }

  const candidates = [];
  const firstObj = cleaned.indexOf('{'), lastObj = cleaned.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(cleaned.slice(firstObj, lastObj + 1));
  const firstArr = cleaned.indexOf('['), lastArr = cleaned.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(cleaned.slice(firstArr, lastArr + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch { /* try the next shape */ }
  }
  return null;
}

/**
 * Normalises whatever came back into an array. JSON mode requires an object
 * at the root, so the model returns { questions: [...] }, but a bare array
 * or a differently-named single array property are both accepted rather
 * than thrown away over a wrapper key.
 */
function toArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.questions)) return parsed.questions;
    const arrays = Object.values(parsed).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return null;
}

async function callOpenAI(systemPrompt, userPrompt, { temperature, jsonMode }) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    // Long explanations across 10 questions can run past a short default
    // and a truncated reply is, by definition, broken JSON.
    max_tokens: 4000
  };
  // JSON mode makes the API itself guarantee syntactically valid output,
  // which is what actually fixes "the model returned something that wasn't
  // valid JSON" rather than just retrying and hoping.
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/**
 * Calls OpenAI and returns a parsed array. Used by practice-test
 * generation, which needs structured output rather than free-form text.
 *
 * Three layers of defence, because a failed parse is a dead end the
 * student sees as a red error box:
 *   1. JSON mode, so the API guarantees well-formed output.
 *   2. A tolerant parser, for models that still wrap it in prose.
 *   3. One automatic retry at a lower temperature before giving up.
 *
 * Falls back to a plain call if the configured model doesn't support
 * response_format, so setting OPENAI_MODEL to an older model still works.
 */
async function generateStructuredContent(systemPrompt, userPrompt) {
  let jsonMode = true;
  let lastProblem = 'the model returned something that wasn\'t valid JSON';

  for (let attempt = 0; attempt < 2; attempt++) {
    // Lower on the retry: high temperature is what breaks structure in the
    // first place, and variety already comes from the material selection.
    const temperature = attempt === 0 ? 0.9 : 0.4;
    const { ok, status, data } = await callOpenAI(systemPrompt, userPrompt, { temperature, jsonMode });

    if (!ok) {
      const message = (data && data.error && data.error.message) || `OpenAI request failed (${status})`;
      // Older models reject response_format — drop it and retry once.
      if (jsonMode && /response_format/i.test(message)) {
        jsonMode = false;
        attempt--;
        continue;
      }
      throw new Error(message);
    }

    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
      lastProblem = 'the reply was cut off before it finished — try fewer questions';
      continue;
    }

    const raw = choice?.message?.content || '';
    const list = toArray(extractJson(raw));
    if (list && list.length) return list;

    // Nothing usable came back. Log what actually arrived — without this
    // there's no way to tell a chatty preamble from a refusal from an
    // empty reply, since the student only ever sees the red error box.
    console.log(`Practice test: unusable reply on attempt ${attempt + 1} (jsonMode=${jsonMode}, finish_reason=${choice?.finish_reason}, ${raw.length} chars):`);
    console.log(raw.slice(0, 600) || '  (empty response)');
  }

  throw new Error(`${lastProblem} — please try again.`);
}

// Exposes just the section titles for the Sources panel.
app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({ title: s.title, content: s.content })));
});

// Lets the frontend show whether a personal reference PDF is connected,
// without exposing its path, filename, or any of its content.
app.get('/api/reference-status', (req, res) => {
  res.json({ available: referenceReady, pages: referencePageCount, source: referenceSource });
});

// ---- Library (Google-Drive-backed ebooks — the primary knowledge source) ----
// Configured via LIBRARY_BOOKS (see README) — read-only from the app's
// perspective; there's no in-app upload/delete since nothing on a free-tier
// host would durably persist that kind of runtime change.

app.get('/api/library', (req, res) => {
  res.json({
    books: library.listBooks(),
    configuredCount: library.configuredCount(),
    loading: library.isLoading(),
    error: library.getLastInitError()
  });
});

/**
 * Decides which pages, if any, are worth pulling figures from.
 *
 * Only the top matches count, and only from a single book: a cache miss
 * means downloading that book from Drive, so spreading across every
 * loosely-related page would turn one question into several downloads.
 * Returns null when there's nothing worth trying.
 */
const MAX_FIGURE_PAGES = 2;

// Whether a figure would actually help is a judgement call, and making it
// badly is expensive in both directions: attach one every time and the
// student stops looking at them (and every message pays vision tokens),
// attach none and the diagrams in their books never get used.
//
// Two independent signals, either of which is enough:
//
//   1. The student asked for something visual. "Show me an example",
//      "what does the template look like" — the request itself is the ask.
//   2. The matched passage refers to a figure of its own. Text that says
//      "as shown in the chart below" is incomplete without the chart, so
//      the page is one where the figure carries real meaning.
//
// Neither present means the question is answerable in prose, and nothing
// is fetched at all — no download, no vision tokens, no image.
const VISUAL_REQUEST = /\b(image|picture|photo|diagram|chart|graph|figure|infographic|illustration|screenshot|visual(?:ly|ise|ize)?|look(?:s)? like|show me|show us|see it|draw)\b/i;
const PASSAGE_CITES_FIGURE = /\b(figure|fig\.|chart|graph|diagram|infographic|illustration|shown below|shown above|see below|see above|as shown|pictured|table \d)\b/i;

/**
 * Decides whether any figure is worth fetching for this question, and if
 * so from which pages.
 *
 * Only the top matches count, and only from a single book: a cache miss
 * means downloading that book from Drive, so spreading across every
 * loosely-related page would turn one question into several downloads.
 * Returns null when there's nothing worth trying.
 */
function figuresForTopMatches(matches, question) {
  if (!figures.isEnabled() || !matches || !matches.length) return null;

  // Anchor on the single best match's book so we only ever touch one PDF.
  const bookId = matches[0].bookId;
  const bookTitle = matches[0].bookTitle;
  if (!bookId) return null;

  const asked = VISUAL_REQUEST.test(String(question || ''));

  const pages = [];
  for (const m of matches) {
    if (m.bookId !== bookId) continue;
    // When the student didn't ask for anything visual, only pages whose own
    // text leans on a figure qualify.
    if (!asked && !PASSAGE_CITES_FIGURE.test(m.text || '')) continue;
    if (!pages.includes(m.page)) pages.push(m.page);
    if (pages.length >= MAX_FIGURE_PAGES) break;
  }
  if (!pages.length) return null;

  return { bookId, bookTitle, pages, reason: asked ? 'asked' : 'passage' };
}

/**
 * Last check, after the answer comes back: did the model actually make use
 * of the figures it was given?
 *
 * The prompt tells it to ignore an unhelpful figure silently, so a reply
 * that never mentions one is a reply the figure didn't contribute to —
 * and showing it anyway is exactly the noise that trains students to stop
 * looking. Cheap to run and it costs nothing but a discarded image.
 */
const REPLY_USES_FIGURE = /\b(figure|fig\.|chart|graph|diagram|infographic|illustration|image|table|shown|pictured|above|below)\b/i;

function replyUsedFigures(reply) {
  return REPLY_USES_FIGURE.test(String(reply || ''));
}

/**
 * Attaches figures to the student's most recent message as image parts,
 * which is how the chat completions API takes images.
 *
 * The images ride along with the question rather than the system prompt so
 * the model treats them as part of what's being asked about. Only the last
 * user turn is touched; the rest of the conversation is passed through
 * untouched.
 */
function attachMessageImages(messages, attached, bookTitle) {
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  if (lastUserIdx === -1) return messages;

  const original = messages[lastUserIdx];
  const parts = [{ type: 'text', text: String(original.content || '') }];

  for (const fig of attached) {
    parts.push({ type: 'text', text: `Figure from ${bookTitle}, page ${fig.page}:` });
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${fig.base64}`, detail: 'auto' }
    });
  }

  const copy = [...messages];
  copy[lastUserIdx] = { role: 'user', content: parts };
  return copy;
}

/** Position of a figure among the others on its own page. */
function indexOnPage(list, i) {
  return list.slice(0, i).filter(f => f.page === list[i].page).length;
}

// Serves a single figure as a PNG. Same cache and extraction path the chat
// endpoint uses, so showing the student a figure the model just read is
// normally free — nothing is downloaded again.
app.get('/api/library/figure', async (req, res) => {
  const bookId = String(req.query.book || '');
  const page = Number(req.query.page);
  const index = Number(req.query.i) || 0;

  if (!bookId || !Number.isInteger(page) || page < 1) {
    return res.status(400).json({ error: 'book and page are required.' });
  }
  if (!library.getBook(bookId)) {
    return res.status(404).json({ error: 'Unknown book.' });
  }

  try {
    const png = await figures.getFigureImage(bookId, page, index);
    if (!png) return res.status(404).json({ error: 'No such figure.' });
    res.set('Content-Type', 'image/png');
    // Figures are immutable for the life of a given book, so let the
    // browser keep them rather than re-requesting on every scroll.
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: `Could not load figure: ${err.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'The server has no OPENAI_API_KEY configured. Add one to your .env file and restart the server.'
    });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');

  // Library first: search across every uploaded ebook for chunks relevant
  // to the student's latest message. Only the matched, capped excerpts are
  // sent — never the full library — so cost/latency stay flat as more
  // ebooks get uploaded.
  let libraryExcerpt = '';
  let libraryItemsUsed = [];
  let topMatches = [];
  if (!library.isEmpty() && lastUserMessage && lastUserMessage.content) {
    const libMatches = library.search(lastUserMessage.content, 5);
    if (libMatches.length) {
      libraryExcerpt = library.buildExcerptBlock(libMatches, 4000);
      libraryItemsUsed = libMatches.map(m => ({ book: m.bookTitle, page: m.page }));
      topMatches = libMatches;
    }
  }

  let systemContent = buildSystemPrompt(libraryExcerpt);
  let referencePagesUsed = [];

  // If a personal reference PDF is loaded, pull a couple of short, capped
  // excerpts relevant to the student's latest message — never the whole
  // document. This keeps the reference material as light supporting
  // context rather than something that gets bulk-reproduced.
  if (referenceReady && referenceChunks.length) {
    if (lastUserMessage && lastUserMessage.content) {
      const matches = reference.searchChunks(lastUserMessage.content, referenceChunks, 3);
      if (matches.length) {
        referencePagesUsed = matches.map(m => m.page);
        const excerpt = reference.buildExcerptBlock(matches, 950);
        systemContent += `\n\nADDITIONAL PERSONAL REFERENCE MATERIAL (from a practice-test book the student personally owns — separate from the handbook above). These are short, capped excerpts included only for extra context on this specific question:\n\n${excerpt}\n\nWhen drawing on this material: paraphrase it in your own words rather than quoting it at length, refer to it generically as "your reference material" (not by title or publisher), and never reproduce more of it than what's shown above.`;
      }
    }
  }

  // If the best-matching passages sit on pages that carry a diagram, pull
  // those figures out of the source PDF and hand them to the model, so an
  // explanation of a scoring chart can actually describe the chart rather
  // than only the prose around it. Restricted to the top couple of pages:
  // this costs a Drive download on a cache miss, and vision tokens on
  // every hit, so it is not worth doing for every loosely-related page.
  const figurePages = figuresForTopMatches(topMatches, lastUserMessage && lastUserMessage.content);
  let attachedFigures = [];
  if (figurePages) {
    attachedFigures = await figures.getFigures(figurePages.bookId, figurePages.pages);
  }

  const outboundMessages = attachedFigures.length
    ? attachMessageImages(messages, attachedFigures, figurePages.bookTitle)
    : messages;

  if (attachedFigures.length) {
    systemContent += `\n\nOne or more figures from ${figurePages.bookTitle} are attached to the student's message — images of diagrams, charts or tables from the pages your Library excerpts came from. The student can see these figures displayed alongside your reply, so refer to them directly and by page ("the scoring chart on p.${attachedFigures[0].page} shows…") rather than describing them as if they were invisible. Read what a chart actually shows and use it in your answer instead of talking around it. If an attached figure does not genuinely help answer this particular question, ignore it completely — do not mention it, do not describe it, and do not refer to it in passing. A figure that adds nothing is worse than no figure at all.`;
  }

  try {
    const askOpenAI = (outgoing) => fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemContent }, ...outgoing],
        temperature: 0.3
      })
    });

    let openaiRes = await askOpenAI(outboundMessages);
    let data = await openaiRes.json();

    // A model without vision rejects image parts outright. Rather than
    // failing the whole answer over a diagram, drop the images and ask
    // again as plain text.
    if (!openaiRes.ok && attachedFigures.length) {
      const why = (data && data.error && data.error.message) || '';
      if (/image|vision|multimodal|content.*type/i.test(why)) {
        console.log(`Figures: ${MODEL} rejected image input — retrying without figures. (${why})`);
        attachedFigures = [];
        openaiRes = await askOpenAI(messages);
        data = await openaiRes.json();
      }
    }

    if (!openaiRes.ok) {
      const message = (data && data.error && data.error.message) || `OpenAI request failed (${openaiRes.status})`;
      return res.status(openaiRes.status).json({ error: message });
    }

    const reply = data.choices?.[0]?.message?.content || "I couldn't generate a response — please try again.";

    // Attached is not the same as used. If the model answered without
    // reaching for the figure, don't put it on screen.
    const shownFigures = attachedFigures.length && replyUsedFigures(reply) ? attachedFigures : [];
    if (attachedFigures.length && !shownFigures.length) {
      console.log(`Figures: fetched for p.${figurePages.pages.join(',')} but the answer didn't use them — not shown.`);
    }
    res.json({
      reply,
      reference: referencePagesUsed.length ? { pages: referencePagesUsed } : null,
      library: libraryItemsUsed.length ? { items: libraryItemsUsed } : null,
      // The figures the model was shown are described here so the client
      // can display the same ones. Only descriptors travel in the JSON —
      // the bytes come from the endpoint below, keeping chat replies small.
      figures: shownFigures.length
        ? {
            book: figurePages.bookTitle,
            items: shownFigures.map((f, i) => ({
              page: f.page,
              width: f.width,
              height: f.height,
              url: `/api/library/figure?book=${encodeURIComponent(figurePages.bookId)}&page=${f.page}&i=${indexOnPage(shownFigures, i)}`
            }))
          }
        : null
    });
  } catch (err) {
    res.status(500).json({ error: `Server error contacting OpenAI: ${err.message}` });
  }
});

// ---- Quiz ---------------------------------------------------------------

app.post('/api/quiz/generate', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'The server has no OPENAI_API_KEY configured. Add one to your .env file and restart the server.' });
  }
  const { bookId, topic, useReference, count, avoid } = req.body || {};
  if (!bookId && !topic) {
    return res.status(400).json({ error: 'Choose an ebook or enter a topic first.' });
  }
  const n = [5, 8, 10].includes(Number(count)) ? Number(count) : 5;

  const unavailable = libraryUnavailableReason();
  if (unavailable) return res.status(400).json({ error: unavailable });

  const book = bookId ? library.getBook(bookId) : null;
  if (bookId && !book) {
    return res.status(400).json({ error: 'That ebook is no longer loaded — reload the page and pick again.' });
  }

  const label = (topic && topic.trim()) || (book && book.title) || '';
  const { contextText, refBlock, sources } = buildStudyContext(bookId, topic, useReference);
  if (!contextText) {
    return res.status(400).json({ error: `Nothing in your Library matches "${label}" — try a different topic or pick an ebook.` });
  }

  const systemPrompt = `You are setting a short practice test for a student preparing for the PTE Academic exam. Ground every question ONLY in the material below — never invent facts, numbers, or templates that aren't in it. Respond with ONLY a raw JSON object, no markdown code fences, no commentary before or after, in exactly this shape:
{"questions": [{"question": "...", "options": ["...","...","...","..."], "answerIndex": 0, "explanation": "under 40 words", "sourceId": "S1"}]}

Create exactly ${n} questions focused on: ${label}. Each question needs exactly 4 options with only one correct answer. "answerIndex" is the 0-based index of the correct option.

Because this is exam practice rather than a memory drill:
- Write questions the way a PTE preparation test would: about task strategy, scoring criteria, timing, and what a response should contain — not trivia about the wording of the book.
- Make all four options plausible. Wrong options should be the mistakes students actually make, not obvious filler.
- The explanation must teach, not just assert: say why the right answer is right AND why a tempting wrong one is wrong.
- Vary what you ask about across the material rather than clustering on one page or one idea, and vary the style (recall, application, comparison).

"sourceId" is REQUIRED: set it to the id of the excerpt below (S1, S2, …) that the question is based on, so the student can go back and read it. Use the id exactly as written.${buildAvoidBlock(avoid)}

LIBRARY MATERIAL — each excerpt is tagged with its id, book title and page:
${contextText}${refBlock ? `\n\nADDITIONAL PERSONAL REFERENCE EXCERPTS (paraphrase these in your own words rather than quoting them):\n${refBlock}` : ''}`;

  try {
    const generated = await generateStructuredContent(systemPrompt, `Set a ${n}-question PTE practice test about: ${label}`);
    const usable = validQuestions(generated);
    if (!usable.length) {
      console.log(`Practice test: ${generated.length} question(s) came back but none passed validation:`);
      console.log(JSON.stringify(generated).slice(0, 600));
      return res.status(500).json({ error: 'The model returned no usable questions — try again.' });
    }
    if (usable.length < generated.length) {
      console.log(`Practice test: dropped ${generated.length - usable.length} malformed question(s).`);
    }

    const questions = shuffleQuizOptions(attachSources(usable, sources));
    res.json({
      questions,
      topic: label,
      // Named so the student can see what the test was drawn from before
      // they start, the way a real practice paper names its section.
      books: [...new Set(sources.map(src => src.book))]
    });
  } catch (err) {
    res.status(500).json({ error: `Could not generate practice test: ${err.message}` });
  }
});

app.get('/api/quiz-history', async (req, res) => {
  try {
    const history = await storage.getQuizHistory();
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: `Could not load quiz history: ${err.message}` });
  }
});

app.post('/api/quiz-history', async (req, res) => {
  const { topic, score, total } = req.body || {};
  if (!topic || typeof score !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ error: 'topic, score, and total are required.' });
  }
  try {
    const history = await storage.getQuizHistory();
    const entry = {
      id: crypto.randomUUID(),
      topic: String(topic).trim() || 'Untitled quiz',
      score,
      total,
      createdAt: new Date().toISOString()
    };
    history.unshift(entry);
    await storage.saveQuizHistory(history);
    res.json({ entry });
  } catch (err) {
    res.status(500).json({ error: `Could not save quiz result: ${err.message}` });
  }
});

app.delete('/api/quiz-history/:id', async (req, res) => {
  try {
    const history = await storage.getQuizHistory();
    const filtered = history.filter(h => h.id !== req.params.id);
    await storage.saveQuizHistory(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete quiz result: ${err.message}` });
  }
});

// ---- Study roadmap -------------------------------------------------

app.get('/api/roadmap', async (req, res) => {
  try {
    const progress = await storage.getProgress();
    const roadmap = ROADMAP.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({ ...step, done: Boolean(progress[step.id]) }))
    }));
    res.json({ roadmap });
  } catch (err) {
    res.status(500).json({ error: `Could not load roadmap: ${err.message}` });
  }
});

app.post('/api/roadmap/progress', async (req, res) => {
  const { stepId, done } = req.body || {};
  if (!stepId) return res.status(400).json({ error: 'stepId is required.' });
  try {
    const progress = await storage.getProgress();
    progress[stepId] = Boolean(done);
    await storage.saveProgress(progress);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not save progress: ${err.message}` });
  }
});

// ---- Notebook (saved notes + saved chat replies) -------------------

app.get('/api/notes', async (req, res) => {
  try {
    const notes = await storage.getNotes();
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: `Could not load notes: ${err.message}` });
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, content, type, sourceSection } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Note content is required.' });
  }
  try {
    const notes = await storage.getNotes();
    const note = {
      id: crypto.randomUUID(),
      title: (title && title.trim()) || 'Untitled note',
      content: content.trim(),
      type: type === 'chat' ? 'chat' : 'manual',
      sourceSection: sourceSection || null,
      createdAt: new Date().toISOString()
    };
    notes.unshift(note);
    await storage.saveNotes(notes);
    res.json({ note });
  } catch (err) {
    res.status(500).json({ error: `Could not save note: ${err.message}` });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    const notes = await storage.getNotes();
    const filtered = notes.filter(n => n.id !== req.params.id);
    await storage.saveNotes(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete note: ${err.message}` });
  }
});

// ---- Calendar (student tasks) ---------------------------------------

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await storage.getTasks();
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: `Could not load tasks: ${err.message}` });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { date, title } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Task title is required.' });
  }
  try {
    const tasks = await storage.getTasks();
    const task = {
      id: crypto.randomUUID(),
      date,
      title: title.trim(),
      done: false,
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
    await storage.saveTasks(tasks);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: `Could not save task: ${err.message}` });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  const { done, title, date } = req.body || {};
  try {
    const tasks = await storage.getTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found.' });
    if (done !== undefined) tasks[idx].done = Boolean(done);
    if (title !== undefined && title.trim()) tasks[idx].title = title.trim();
    if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) tasks[idx].date = date;
    await storage.saveTasks(tasks);
    res.json({ task: tasks[idx] });
  } catch (err) {
    res.status(500).json({ error: `Could not update task: ${err.message}` });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = await storage.getTasks();
    const filtered = tasks.filter(t => t.id !== req.params.id);
    await storage.saveTasks(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete task: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`PTE Prep Hub running at http://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? `OpenAI key loaded. Using model: ${MODEL}` : 'WARNING: No OPENAI_API_KEY found in .env');
  initReference();
  library.init();
});
