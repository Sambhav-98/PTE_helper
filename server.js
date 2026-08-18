require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { SOURCES } = require('./knowledge');
const { ROADMAP } = require('./roadmap');
const storage = require('./storage');
const reference = require('./reference');
const library = require('./library');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const REFERENCE_PDF_PATH = process.env.REFERENCE_PDF_PATH;
const REFERENCE_PDF_DRIVE_URL = process.env.REFERENCE_PDF_DRIVE_URL;

// Library uploads are held in memory just long enough to parse + save to
// disk (library.addBook does the writing) — never written anywhere by
// multer itself. 50MB covers a large scanned-text ebook comfortably.
const libraryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

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
 * Builds grounding material for flashcard/quiz generation: the full text
 * of a chosen handbook section (falling back to the whole handbook if no
 * section is picked), plus optional short reference excerpts — the same
 * excerpt search and 700-character cap used by chat, so generated study
 * material stays just as grounded and just as light on any personal
 * reference content.
 */
function buildStudyContext(sectionTitle, topic, useReference) {
  const label = (topic && topic.trim()) || sectionTitle || '';
  let contextText = '';

  // Library first: search the uploaded ebooks for chunks matching the
  // chosen topic/section, capped just like chat — not the whole library.
  if (!library.isEmpty() && label) {
    const libMatches = library.search(label, 4);
    if (libMatches.length) contextText = library.buildExcerptBlock(libMatches, 3500);
  }

  // Handbook fallback — used whenever the library is empty or has nothing
  // relevant to this particular topic.
  if (!contextText && sectionTitle) {
    const section = SOURCES.find(s => s.title === sectionTitle);
    if (section) contextText = `## ${section.title}\n${section.content.trim()}`;
  }
  if (!contextText) {
    contextText = SOURCES.map(s => `## ${s.title}\n${s.content.trim()}`).join('\n\n');
  }

  let refBlock = '';
  const query = (topic || sectionTitle || '').trim();
  if (useReference && referenceReady && referenceChunks.length && query) {
    const matches = reference.searchChunks(query, referenceChunks, 2);
    if (matches.length) refBlock = reference.buildExcerptBlock(matches, 700);
  }

  return { contextText, refBlock };
}

/**
 * Calls OpenAI with a system+user prompt and parses the reply as JSON.
 * Used by flashcard/quiz generation, which both need structured output
 * rather than free-form chat text.
 */
async function generateStructuredContent(systemPrompt, userPrompt) {
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 1.5
    })
  });

  const data = await openaiRes.json();
  if (!openaiRes.ok) {
    const message = (data && data.error && data.error.message) || `OpenAI request failed (${openaiRes.status})`;
    throw new Error(message);
  }

  const raw = data.choices?.[0]?.message?.content || '';
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('the model returned something that wasn\'t valid JSON — try generating again.');
  }
  return parsed;
}

// Exposes just the section titles for the Sources panel.
app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({ title: s.title })));
});

// Lets the frontend show whether a personal reference PDF is connected,
// without exposing its path, filename, or any of its content.
app.get('/api/reference-status', (req, res) => {
  res.json({ available: referenceReady, pages: referencePageCount, source: referenceSource });
});

// ---- Library (uploaded ebooks — the primary knowledge source) ----------

app.get('/api/library', (req, res) => {
  res.json({ books: library.listBooks() });
});

app.post('/api/library/upload', (req, res) => {
  libraryUpload.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (50MB max).' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file was received. Only application/pdf is accepted.' });
    }
    try {
      const book = await library.addBook(req.file.buffer, req.file.originalname);
      res.json({ book });
    } catch (e) {
      res.status(400).json({ error: `Could not read this PDF: ${e.message}` });
    }
  });
});

app.delete('/api/library/:id', async (req, res) => {
  try {
    const removed = await library.removeBook(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Ebook not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not remove ebook: ${err.message}` });
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
  if (!library.isEmpty() && lastUserMessage && lastUserMessage.content) {
    const libMatches = library.search(lastUserMessage.content, 5);
    if (libMatches.length) {
      libraryExcerpt = library.buildExcerptBlock(libMatches, 4000);
      libraryItemsUsed = libMatches.map(m => ({ book: m.bookTitle, page: m.page }));
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

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemContent }, ...messages],
        temperature: 0.3
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      const message = (data && data.error && data.error.message) || `OpenAI request failed (${openaiRes.status})`;
      return res.status(openaiRes.status).json({ error: message });
    }

    const reply = data.choices?.[0]?.message?.content || "I couldn't generate a response — please try again.";
    res.json({
      reply,
      reference: referencePagesUsed.length ? { pages: referencePagesUsed } : null,
      library: libraryItemsUsed.length ? { items: libraryItemsUsed } : null
    });
  } catch (err) {
    res.status(500).json({ error: `Server error contacting OpenAI: ${err.message}` });
  }
});

// ---- Flashcards -------------------------------------------------------

app.post('/api/flashcards/generate', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'The server has no OPENAI_API_KEY configured. Add one to your .env file and restart the server.' });
  }
  const { sectionTitle, topic, useReference } = req.body || {};
  if (!sectionTitle && !topic) {
    return res.status(400).json({ error: 'Choose a section or enter a topic first.' });
  }

  const label = (topic && topic.trim()) || sectionTitle;
  const { contextText, refBlock } = buildStudyContext(sectionTitle, topic, useReference);

  const systemPrompt = `You create study flashcards for a PTE Academic student, grounded ONLY in the material below — never invent facts, numbers, or templates that aren't in it. Respond with ONLY a raw JSON array, no markdown code fences, no commentary before or after, in exactly this shape:
[{"front": "short question or term (under 15 words)", "back": "concise direct answer (under 35 words)"}]
Create between 6 and 10 cards focused on: ${label}

MATERIAL:
${contextText}${refBlock ? `\n\nADDITIONAL PERSONAL REFERENCE EXCERPTS (paraphrase these in your own words rather than quoting them):\n${refBlock}` : ''}`;

  try {
    const cards = await generateStructuredContent(systemPrompt, `Generate flashcards about: ${label}`);
    if (!Array.isArray(cards) || !cards.length) {
      return res.status(500).json({ error: 'The model returned no usable flashcards — try again.' });
    }
    res.json({ cards, topic: label });
  } catch (err) {
    res.status(500).json({ error: `Could not generate flashcards: ${err.message}` });
  }
});

app.get('/api/flashcards', async (req, res) => {
  try {
    const decks = await storage.getFlashcardDecks();
    res.json({ decks });
  } catch (err) {
    res.status(500).json({ error: `Could not load flashcard decks: ${err.message}` });
  }
});

app.post('/api/flashcards', async (req, res) => {
  const { topic, cards } = req.body || {};
  if (!topic || !Array.isArray(cards) || !cards.length) {
    return res.status(400).json({ error: 'topic and a non-empty cards array are required.' });
  }
  try {
    const decks = await storage.getFlashcardDecks();
    const deck = {
      id: crypto.randomUUID(),
      topic: String(topic).trim() || 'Untitled deck',
      cards,
      createdAt: new Date().toISOString()
    };
    decks.unshift(deck);
    await storage.saveFlashcardDecks(decks);
    res.json({ deck });
  } catch (err) {
    res.status(500).json({ error: `Could not save deck: ${err.message}` });
  }
});

app.delete('/api/flashcards/:id', async (req, res) => {
  try {
    const decks = await storage.getFlashcardDecks();
    const filtered = decks.filter(d => d.id !== req.params.id);
    await storage.saveFlashcardDecks(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete deck: ${err.message}` });
  }
});

// ---- Quiz ---------------------------------------------------------------

app.post('/api/quiz/generate', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'The server has no OPENAI_API_KEY configured. Add one to your .env file and restart the server.' });
  }
  const { sectionTitle, topic, useReference, count } = req.body || {};
  if (!sectionTitle && !topic) {
    return res.status(400).json({ error: 'Choose a section or enter a topic first.' });
  }
  const n = [5, 8, 10].includes(Number(count)) ? Number(count) : 5;

  const label = (topic && topic.trim()) || sectionTitle;
  const { contextText, refBlock } = buildStudyContext(sectionTitle, topic, useReference);

  const systemPrompt = `You create a multiple-choice quiz for a PTE Academic student, grounded ONLY in the material below — never invent facts, numbers, or templates that aren't in it. Respond with ONLY a raw JSON array, no markdown code fences, no commentary before or after, in exactly this shape:
[{"question": "...", "options": ["...","...","...","..."], "answerIndex": 0, "explanation": "under 25 words"}]
Create exactly ${n} questions focused on: ${label}. Each question needs exactly 4 options with only one correct answer. "answerIndex" is the 0-based index of the correct option.

MATERIAL:
${contextText}${refBlock ? `\n\nADDITIONAL PERSONAL REFERENCE EXCERPTS (paraphrase these in your own words rather than quoting them):\n${refBlock}` : ''}`;

  try {
    const questions = await generateStructuredContent(systemPrompt, `Generate a ${n}-question quiz about: ${label}`);
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(500).json({ error: 'The model returned no usable questions — try again.' });
    }
    res.json({ questions, topic: label });
  } catch (err) {
    res.status(500).json({ error: `Could not generate quiz: ${err.message}` });
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
