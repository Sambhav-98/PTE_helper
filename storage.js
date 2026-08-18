const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const FLASHCARDS_FILE = path.join(DATA_DIR, 'flashcards.json');
const QUIZ_HISTORY_FILE = path.join(DATA_DIR, 'quiz-history.json');

async function ensureFile(filePath, defaultValue) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

async function readJSON(filePath, defaultValue) {
  await ensureFile(filePath, defaultValue);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

async function writeJSON(filePath, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

module.exports = {
  async getNotes() {
    return readJSON(NOTES_FILE, []);
  },
  async saveNotes(notes) {
    return writeJSON(NOTES_FILE, notes);
  },
  async getProgress() {
    return readJSON(PROGRESS_FILE, {});
  },
  async saveProgress(progress) {
    return writeJSON(PROGRESS_FILE, progress);
  },
  async getTasks() {
    return readJSON(TASKS_FILE, []);
  },
  async saveTasks(tasks) {
    return writeJSON(TASKS_FILE, tasks);
  },
  async getFlashcardDecks() {
    return readJSON(FLASHCARDS_FILE, []);
  },
  async saveFlashcardDecks(decks) {
    return writeJSON(FLASHCARDS_FILE, decks);
  },
  async getQuizHistory() {
    return readJSON(QUIZ_HISTORY_FILE, []);
  },
  async saveQuizHistory(history) {
    return writeJSON(QUIZ_HISTORY_FILE, history);
  }
};
