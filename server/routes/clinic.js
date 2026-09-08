'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, json, log } = require('../db');
const { auth, initials } = require('../auth');
const { expireShares, flagCounts, shareContents } = require('../lib');

const r = express.Router();
r.use(auth(['clinic']));
r.use((req, _res, next) => { expireShares(); req.cid = req.user.clinic_id; req.actor = { id: req.user.id, name: 'Front desk (' + req.user.name + ')', clinic_name: req.user.clinic_name }; next(); });

const patientRow = (pid) => q.get('SELECT p.*, u.name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE p.id=?', pid);
const pubPatient = (p) => ({ id: p.id, name: p.name, nid: p.nid, age: p.age, sex: p.sex, phone: p.phone ? p.phone.slice(0, 5) + ' xxxxx' : '', ini: initials(p.name) });

function queueRow(e) {
  const p = patientRow(e.patient_id);
  const share = e.share_id ? q.get('SELECT * FROM shares WHERE id=?', e.share_id) : null;
  const shareOk = share && share.status === 'active';
  const fc = flagCounts(shareOk ? share : null);
  const doctor = e.doctor_id ? q.get('SELECT * FROM doctors WHERE id=?', e.doctor_id) : null;
  const ep = share?.episode_id ? q.get('SELECT title FROM episodes WHERE id=?', share.episode_id) : null;
  const rq = e.request_id ? q.get('SELECT status FROM requests WHERE id=?', e.request_id) : null;
  const intakeTitle = shareOk && share.intake_id ? json(q.get('SELECT summary FROM intakes WHERE id=?', share.intake_id)?.summary, {})?.title : null;
  const waitMin = Math.max(0, Math.round((Date.now() - new Date(e.arrived_at.replace(' ', 'T') + 'Z').getTime()) / 60000));
  return {
    id: e.id, status: e.status, arrived_at: e.arrived_at, seen_at: e.seen_at, wait_min: waitMin, note: e.note,
    patient: pubPatient(p), doctor: doctor ? { id: doctor.id, name: doctor.name, specialty: doctor.specialty } : null,
    episode_title: ep?.title || intakeTitle || null, share: shareOk ? { id: share.id, expires_at: share.expires_at, duration: share.duration } : null,
    request_status: rq?.status || null, flags: fc, vitals: json(e.vitals, null)
  };
}

r.get('/today', (req, res) => {
  const rows = q.all(`SELECT * FROM queue WHERE clinic_id=? AND date(arrived_at,'localtime')=date('now','localtime') AND status!='declined' ORDER BY (status='seen'), arrived_at`, req.cid).map(queueRow);
  const docs = q.all('SELECT * FROM doctors WHERE clinic_id=?', req.cid);
  const onDuty = docs.filter(d => d.status === 'on_duty' && !d.paused).length;
  const seen = rows.filter(x => x.status === 'seen');
  const avgWait = seen.length ? Math.round(seen.reduce((a, x) => a + Math.max(0, (new Date((x.seen_at || x.arrived_at).replace(' ', 'T') + 'Z') - new Date(x.arrived_at.replace(' ', 'T') + 'Z')) / 60000), 0) / seen.length) : 0;
  res.json({
    kpi: { waiting: rows.filter(x => x.status === 'waiting').length, waiting_flagged: rows.filter(x => x.status === 'waiting' && x.flags.crit > 0).length, with_doctor: rows.filter(x => x.status === 'with_doctor').length, seen: seen.length, avg_wait: avgWait, on_duty: onDuty, doctors: docs.length },
    queue: rows,
    pending_shares: q.get(`SELECT COUNT(*) AS c FROM shares WHERE clinic_id=? AND status='active' AND accepted=0`, req.cid).c,
    pending_requests: q.get(`SELECT COUNT(*) AS c FROM requests WHERE clinic_id=? AND status='pending'`, req.cid).c
  });
});

/* Front desk looks a patient up by Nidaan ID, email, phone or name. */
r.get('/patients/search', (req, res) => {
  const s = '%' + String(req.query.q || '').trim() + '%';
  if (s.length < 4) return res.json([]);
  const rows = q.all(`SELECT p.*, u.name, u.email FROM patients p JOIN users u ON u.id=p.user_id WHERE u.name LIKE ? OR p.nid LIKE ? OR u.email LIKE ? OR p.phone LIKE ? LIMIT 8`, s, s, s, s);
  res.json(rows.map(p => {
    const sh = q.get(`SELECT s.*, e.title FROM shares s LEFT JOIN episodes e ON e.id=s.episode_id WHERE s.patient_id=? AND s.clinic_id=? AND s.status='active' ORDER BY s.id DESC LIMIT 1`, p.id, req.cid);
    const pend = q.get(`SELECT id FROM requests WHERE patient_id=? AND clinic_id=? AND status='pending'`, p.id, req.cid);
    return { ...pubPatient(p), active_share: sh ? { id: sh.id, episode: sh.title, expires_at: sh.expires_at } : null, pending_request: !!pend };
  }));
});

/* Patient arrived: create the queue entry + send the intake request to the patient (optionally already assigned). */
r.post('/arrive', (req, res) => {
  const b = req.body || {};
  const p = patientRow(b.patient_id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  const open = q.get(`SELECT id FROM queue WHERE clinic_id=? AND patient_id=? AND status IN ('waiting','with_doctor') AND date(arrived_at,'localtime')=date('now','localtime')`, req.cid, p.id);
  if (open) return res.status(400).json({ error: p.name + ' is already in today\'s queue' });
  const doctor = b.doctor_id ? q.get('SELECT * FROM doctors WHERE id=? AND clinic_id=?', b.doctor_id, req.cid) : null;
  const clinic = q.get('SELECT name FROM clinics WHERE id=?', req.cid);
  let shareId = null, reqId = null;
  if (b.share_id) { /* patient already shared (patient-initiated) – attach it */
    const sh = q.get(`SELECT * FROM shares WHERE id=? AND clinic_id=? AND patient_id=? AND status='active'`, b.share_id, req.cid, p.id);
    if (sh) { shareId = sh.id; q.run('UPDATE shares SET accepted=1, doctor_id=COALESCE(?,doctor_id) WHERE id=?', doctor?.id || null, sh.id); }
  }
  if (b.send_request !== false) {
    reqId = q.run('INSERT INTO requests(clinic_id,patient_id,doctor_id,created_by,note) VALUES(?,?,?,?,?)', req.cid, p.id, doctor?.id || null, req.user.id, b.note || null).lastInsertRowid;
  }
  const qid = q.run('INSERT INTO queue(clinic_id,patient_id,doctor_id,request_id,share_id,note,status,assigned_at) VALUES(?,?,?,?,?,?,?,?)',
    req.cid, p.id, doctor?.id || null, reqId, shareId, b.note || null, 'waiting', doctor ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null).lastInsertRowid;
  log(p.id, req.actor, (doctor ? `${clinic.name} assigned you to ${doctor.name}` : `${clinic.name} added you to today's queue`) + (reqId ? ' and sent an intake request' : ''));
  res.json({ queue: queueRow(q.get('SELECT * FROM queue WHERE id=?', qid)), request_id: reqId });
});

r.post('/queue/:id/assign', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND clinic_id=?', req.params.id, req.cid);
  if (!e) return res.status(404).json({ error: 'Queue entry not found' });
  const doctor = q.get('SELECT * FROM doctors WHERE id=? AND clinic_id=?', req.body?.doctor_id, req.cid);
  if (!doctor) return res.status(400).json({ error: 'Pick a doctor' });
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  q.run(`UPDATE queue SET doctor_id=?, note=COALESCE(?,note), assigned_at=?, status=CASE WHEN status='seen' THEN 'waiting' ELSE status END WHERE id=?`, doctor.id, req.body?.note || null, now, e.id);
  if (e.request_id) q.run(`UPDATE requests SET doctor_id=? WHERE id=? AND status='pending'`, doctor.id, e.request_id);
  else if (!e.share_id) { /* no request yet -> send one now */
    const rid = q.run('INSERT INTO requests(clinic_id,patient_id,doctor_id,created_by,note) VALUES(?,?,?,?,?)', req.cid, e.patient_id, doctor.id, req.user.id, req.body?.note || null).lastInsertRowid;
    q.run('UPDATE queue SET request_id=? WHERE id=?', rid, e.id);
  }
  if (e.share_id) q.run('UPDATE shares SET doctor_id=?, accepted=1 WHERE id=?', doctor.id, e.share_id);
  log(e.patient_id, req.actor, `${req.user.clinic_name} assigned you to ${doctor.name}`);
  res.json(queueRow(q.get('SELECT * FROM queue WHERE id=?', e.id)));
});

/* Share summary modal: counts only, never contents. */
r.get('/queue/:id/summary', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND clinic_id=?', req.params.id, req.cid);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const row = queueRow(e);
  let docs = [], intake = null, expires = null, profile = false;
  if (row.share) {
    const sh = q.get('SELECT * FROM shares WHERE id=?', row.share.id);
    const c = shareContents(sh);
    docs = c.docs.map(d => ({ name: d.name, date: d.doc_date, type: d.doc_type }));
    intake = c.intake ? { mode: c.intake.mode, sent_at: c.intake.sent_at, answers: c.intake.answers.length } : null;
    expires = sh.expires_at; profile = !!sh.include_profile;
    log(e.patient_id, req.actor, 'Front desk viewed share summary');
  }
  res.json({ ...row, docs, intake, expires_at: expires, include_profile: profile });
});

r.post('/queue/:id/vitals', (req, res) => {
  const e = q.get('SELECT * FROM queue WHERE id=? AND clinic_id=?', req.params.id, req.cid);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  q.run('UPDATE queue SET vitals=? WHERE id=?', JSON.stringify({ bp: v.bp || '', pulse: v.pulse || '', spo2: v.spo2 || '', temp: v.temp || '' }), e.id);
  res.json({ ok: true });
});

/* Patient-initiated shares waiting for the clinic. */
r.get('/requests', (req, res) => {
  const rows = q.all(`SELECT s.*, u.name AS patient_name, p.nid, p.age, p.sex, e.title AS episode_title FROM shares s JOIN patients p ON p.id=s.patient_id JOIN users u ON u.id=p.user_id LEFT JOIN episodes e ON e.id=s.episode_id WHERE s.clinic_id=? AND s.status='active' AND s.accepted=0 ORDER BY s.id DESC`, req.cid)
    .map(s => { const c = shareContents(s); return { id: s.id, patient: { id: s.patient_id, name: s.patient_name, nid: s.nid, age: s.age, sex: s.sex, ini: initials(s.patient_name) }, episode_title: s.episode_title, created_at: s.created_at, expires_at: s.expires_at, duration: s.duration, items: [...(c.intake ? ['Intake summary'] : []), ...c.docs.map(d => d.name + (d.doc_date ? ' · ' + d.doc_date : '')), ...(s.include_profile ? ['Profile basics'] : [])], flags: flagCounts(s) }; });
  const sent = q.all(`SELECT r.*, u.name AS patient_name, d.name AS doctor_name FROM requests r JOIN patients p ON p.id=r.patient_id JOIN users u ON u.id=p.user_id LEFT JOIN doctors d ON d.id=r.doctor_id WHERE r.clinic_id=? AND r.status='pending' ORDER BY r.id DESC`, req.cid);
  res.json({ incoming: rows, sent });
});
r.post('/shares/:id/accept', (req, res) => {
  const s = q.get(`SELECT * FROM shares WHERE id=? AND clinic_id=? AND status='active' AND accepted=0`, req.params.id, req.cid);
  if (!s) return res.status(404).json({ error: 'Share not found' });
  q.run('UPDATE shares SET accepted=1 WHERE id=?', s.id);
  const open = q.get(`SELECT id FROM queue WHERE clinic_id=? AND patient_id=? AND status IN ('waiting','with_doctor') AND date(arrived_at,'localtime')=date('now','localtime')`, req.cid, s.patient_id);
  let qid = open?.id;
  if (open) q.run('UPDATE queue SET share_id=? WHERE id=?', s.id, open.id);
  else qid = q.run('INSERT INTO queue(clinic_id,patient_id,share_id,status) VALUES(?,?,?,?)', req.cid, s.patient_id, s.id, 'waiting').lastInsertRowid;
  log(s.patient_id, req.actor, `${req.user.clinic_name} accepted your share and added you to today's queue`);
  res.json(queueRow(q.get('SELECT * FROM queue WHERE id=?', qid)));
});

/* Patients with an active share to this clinic. */
r.get('/patients', (req, res) => {
  const rows = q.all(`SELECT s.*, u.name AS patient_name, p.nid, p.age, p.sex, p.phone, e.title AS episode_title, d.name AS doctor_name FROM shares s JOIN patients p ON p.id=s.patient_id JOIN users u ON u.id=p.user_id LEFT JOIN episodes e ON e.id=s.episode_id LEFT JOIN doctors d ON d.id=s.doctor_id WHERE s.clinic_id=? AND s.status='active' ORDER BY s.id DESC`, req.cid)
    .map(s => { const c = shareContents(s); return { share_id: s.id, patient: pubPatient({ ...s, id: s.patient_id, name: s.patient_name }), episode_title: s.episode_title, has_intake: !!c.intake, doc_count: c.docs.length, include_profile: !!s.include_profile, expires_at: s.expires_at, duration: s.duration, doctor_name: s.doctor_name, accepted: !!s.accepted, queue: q.get(`SELECT id, status FROM queue WHERE share_id=? ORDER BY id DESC LIMIT 1`, s.id) }; });
  rows.forEach(r => { r.pending_request = !!q.get(`SELECT id FROM requests WHERE patient_id=? AND clinic_id=? AND status='pending'`, r.patient.id, req.cid); });
  /* previously shared: patients whose shares with this clinic have all ended - the front desk can request again */
  const activeIds = new Set(rows.map(r => r.patient.id));
  const ended = q.all(`SELECT s.patient_id, MAX(s.ended_at) AS ended_at, COUNT(*) AS n FROM shares s WHERE s.clinic_id=? AND s.status!='active' GROUP BY s.patient_id ORDER BY ended_at DESC`, req.cid)
    .filter(x => !activeIds.has(x.patient_id))
    .map(x => {
      const p = patientRow(x.patient_id);
      const last = q.get(`SELECT s.*, e.title AS episode_title, d.name AS doctor_name FROM shares s LEFT JOIN episodes e ON e.id=s.episode_id LEFT JOIN doctors d ON d.id=s.doctor_id WHERE s.clinic_id=? AND s.patient_id=? ORDER BY s.id DESC LIMIT 1`, req.cid, x.patient_id);
      return { patient: pubPatient(p), shares: x.n, ended_at: x.ended_at, last_episode: last?.episode_title || null, last_doctor: last?.doctor_name || null, last_status: last?.status || null,
        pending_request: !!q.get(`SELECT id FROM requests WHERE patient_id=? AND clinic_id=? AND status='pending'`, x.patient_id, req.cid) };
    });
  const expired = q.get(`SELECT COUNT(*) AS c FROM shares WHERE clinic_id=? AND status!='active'`, req.cid).c;
  res.json({ patients: rows, ended, expired });
});

/* Request (again): send the patient a fresh intake request, optionally naming a doctor and a reason.
   When the patient answers, a new share to this clinic is created and the patient enters the queue. */
r.post('/patients/:id/request', (req, res) => {
  const p = patientRow(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  if (q.get(`SELECT id FROM requests WHERE patient_id=? AND clinic_id=? AND status='pending'`, p.id, req.cid)) return res.status(400).json({ error: p.name + ' already has an open request from this clinic' });
  const doctor = req.body?.doctor_id ? q.get('SELECT * FROM doctors WHERE id=? AND clinic_id=?', req.body.doctor_id, req.cid) : null;
  const note = String(req.body?.note || '').trim() || null;
  const rid = q.run('INSERT INTO requests(clinic_id,patient_id,doctor_id,created_by,note) VALUES(?,?,?,?,?)', req.cid, p.id, doctor?.id || null, req.user.id, note).lastInsertRowid;
  /* if the patient is already in today's queue without a request, attach it so the answers land on that visit */
  const open = q.get(`SELECT id FROM queue WHERE clinic_id=? AND patient_id=? AND status IN ('waiting','with_doctor') AND date(arrived_at,'localtime')=date('now','localtime') AND request_id IS NULL`, req.cid, p.id);
  if (open) q.run('UPDATE queue SET request_id=?, doctor_id=COALESCE(?,doctor_id) WHERE id=?', rid, doctor?.id || null, open.id);
  log(p.id, req.actor, `${req.user.clinic_name} sent you a new intake request` + (doctor ? ` for ${doctor.name}` : '') + (note ? ` · reason: ${note}` : ''));
  res.json({ request_id: rid, doctor: doctor ? { id: doctor.id, name: doctor.name } : null });
});

/* Doctors */
function doctorRow(d) {
  const load = q.get(`SELECT SUM(status='waiting') AS waiting, SUM(status='with_doctor') AS with_doc FROM queue WHERE doctor_id=? AND date(arrived_at,'localtime')=date('now','localtime')`, d.id);
  return { id: d.id, name: d.name, email: d.email, specialty: d.specialty, reg_no: d.reg_no, hours_from: d.hours_from, hours_to: d.hours_to, status: d.status, paused: !!d.paused, invited: !!d.invited, waiting: load.waiting || 0, with_doctor: load.with_doc || 0, has_login: !!d.user_id };
}
r.get('/doctors', (req, res) => res.json(q.all('SELECT * FROM doctors WHERE clinic_id=? ORDER BY id', req.cid).map(doctorRow)));
r.post('/doctors', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) return res.status(400).json({ error: 'That email already has a login' });
  const password = b.password || 'doctor123';
  const uid = q.run('INSERT INTO users(role,email,password_hash,name) VALUES(?,?,?,?)', 'doctor', email, bcrypt.hashSync(password, 8), name).lastInsertRowid;
  const id = q.run('INSERT INTO doctors(user_id,clinic_id,name,email,specialty,reg_no,hours_from,hours_to,invited) VALUES(?,?,?,?,?,?,?,?,1)', uid, req.cid, name, email, b.specialty || 'General physician', b.reg_no || null, b.hours_from || '09:00', b.hours_to || '17:00').lastInsertRowid;
  res.json({ ...doctorRow(q.get('SELECT * FROM doctors WHERE id=?', id)), password });
});
r.patch('/doctors/:id', (req, res) => {
  const d = q.get('SELECT * FROM doctors WHERE id=? AND clinic_id=?', req.params.id, req.cid);
  if (!d) return res.status(404).json({ error: 'Doctor not found' });
  const b = req.body || {};
  q.run('UPDATE doctors SET name=COALESCE(?,name), specialty=COALESCE(?,specialty), reg_no=COALESCE(?,reg_no), hours_from=COALESCE(?,hours_from), hours_to=COALESCE(?,hours_to), status=COALESCE(?,status) WHERE id=?',
    b.name || null, b.specialty || null, b.reg_no || null, b.hours_from || null, b.hours_to || null, b.status || null, d.id);
  if (b.name && d.user_id) q.run('UPDATE users SET name=? WHERE id=?', b.name, d.user_id);
  res.json(doctorRow(q.get('SELECT * FROM doctors WHERE id=?', d.id)));
});

/* Clinic profile / registration */
r.get('/profile', (req, res) => { const c = q.get('SELECT * FROM clinics WHERE id=?', req.cid); res.json({ ...c, specialties: json(c.specialties, []) }); });
r.put('/profile', (req, res) => {
  const b = req.body || {};
  q.run('UPDATE clinics SET name=COALESCE(?,name), reg_no=COALESCE(?,reg_no), type=COALESCE(?,type), address=COALESCE(?,address), phone=COALESCE(?,phone), email=COALESCE(?,email), specialties=COALESCE(?,specialties) WHERE id=?',
    b.name || null, b.reg_no || null, b.type || null, b.address || null, b.phone || null, b.email || null, Array.isArray(b.specialties) ? JSON.stringify(b.specialties) : null, req.cid);
  const c = q.get('SELECT * FROM clinics WHERE id=?', req.cid); res.json({ ...c, specialties: json(c.specialties, []) });
});

module.exports = r;
