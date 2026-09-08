'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { q, json, log, UPLOAD_DIR } = require('../db');
const { auth, initials } = require('../auth');
const { expireShares, flagCounts, shareContents, intakeView, docView } = require('../lib');
const { upload, runExtraction } = require('./patient');

const r = express.Router();
r.use(auth(['doctor']));
r.use((req, _res, next) => { expireShares(); req.did = req.user.doctor_id; req.actor = { id: req.user.id, name: req.user.name, clinic_name: req.user.clinic_name }; next(); });

const patientRow = (pid) => q.get('SELECT p.*, u.name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=?', pid);

/* A doctor sees a queue entry only while it is assigned to them AND its share is active. */
function visible(e) {
  const share = e.share_id ? q.get('SELECT * FROM shares WHERE id=?', e.share_id) : null;
  return { share, active: !!(share && share.status === 'active') };
}

function card(e) {
  const p = patientRow(e.patient_id);
  const { share, active } = visible(e);
  const fc = flagCounts(active ? share : null);
  let intake = null, one = '', flags = [], meta = '';
  if (active) {
    const c = shareContents(share);
    intake = c.intake;
    one = intake?.summary?.one_liner || intake?.summary?.title || '';
    flags = [...(intake?.summary?.red_flags || []), ...c.docs.flatMap(d => d.flags)];
    meta = 'Shared: ' + [intake ? 'intake' : null, c.docs.length ? c.docs.length + ' report' + (c.docs.length > 1 ? 's' : '') : null, share.include_profile ? 'profile basics' : null].filter(Boolean).join(' + ') + ' · ' + (share.expires_at ? 'until ' + share.expires_at.slice(0, 10) : share.duration === 'revoke' ? 'until revoked' : 'this visit');
  } else meta = share ? 'Share ' + share.status : 'No intake or records shared yet';
  const waitMin = Math.max(0, Math.round((Date.now() - new Date(e.arrived_at.replace(' ', 'T') + 'Z').getTime()) / 60000));
  return { id: e.id, status: e.status, wait_min: waitMin, arrived_at: e.arrived_at, seen_at: e.seen_at, note: e.note, patient: { id: p.id, name: p.name, nid: p.nid, age: p.age, sex: p.sex, ini: initials(p.name) }, complaint: one, meta, flags: flags.slice(0, 6), flag_counts: fc, has_share: active, vitals: json(e.vitals, null) };
}

r.get('/queue', (req, res) => {
  const rows = q.all(`SELECT * FROM queue WHERE doctor_id=? AND date(arrived_at,'localtime')=date('now','localtime') AND status!='declined' ORDER BY (status='seen'), arrived_at`, req.did).map(card);
  rows.sort((a, b) => (a.status === 'seen') - (b.status === 'seen') || b.flag_counts.crit - a.flag_counts.crit || a.arrived_at.localeCompare(b.arrived_at));
  const waiting = rows.filter(x => x.status === 'waiting');
  res.json({ queue: rows, kpi: { seen: rows.filter(x => x.status === 'seen').length, total: rows.length, waiting: waiting.length, longest: waiting.length ? Math.max(...waiting.map(x => x.wait_min)) : 0, flagged: rows.filter(x => x.flag_counts.crit > 0 && x.status !== 'seen').length }, paused: req.user.paused });
});

r.get('/queue/:id', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  const p = patientRow(e.patient_id);
  const { share, active } = visible(e);
  const base = { queue: card(e), patient: { id: p.id, name: p.name, nid: p.nid, age: p.age, sex: p.sex, city: p.city, ini: initials(p.name) } };
  const note = q.get('SELECT * FROM notes WHERE doctor_id=? AND queue_id=?', req.did, e.id);
  if (!active) return res.json({ ...base, share: share ? { status: share.status } : null, intake: null, previous_intakes: [], documents: [], profile: null, note });
  const c = shareContents(share);
  const prev = share.episode_id ? q.all(`SELECT i.*, d.name AS doctor_name FROM intakes i LEFT JOIN requests r ON r.id=i.request_id LEFT JOIN doctors d ON d.id=r.doctor_id WHERE i.episode_id=? AND i.status='sent' AND i.id!=? ORDER BY i.id DESC`, share.episode_id, share.intake_id || -1).map(i => ({ ...intakeView(i), doctor_name: i.doctor_name })) : [];
  const ep = share.episode_id ? q.get('SELECT * FROM episodes WHERE id=?', share.episode_id) : null;
  log(p.id, req.actor, `${req.user.name} opened ${c.intake ? 'intake summary' : 'shared records'}`);
  res.json({
    ...base,
    share: { id: share.id, status: share.status, expires_at: share.expires_at, duration: share.duration, created_at: share.created_at, episode_title: ep?.title || c.intake?.summary?.title || '', assigned_at: e.assigned_at },
    intake: c.intake, previous_intakes: prev, documents: c.docs,
    profile: share.include_profile ? { blood_group: p.blood_group, allergies: p.allergies, conditions: p.conditions, medicines: p.medicines, emergency_contact: p.emergency_contact } : null,
    episode_history: ep ? q.all(`SELECT e.title, e.status, e.started_at, (SELECT COUNT(*) FROM intakes i WHERE i.episode_id=e.id AND i.status='sent') AS intakes FROM episodes e WHERE e.patient_id=? ORDER BY e.started_at DESC`, p.id).map(x => ({ ...x, shared: x.title === ep.title })) : [],
    note
  });
});

r.post('/queue/:id/start', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  q.run(`UPDATE queue SET status='with_doctor', started_at=COALESCE(started_at, datetime('now')) WHERE id=?`, e.id);
  res.json(card(q.get('SELECT * FROM queue WHERE id=?', e.id)));
});
r.post('/queue/:id/seen', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  q.run(`UPDATE queue SET status='seen', seen_at=datetime('now') WHERE id=?`, e.id);
  if (e.share_id) {
    const sh = q.get('SELECT * FROM shares WHERE id=?', e.share_id);
    if (sh && sh.status === 'active' && sh.duration === 'visit') { q.run(`UPDATE shares SET status='expired', ended_at=datetime('now') WHERE id=?`, sh.id); log(e.patient_id, req.actor, 'Visit closed · share with ' + req.user.clinic_name + ' ended'); }
  }
  res.json(card(q.get('SELECT * FROM queue WHERE id=?', e.id)));
});

r.put('/queue/:id/notes', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  const text = String(req.body?.text || ''), outcome = req.body?.outcome || null;
  const n = q.get('SELECT id FROM notes WHERE doctor_id=? AND queue_id=?', req.did, e.id);
  if (n) q.run(`UPDATE notes SET text=?, outcome=COALESCE(?,outcome), updated_at=datetime('now') WHERE id=?`, text, outcome, n.id);
  else q.run('INSERT INTO notes(doctor_id,patient_id,queue_id,text,outcome) VALUES(?,?,?,?,?)', req.did, e.patient_id, e.id, text, outcome);
  res.json({ ok: true, updated_at: new Date().toISOString() });
});

/* Vitals can be recorded by the doctor too. */
r.post('/queue/:id/vitals', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  const v = req.body || {};
  q.run('UPDATE queue SET vitals=? WHERE id=?', JSON.stringify({ bp: v.bp || '', pulse: v.pulse || '', spo2: v.spo2 || '', temp: v.temp || '' }), e.id);
  res.json({ ok: true });
});

/* Upload a prescription / summary into the patient's episode (patient sees it in the vault). */
r.post('/queue/:id/prescription', upload.single('file'), async (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND doctor_id=?', req.params.id, req.did);
  if (!e) return res.status(404).json({ error: 'Not assigned to you' });
  const { share, active } = visible(e);
  if (!active) return res.status(400).json({ error: 'Share is not active' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const f = req.file;
  const name = (req.body?.name || 'Prescription — ' + req.user.name).trim();
  const id = q.run(`INSERT INTO documents(patient_id,episode_id,uploaded_by,uploader_role,name,original_name,stored_name,mime,size,doc_type,doc_date,issued_by,ocr_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'done')`,
    e.patient_id, share.episode_id, req.user.id, 'doctor', name, f.originalname, f.filename, f.mimetype, f.size, 'Prescription', new Date().toISOString().slice(0, 10), req.user.clinic_name).lastInsertRowid;
  const p = patientRow(e.patient_id);
  runExtraction(id, f.path, f.mimetype, f.originalname, p).catch(() => {});
  q.run('INSERT OR IGNORE INTO share_items(share_id,document_id) VALUES(?,?)', share.id, id);
  log(e.patient_id, req.actor, `${req.user.name} uploaded ${name} to your record`);
  const n = q.get('SELECT id FROM notes WHERE doctor_id=? AND queue_id=?', req.did, e.id);
  if (n) q.run('UPDATE notes SET outcome=COALESCE(outcome, ?) WHERE id=?', 'Prescription uploaded', n.id);
  else q.run('INSERT INTO notes(doctor_id,patient_id,queue_id,text,outcome) VALUES(?,?,?,?,?)', req.did, e.patient_id, e.id, '', 'Prescription uploaded');
  res.json(docView(q.get('SELECT * FROM documents WHERE id=?', id)));
});

r.get('/documents/:id/file', (req, res) => {
  const d = q.get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const ok = q.get(`SELECT 1 FROM share_items si JOIN shares s ON s.id=si.share_id WHERE si.document_id=? AND s.doctor_id=? AND s.status='active'`, d.id, req.did);
  if (!ok) return res.status(403).json({ error: 'This document is not shared with you' });
  log(d.patient_id, req.actor, `${req.user.name} opened ${d.name}`);
  res.setHeader('Content-Disposition', 'inline; filename="' + (d.original_name || d.name).replace(/"/g, '') + '"');
  res.type(d.mime || 'application/octet-stream').sendFile(path.join(UPLOAD_DIR, d.stored_name));
});

r.get('/history', (req, res) => {
  const rows = q.all(`SELECT qe.*, u.name AS patient_name, p.age, p.sex FROM queue qe JOIN patients p ON p.id=qe.patient_id JOIN users u ON u.id=p.user_id WHERE qe.doctor_id=? AND qe.status='seen' ORDER BY qe.seen_at DESC LIMIT 100`, req.did)
    .map(e => { const { share, active } = visible(e); const n = q.get('SELECT * FROM notes WHERE doctor_id=? AND queue_id=?', req.did, e.id); const c = active ? shareContents(share) : null; return { id: e.id, seen_at: e.seen_at, patient: { name: e.patient_name, age: e.age, sex: e.sex }, complaint: c?.intake?.summary?.one_liner || (share ? json(q.get('SELECT summary FROM intakes WHERE id=?', share.intake_id || -1)?.summary, {})?.one_liner : '') || '—', share_status: share ? (active ? 'active' : share.status) : 'none', expires_at: share?.expires_at, outcome: n?.outcome || (n?.text ? 'Notes saved' : '—'), note: n?.text || '' }; });
  res.json(rows);
});
r.post('/pause', (req, res) => {
  const v = req.body?.paused ? 1 : 0;
  q.run('UPDATE doctors SET paused=? WHERE id=?', v, req.did);
  res.json({ paused: !!v });
});

module.exports = r;
