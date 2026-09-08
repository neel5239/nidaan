'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const { login, auth, profileFor } = require('./auth');
const register = require('./register')(profileFor);
const { MODEL } = require('./gemini');
const ocr = require('./ocr');

/* async route handlers: forward rejected promises to the error middleware instead of crashing the process */
const Layer = require('express/lib/router/layer');
const origHandle = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return origHandle.call(this, req, res, next);
  try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
};
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.post('/api/login', login);
app.post('/api/register/patient', register.patient);
app.post('/api/register/clinic', register.clinic);
app.post('/api/register/doctor', register.doctor);
app.get('/api/register/clinics', register.clinics);
app.get('/api/me', auth(), (req, res) => res.json(req.user));
app.get('/api/health', async (req, res) => {
  const key = process.env.GEMINI_API_KEY || '';
  const out = { ok: true, model: MODEL, ocr: ocr.hasSystemTesseract ? 'tesseract' : 'tesseract.js', gemini: !!key, key_preview: key ? key.slice(0, 5) + '…' + key.slice(-4) + ' (' + key.length + ' chars)' : 'MISSING' };
  if (req.query.check === 'gemini') {           /* live round-trip so a broken key/model shows its real error */
    try { const t0 = Date.now(); const r = await require('./gemini').generate({ parts: [{ text: 'Reply with JSON {"ok":true}' }], temperature: 0 }); out.gemini_test = { ok: !!r.ok, ms: Date.now() - t0 }; }
    catch (e) { out.gemini_test = { ok: false, error: e.message }; }
  }
  res.json(out);
});

app.use('/api/patient', require('./routes/patient'));
app.use('/api/intake', require('./routes/intake'));
app.use('/api/clinic', require('./routes/clinic'));
app.use('/api/doctor', require('./routes/doctor'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html', extensions: ['html'],
  /* always revalidate the app shell so browsers pick up new JS/CSS/HTML immediately */
  setHeaders: (res, filePath) => { if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); }
}));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Nidaan running on http://localhost:${PORT}  (model ${MODEL}, OCR ${ocr.hasSystemTesseract ? 'system tesseract' : 'tesseract.js'})`));
