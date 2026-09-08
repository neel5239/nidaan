'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { q, json, log, UPLOAD_DIR } = require('../db');
const { auth } = require('../auth');
const { expireShares, expiryFor, docView, intakeView, shareContents, flagCounts } = require('../lib');
const ocr = require('../ocr');
const gemini = require('../gemini');

const r = express.Router();
r.use(auth(['patient']));
r.use((req, _res, next) => { expireShares(); req.pid = req.user.patient_id; next(); });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname || '').toLowerCase())
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

/* ---------- profile ---------- */
function profile(pid) {
  return q.get('SELECT p.*, u.name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=?', pid);
}
r.get('/profile', (req, res) => res.json(profile(req.pid)));
r.put('/profile', (req, res) => {
  const b = req.body || {};
  q.run('UPDATE patients SET age=?, sex=?, phone=?, city=?, blood_group=?, allergies=?, conditions=?, medicines=?, emergency_contact=? WHERE id=?',
    b.age ? Number(b.age) : null, b.sex || null, b.phone || null, b.city || null, b.blood_group || null, b.allergies || null, b.conditions || null, b.medicines || null, b.emergency_contact || null, req.pid);
  res.json(profile(req.pid));
});

/* ---------- episodes ---------- */
function episodeView(e, pid) {
  const docs = q.get(`SELECT COUNT(*) AS c FROM documents WHERE episode_id=? AND ocr_status!='draft'`, e.id).c;
  const intakes = q.get(`SELECT COUNT(*) AS c FROM intakes WHERE episode_id=? AND status='sent'`, e.id).c;
  const shares = q.all(`SELECT s.*, c.name AS clinic_name, d.name AS doctor_name FROM shares s JOIN clinics c ON c.id=s.clinic_id LEFT JOIN doctors d ON d.id=s.doctor_id WHERE s.episode_id=? AND s.patient_id=? ORDER BY s.id DESC`, e.id, pid);
  const active = shares.filter(s => s.status === 'active');
  const lastRx = q.get(`SELECT * FROM documents WHERE episode_id=? AND uploader_role='doctor' ORDER BY id DESC LIMIT 1`, e.id);
  return { ...e, doc_count: docs, intake_count: intakes, shares, active_shares: active, last_rx: lastRx ? docView(lastRx) : null };
}
r.get('/home', (req, res) => {
  const eps = q.all(`SELECT * FROM episodes WHERE patient_id=? ORDER BY (status='open') DESC, started_at DESC`, req.pid).map(e => episodeView(e, req.pid));
  const reqs = q.all(`SELECT r.*, c.name AS clinic_name, d.name AS doctor_name, d.specialty FROM requests r JOIN clinics c ON c.id=r.clinic_id LEFT JOIN doctors d ON d.id=r.doctor_id WHERE r.patient_id=? AND r.status='pending' ORDER BY r.id DESC`, req.pid);
  const shares = q.all(`SELECT s.*, c.name AS clinic_name, d.name AS doctor_name, e.title AS episode_title FROM shares s JOIN clinics c ON c.id=s.clinic_id LEFT JOIN doctors d ON d.id=s.doctor_id LEFT JOIN episodes e ON e.id=s.episode_id WHERE s.patient_id=? AND s.status='active' ORDER BY s.id DESC`, req.pid)
    .map(s => ({ ...s, item_count: q.get('SELECT COUNT(*) AS c FROM share_items WHERE share_id=?', s.id).c }));
  const docCount = q.get(`SELECT COUNT(*) AS c FROM documents WHERE patient_id=? AND ocr_status!='draft'`, req.pid).c;
  res.json({ profile: profile(req.pid), episodes: eps, requests: reqs, active_shares: shares, doc_count: docCount });
});
r.get('/episodes', (req, res) => res.json(q.all(`SELECT * FROM episodes WHERE patient_id=? ORDER BY (status='open') DESC, started_at DESC`, req.pid)));
r.post('/episodes', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Episode title required' });
  const id = q.run('INSERT INTO episodes(patient_id,title) VALUES(?,?)', req.pid, title).lastInsertRowid;
  res.json(q.get('SELECT * FROM episodes WHERE id=?', id));
});
r.patch('/episodes/:id', (req, res) => {
  const e = q.get('SELECT * FROM episodes WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!e) return res.status(404).json({ error: 'Episode not found' });
  const status = req.body?.status === 'resolved' ? 'resolved' : 'open';
  q.run('UPDATE episodes SET status=?, resolved_at=? WHERE id=?', status, status === 'resolved' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, e.id);
  if (req.body?.title) q.run('UPDATE episodes SET title=? WHERE id=?', String(req.body.title).trim(), e.id);
  res.json(q.get('SELECT * FROM episodes WHERE id=?', e.id));
});
r.get('/episodes/:id', (req, res) => {
  const e = q.get('SELECT * FROM episodes WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!e) return res.status(404).json({ error: 'Episode not found' });
  const docs = q.all(`SELECT * FROM documents WHERE episode_id=? AND ocr_status!='draft' ORDER BY id DESC`, e.id).map(docView);
  const intakes = q.all(`SELECT i.*, d.name AS doctor_name, c.name AS clinic_name FROM intakes i LEFT JOIN requests r ON r.id=i.request_id LEFT JOIN doctors d ON d.id=r.doctor_id LEFT JOIN clinics c ON c.id=r.clinic_id WHERE i.episode_id=? AND i.status='sent' ORDER BY i.id DESC`, e.id)
    .map(i => ({ ...intakeView(i), doctor_name: i.doctor_name, clinic_name: i.clinic_name }));
  const sharedIds = new Set(q.all(`SELECT si.document_id FROM share_items si JOIN shares s ON s.id=si.share_id WHERE s.status='active' AND s.episode_id=?`, e.id).map(x => x.document_id));
  docs.forEach(d => { d.shared = sharedIds.has(d.id); });
  /* timeline */
  const tl = [];
  tl.push({ t: 'Episode started', at: e.started_at });
  docs.forEach(d => tl.push({ t: (d.uploader_role === 'doctor' ? 'Prescription received' : (d.doc_type || 'Document') + ' uploaded'), s: d.name + (d.issued_by ? ' · ' + d.issued_by : ''), at: d.created_at }));
  intakes.forEach(i => tl.push({ t: 'Intake sent' + (i.doctor_name ? ' to ' + i.doctor_name : ''), s: (i.summary?.red_flags?.length || 0) + ' flag(s) raised · answered by ' + (i.mode === 'voice' ? 'speaking' : 'typing'), at: i.sent_at }));
  const ev = episodeView(e, req.pid);
  ev.shares.forEach(s => { tl.push({ t: 'Shared with ' + s.clinic_name, s: s.doctor_name ? 'Assigned to ' + s.doctor_name : '', at: s.created_at }); if (s.ended_at) tl.push({ t: 'Share with ' + s.clinic_name + ' ' + s.status, at: s.ended_at }); });
  if (e.resolved_at) tl.push({ t: 'Marked resolved', at: e.resolved_at });
  tl.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  res.json({ episode: ev, documents: docs, intakes, timeline: tl });
});

/* ---------- documents ---------- */
r.get('/documents', (req, res) => {
  const eps = q.all(`SELECT * FROM episodes WHERE patient_id=? ORDER BY (status='open') DESC, started_at DESC`, req.pid);
  const docs = q.all(`SELECT * FROM documents WHERE patient_id=? AND ocr_status!='draft' ORDER BY doc_date DESC, id DESC`, req.pid).map(docView);
  const sharedWith = {};
  q.all(`SELECT si.document_id, c.name FROM share_items si JOIN shares s ON s.id=si.share_id JOIN clinics c ON c.id=s.clinic_id WHERE s.status='active' AND s.patient_id=?`, req.pid)
    .forEach(x => { (sharedWith[x.document_id] = sharedWith[x.document_id] || []).push(x.name); });
  docs.forEach(d => { d.shared_with = sharedWith[d.id] || []; });
  res.json({ episodes: eps, documents: docs });
});

/* Step 1: upload the file; OCR + Gemini extraction run inline; the doc is a 'draft' until confirmed. */
r.post('/documents/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const f = req.file;
  const id = q.run(`INSERT INTO documents(patient_id,uploaded_by,uploader_role,name,original_name,stored_name,mime,size,ocr_status) VALUES(?,?,?,?,?,?,?,?,'draft')`,
    req.pid, req.user.id, 'patient', f.originalname, f.originalname, f.filename, f.mimetype, f.size).lastInsertRowid;
  const result = await runExtraction(id, f.path, f.mimetype, f.originalname, profile(req.pid));
  res.json({ id, ...result });
});
async function runExtraction(id, filePath, mime, filename, patient) {
  let ocrText = '', engine = 'none', extracted = null, error = null;
  try {
    const o = await ocr.extractText({ filePath, mime });
    ocrText = o.text || ''; engine = o.engine;
  } catch (e) { error = 'OCR: ' + e.message; }
  try {
    extracted = await gemini.extractDocument({ buffer: fs.readFileSync(filePath), mime, ocrText, filename, patient });
  } catch (e) { error = (error ? error + ' · ' : '') + 'Language module: ' + e.message; }
  q.run('UPDATE documents SET ocr_text=?, extracted=? WHERE id=?', ocrText, extracted ? JSON.stringify(extracted) : null, id);
  return { ocr_engine: engine, ocr_chars: ocrText.length, extracted, error };
}
/* Step 2: confirm metadata + episode. Creates a new episode if new_episode_title is given. */
r.patch('/documents/:id', (req, res) => {
  const d = q.get('SELECT * FROM documents WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  const b = req.body || {};
  let epId = b.episode_id ? Number(b.episode_id) : d.episode_id;
  if (b.new_episode_title) epId = q.run('INSERT INTO episodes(patient_id,title) VALUES(?,?)', req.pid, String(b.new_episode_title).trim()).lastInsertRowid;
  if (!epId) return res.status(400).json({ error: 'Choose which problem this report belongs to' });
  const ep = q.get('SELECT id FROM episodes WHERE id=? AND patient_id=?', epId, req.pid);
  if (!ep) return res.status(400).json({ error: 'Bad episode' });
  q.run(`UPDATE documents SET episode_id=?, name=?, doc_type=?, doc_date=?, issued_by=?, ocr_status='done' WHERE id=?`,
    epId, (b.name || d.name).toString().trim(), b.doc_type || d.doc_type || 'Other', b.doc_date || d.doc_date || null, b.issued_by || d.issued_by || null, d.id);
  log(req.pid, null, 'You uploaded ' + (b.name || d.name));
  res.json(docView(q.get('SELECT * FROM documents WHERE id=?', d.id)));
});
r.delete('/documents/:id', (req, res) => {
  const d = q.get('SELECT * FROM documents WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  const inShare = q.get('SELECT 1 FROM share_items WHERE document_id=?', d.id);
  if (inShare && d.ocr_status !== 'draft') return res.status(400).json({ error: 'This document is part of a share. Revoke the share first.' });
  q.run('DELETE FROM share_items WHERE document_id=?', d.id);
  q.run('DELETE FROM documents WHERE id=?', d.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
  res.json({ ok: true });
});
r.get('/documents/:id/file', (req, res) => {
  const d = q.get('SELECT * FROM documents WHERE id=? AND patient_id=?', req.params.id, req.pid);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Disposition', 'inline; filename="' + (d.original_name || d.name).replace(/"/g, '') + '"');
  res.type(d.mime || 'application/octet-stream').sendFile(path.join(UPLOAD_DIR, d.stored_name));
});

/* ---------- sharing ---------- */
r.get('/sharing', (req, res) => {
  const reqs = q.all(`SELECT r.*, c.name AS clinic_name, c.address AS clinic_address, d.name AS doctor_name, d.specialty, e.title AS episode_title FROM requests r JOIN clinics c ON c.id=r.clinic_id LEFT JOIN doctors d ON d.id=r.doctor_id LEFT JOIN episodes e ON e.id=r.episode_id WHERE r.patient_id=? AND r.status='pending' ORDER BY r.id DESC`, req.pid);
  const all = q.all(`SELECT s.*, c.name AS clinic_name, d.name AS doctor_name, e.title AS episode_title FROM shares s JOIN clinics c ON c.id=s.clinic_id LEFT JOIN doctors d ON d.id=s.doctor_id LEFT JOIN episodes e ON e.id=s.episode_id WHERE s.patient_id=? ORDER BY s.id DESC`, req.pid)
    .map(s => { const { docs, intake } = shareContents(s); return { ...s, docs: docs.map(d => ({ id: d.id, name: d.name })), intake: intake ? { id: intake.id, mode: intake.mode } : null }; });
  const logRows = q.all('SELECT * FROM access_log WHERE patient_id=? ORDER BY id DESC LIMIT 60', req.pid);
  res.json({ requests: reqs, active: all.filter(s => s.status === 'active'), ended: all.filter(s => s.status !== 'active'), log: logRows });
});
r.post('/requests/:id/decline', (req, res) => {
  const rq = q.get(`SELECT * FROM requests WHERE id=? AND patient_id=? AND status='pending'`, req.params.id, req.pid);
  if (!rq) return res.status(404).json({ error: 'Request not found' });
  q.run(`UPDATE requests SET status='declined', responded_at=datetime('now') WHERE id=?`, rq.id);
  q.run(`UPDATE queue SET status='declined' WHERE request_id=? AND status='waiting'`, rq.id);
  log(req.pid, null, 'You declined the request from ' + q.get('SELECT name FROM clinics WHERE id=?', rq.clinic_id).name);
  res.json({ ok: true });
});
/* Patient-initiated share (Share with a clinic modal). Clinic must accept before it enters the queue. */
r.post('/shares', (req, res) => {
  const b = req.body || {};
  const clinic = q.get('SELECT * FROM clinics WHERE id=?', b.clinic_id);
  const ep = q.get('SELECT * FROM episodes WHERE id=? AND patient_id=?', b.episode_id, req.pid);
  if (!clinic || !ep) return res.status(400).json({ error: 'Choose a clinic and a problem' });
  const docIds = (Array.isArray(b.document_ids) ? b.document_ids : []).map(Number)
    .filter(id => q.get('SELECT 1 FROM documents WHERE id=? AND patient_id=?', id, req.pid));
  const intake = b.intake_id ? q.get(`SELECT id FROM intakes WHERE id=? AND patient_id=? AND status='sent'`, b.intake_id, req.pid) : null;
  const sid = q.run('INSERT INTO shares(patient_id,clinic_id,episode_id,intake_id,include_profile,duration,expires_at,accepted) VALUES(?,?,?,?,?,?,?,0)',
    req.pid, clinic.id, ep.id, intake ? intake.id : null, b.include_profile === false ? 0 : 1, b.duration || '30d', expiryFor(b.duration || '30d')).lastInsertRowid;
  docIds.forEach(id => q.run('INSERT OR IGNORE INTO share_items(share_id,document_id) VALUES(?,?)', sid, id));
  log(req.pid, null, 'You shared ' + ep.title + ' with ' + clinic.name);
  res.json({ id: sid, items: docIds.length + (intake ? 1 : 0) });
});
r.post('/shares/:id/revoke', (req, res) => {
  const s = q.get('SELECT s.*, c.name AS clinic_name FROM shares s JOIN clinics c ON c.id=s.clinic_id WHERE s.id=? AND s.patient_id=?', req.params.id, req.pid);
  if (!s) return res.status(404).json({ error: 'Share not found' });
  q.run(`UPDATE shares SET status='revoked', ended_at=datetime('now') WHERE id=?`, s.id);
  q.run(`UPDATE queue SET status='seen', seen_at=COALESCE(seen_at, datetime('now')) WHERE share_id=? AND status IN ('waiting','with_doctor')`, s.id);
  log(req.pid, null, 'You revoked access for ' + s.clinic_name);
  res.json({ ok: true });
});
r.get('/clinics', (_req, res) => res.json(q.all('SELECT id, name, address, type FROM clinics ORDER BY name')));

module.exports = r;
module.exports.upload = upload;
module.exports.runExtraction = runExtraction;
