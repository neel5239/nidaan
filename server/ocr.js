'use strict';
/* OCR module: raw text extraction. PDFs via pdf-parse; images via system Tesseract (fast) or tesseract.js fallback.
   Scanned PDFs (no text layer) return '' and the language module reads the file directly. */
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');

/* system Tesseract: explicit path via env, else common Linux/Windows locations */
const TESS_BIN = [process.env.TESSERACT_BIN, '/usr/bin/tesseract', '/usr/local/bin/tesseract', 'C:/Program Files/Tesseract-OCR/tesseract.exe'].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } }) || '';
const hasSystemTesseract = !!TESS_BIN;

async function pdfText(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const out = await pdfParse(buffer);
    return { text: (out.text || '').trim(), pages: out.numpages || 0 };
  } catch (e) {
    return { text: '', pages: 0, error: e.message };
  }
}

function systemTesseract(filePath) {
  return new Promise((resolve) => {
    execFile(TESS_BIN, [filePath, 'stdout', '-l', 'eng', '--psm', '6'], { maxBuffer: 8 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      if (err) return resolve({ text: '', error: err.message });
      resolve({ text: String(stdout || '').trim() });
    });
  });
}

async function jsTesseract(filePath) {
  try {
    const Tesseract = require('tesseract.js');
    const { data } = await Tesseract.recognize(filePath, 'eng');
    return { text: (data.text || '').trim() };
  } catch (e) {
    return { text: '', error: e.message };
  }
}

async function extractText({ filePath, mime }) {
  const buffer = fs.readFileSync(filePath);
  if (/pdf/i.test(mime) || /\.pdf$/i.test(filePath)) {
    const r = await pdfText(buffer);
    return { engine: 'pdf-parse', text: r.text, scanned: r.text.length < 40, pages: r.pages, error: r.error };
  }
  if (/^image\//i.test(mime)) {
    if (/heic|heif/i.test(mime)) return { engine: 'none', text: '', scanned: true, note: 'HEIC not OCR-able locally' };
    const r = hasSystemTesseract ? await systemTesseract(filePath) : await jsTesseract(filePath);
    return { engine: hasSystemTesseract ? 'tesseract' : 'tesseract.js', text: r.text, scanned: r.text.length < 20, error: r.error };
  }
  if (/text\/plain/i.test(mime)) return { engine: 'plain', text: buffer.toString('utf8'), scanned: false };
  return { engine: 'none', text: '', scanned: true, note: 'unsupported type ' + mime };
}

module.exports = { extractText, hasSystemTesseract };
