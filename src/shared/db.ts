/**
 * IndexedDB layer — stores resume binary (dataUrl) and extracted text.
 * PDF text extraction uses pdf.js (pdfjs-dist v3).
 */

import type { ResumeRecord } from '../types';

const DB_NAME      = 'ApplyPilotDB';
const DB_VERSION   = 1;
const RESUME_STORE = 'resume';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(RESUME_STORE)) {
        db.createObjectStore(RESUME_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Resume ────────────────────────────────────────────────────────────────────

export async function saveResume(record: Omit<ResumeRecord, 'id'>): Promise<void> {
  const db  = await openDB();
  const full: ResumeRecord = { ...record, id: 'resume' };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(RESUME_STORE, 'readwrite');
    const req = tx.objectStore(RESUME_STORE).put(full);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

export async function getResume(): Promise<ResumeRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(RESUME_STORE, 'readonly');
    const req = tx.objectStore(RESUME_STORE).get('resume');
    req.onsuccess = () => { db.close(); resolve((req.result as ResumeRecord) ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

export async function deleteResume(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(RESUME_STORE, 'readwrite');
    const req = tx.objectStore(RESUME_STORE).delete('resume');
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

// ── Text extraction ───────────────────────────────────────────────────────────

export async function extractTextFromFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();

  if (ext === 'txt')  return file.text();
  if (ext === 'pdf')  return extractPdfText(file);
  if (ext === 'docx') return extractDocxText(file);
  return '';
}

// ── PDF extraction via pdf.js ─────────────────────────────────────────────────

async function extractPdfText(file: File): Promise<string> {
  // Dynamically load pdfjs only when needed (options page only, never in content scripts)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfjs = require('pdfjs-dist/build/pdf.js') as typeof import('pdfjs-dist');

  // Point the worker at the bundled copy in dist/
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
  } else {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf         = await loadingTask.promise;

  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Each item has a `str` string and a `transform` giving position.
    // We group by Y position to reconstruct lines properly.
    interface TextItem { str: string; transform: number[]; width: number; }
    const items = content.items as TextItem[];

    // Sort by page Y descending (PDF Y axis is bottom-up), then X ascending
    const sorted = [...items].sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      return Math.abs(yDiff) > 2 ? yDiff : a.transform[4] - b.transform[4];
    });

    // Group into lines by Y proximity (within 3pt)
    const lines: string[][] = [];
    let currentLine: string[] = [];
    let lastY = Infinity;

    for (const item of sorted) {
      const y = item.transform[5];
      if (Math.abs(y - lastY) > 3 && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
      }
      if (item.str.trim()) currentLine.push(item.str);
      lastY = y;
    }
    if (currentLine.length > 0) lines.push(currentLine);

    pages.push(lines.map((l) => l.join(' ')).join('\n'));
  }

  const fullText = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return fullText.slice(0, 10_000); // cap for API calls
}

// ── DOCX extraction (XML parse) ───────────────────────────────────────────────

async function extractDocxText(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer();
    const dec  = new TextDecoder('utf-8', { fatal: false });
    const raw  = dec.decode(new Uint8Array(buf));

    const start = raw.indexOf('<w:body');
    const end   = raw.indexOf('</w:body>');
    if (start === -1 || end === -1) return '';

    const text = raw
      .slice(start, end + '</w:body>'.length)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\s{3,}/g, '\n')
      .trim()
      .slice(0, 10_000);

    return text;
  } catch {
    return '';
  }
}
