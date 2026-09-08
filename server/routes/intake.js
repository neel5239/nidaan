'use strict';
/* Request-driven, Gemini-driven questionnaire. Every step is persisted so the patient can leave and come back. */
const express = require('express');
const multer = require('multer');
const { q, json, log } = require('../db');
const { auth } = require('../auth');
const { intakeView, docView, expiryFor } = require('../lib');
const gemini = require('../gemini');

const r = express.Router();
r.use(auth(['patient']));
r.use((req, _res, next) => { req.pid = req.user.patient_id; next(); });

function patientCtx(pid) { return q.get('SELECT p.*, u.name FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=?', pid); }
function ownIntake(req) {
  const i = q.get('SELECT * FROM intakes WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!i) return null;
  if (i.status === 'sent') return i;
  return i;
}
function requestCtx(id) {
  return q.get(`SELECT r.*, c.name AS clinic_name, d.name AS doctor_name, d.specialty FROM requests r JOIN clinics c ON c.id=r.clinic_id LEFT JOIN doctors d ON d.id=r.doctor_id WHERE r.id=?`, id);
}

/* Start (or resume) the intake for a clinic request. */
r.post('/start', async (req, res) => {
  const rq = q.get(`SELECT * FROM requests WHERE id=? AND patient_id=? AND status='pending'`, req.body?.request_id, req.pid);
  if (!rq) return res.status(404).json({ error: 'Request not found or already answered' });
  let i = q.get(`SELECT * FROM intakes WHERE request_id=? AND status='draft'`, rq.id);
  if (!i) {
    const id = q.run('INSERT INTO intakes(patient_id,episode_id,request_id) VALUES(?,?,?)', req.pid, rq.episode_id, rq.id).lastInsertRowid;
    i = q.get('SELECT * FROM intakes WHERE id=?', id);
  }
  const ctx = requestCtx(rq.id);
  const first = await gemini.nextQuestion({ patient: patientCtx(req.pid), history: [], doctor: ctx });
  res.json({ intake: intakeView(i), request: ctx, first });
});

/* Save answers so far and get the next question (or done). */
r.post('/:id/next', async (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).map(h => ({ q: String(h.q || ''), a: String(h.a || '').trim(), field: h.field || '', kind: h.kind || 'text', section: h.section === 'dashavidha' ? 'dashavidha' : 'complaint' }));
  const patch = req.body || {};
  q.run('UPDATE intakes SET answers=?, mode=COALESCE(?,mode), pain=COALESCE(?,pain) WHERE id=?', JSON.stringify(history), patch.mode || null, patch.pain != null ? Number(patch.pain) : null, i.id);
  try {
    const ctx = requestCtx(i.request_id);
    /* complaint_done sticks once the language module says the complaint questions are finished, so Back/Continue is stable */
    const complaintDone = !!i.complaint_done && history.filter(h => h.section === 'complaint').length >= i.complaint_done;
    const next = await gemini.nextQuestion({ patient: patientCtx(req.pid), history, doctor: ctx, complaintDone });
    if (next.complaint_done) q.run('UPDATE intakes SET complaint_done=? WHERE id=?', history.filter(h => h.section === 'complaint').length, i.id);
    res.json(next);
  } catch (e) {
    res.status(502).json({ error: 'Question service unavailable: ' + e.message });
  }
});

/* Complaint-specific urgent signs (checkbox options). Cached on the intake. */
r.post('/:id/urgent-options', async (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  const history = Array.isArray(req.body?.history) && req.body.history.length ? req.body.history : json(i.answers, []);
  const cached = json(i.urgent_options, null);
  const key = JSON.stringify(history.map(h => h.a)).slice(0, 400);
  if (cached && cached.key === key) return res.json({ signs: cached.signs });
  try {
    const signs = await gemini.urgentSigns({ history });
    q.run('UPDATE intakes SET urgent_options=? WHERE id=?', JSON.stringify({ key, signs }), i.id);
    res.json({ signs });
  } catch (e) { res.status(502).json({ error: 'Question service unavailable: ' + e.message }); }
});

r.patch('/:id', (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  const b = req.body || {};
  q.run('UPDATE intakes SET mode=COALESCE(?,mode), pain=COALESCE(?,pain), urgent=COALESCE(?,urgent), has_reports=COALESCE(?,has_reports) WHERE id=?',
    b.mode || null, b.pain != null ? Number(b.pain) : null, Array.isArray(b.urgent) ? JSON.stringify(b.urgent) : null, b.has_reports == null ? null : (b.has_reports ? 1 : 0), i.id);
  res.json(intakeView(q.get('SELECT * FROM intakes WHERE id=?', i.id)));
});

/* Documents the patient can pick from (all their confirmed docs, this request's episode first). */
r.get('/:id/documents', (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  const docs = q.all(`SELECT d.*, e.title AS episode_title FROM documents d LEFT JOIN episodes e ON e.id=d.episode_id WHERE d.patient_id=? AND d.ocr_status!='draft' ORDER BY (d.episode_id=?) DESC, d.doc_date DESC, d.id DESC`, req.pid, i.episode_id || -1)
    .map(d => ({ ...docView(d), episode_title: d.episode_title }));
  res.json({ documents: docs, episodes: q.all(`SELECT * FROM episodes WHERE patient_id=? ORDER BY (status='open') DESC, started_at DESC`, req.pid) });
});

/* Preview summary (Gemini) before sending. */
r.post('/:id/preview', async (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  try {
    const s = await buildSummary(i, req.body || {}, req.pid);
    res.json(s);
  } catch (e) { res.status(502).json({ error: 'Summary service unavailable: ' + e.message }); }
});

async function buildSummary(i, b, pid) {
  const history = Array.isArray(b.history) ? b.history : json(i.answers, []);
  const urgent = Array.isArray(b.urgent) ? b.urgent : json(i.urgent, []);
  const pain = b.pain != null ? Number(b.pain) : i.pain;
  const docIds = (Array.isArray(b.document_ids) ? b.document_ids : []).map(Number);
  const documents = docIds.length ? q.all(`SELECT * FROM documents WHERE patient_id=? AND id IN (${docIds.map(() => '?').join(',')})`, pid, ...docIds).map(docView) : [];
  const summary = await gemini.intakeSummary({ patient: patientCtx(pid), history, pain, urgent, documents });
  return { summary, history, urgent, pain, docIds };
}

/* Send: freeze answers, generate summary, create share to the clinic+doctor, complete the request, attach to queue. */
r.post('/:id/send', async (req, res) => {
  const i = ownIntake(req);
  if (!i) return res.status(404).json({ error: 'Intake not found' });
  if (i.status === 'sent') return res.status(400).json({ error: 'Already sent' });
  const rq = requestCtx(i.request_id);
  if (!rq || rq.status !== 'pending') return res.status(400).json({ error: 'The clinic request is no longer open' });
  const b = req.body || {};
  let built;
  try { built = await buildSummary(i, b, req.pid); }
  catch (e) { return res.status(502).json({ error: 'Summary service unavailable: ' + e.message }); }
  const { summary, history, urgent, pain, docIds } = built;
  const mode = b.mode === 'voice' ? 'voice' : 'text';
  const hasReports = b.has_reports ? 1 : 0;

  /* episode: reuse the request's, else the most recent open episode matching, else create from the summary title */
  let epId = i.episode_id || rq.episode_id;
  if (!epId && b.episode_id) epId = q.get('SELECT id FROM episodes WHERE id=? AND patient_id=?', b.episode_id, req.pid)?.id;
  if (!epId) epId = q.run('INSERT INTO episodes(patient_id,title) VALUES(?,?)', req.pid, summary.title || 'Health concern').lastInsertRowid;
  else if (summary.title) { /* an episode auto-created during this intake (e.g. by a report upload) gets the proper title */
    const ep = q.get('SELECT * FROM episodes WHERE id=?', epId);
    const priorIntakes = q.get(`SELECT COUNT(*) AS c FROM intakes WHERE episode_id=? AND status='sent'`, epId).c;
    if (ep && !priorIntakes && ep.started_at >= i.created_at) q.run('UPDATE episodes SET title=? WHERE id=?', summary.title, epId);
  }

  q.run(`UPDATE intakes SET answers=?, mode=?, pain=?, urgent=?, has_reports=?, summary=?, episode_id=?, status='sent', sent_at=datetime('now') WHERE id=?`,
    JSON.stringify(history), mode, pain, JSON.stringify(urgent), hasReports, JSON.stringify(summary), epId, i.id);
  const sid = q.run('INSERT INTO shares(patient_id,clinic_id,doctor_id,episode_id,intake_id,request_id,include_profile,duration,expires_at,accepted) VALUES(?,?,?,?,?,?,1,?,?,1)',
    req.pid, rq.clinic_id, rq.doctor_id, epId, i.id, rq.id, b.duration || 'visit', expiryFor(b.duration || 'visit')).lastInsertRowid;
  const useDocs = hasReports ? docIds : [];
  useDocs.forEach(id => q.run('INSERT OR IGNORE INTO share_items(share_id,document_id) VALUES(?,?)', sid, id));
  q.run(`UPDATE requests SET status='completed', intake_id=?, share_id=?, episode_id=?, responded_at=datetime('now') WHERE id=?`, i.id, sid, epId, rq.id);
  const qe = q.get('SELECT * FROM queue WHERE request_id=?', rq.id);
  if (qe) q.run('UPDATE queue SET share_id=? WHERE id=?', sid, qe.id);
  else q.run('INSERT INTO queue(clinic_id,patient_id,doctor_id,request_id,share_id,status,assigned_at) VALUES(?,?,?,?,?,?,?)', rq.clinic_id, req.pid, rq.doctor_id, rq.id, sid, 'waiting', rq.doctor_id ? new Date().toISOString() : null);
  log(req.pid, null, `You sent intake${useDocs.length ? ' + ' + useDocs.length + ' report' + (useDocs.length > 1 ? 's' : '') : ''} to ${rq.doctor_name || rq.clinic_name}`);
  res.json({ ok: true, intake: intakeView(q.get('SELECT * FROM intakes WHERE id=?', i.id)), share_id: sid, episode_id: epId, request: rq, reports: useDocs.length });
});

/* Speech-to-text fallback (used when the browser has no Web Speech API). */
const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
r.post('/stt', mem.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  try { res.json({ text: await gemini.transcribe({ buffer: req.file.buffer, mime: req.file.mimetype }) }); }
  catch (e) { res.status(502).json({ error: 'Transcription unavailable: ' + e.message }); }
});

module.exports = r;
