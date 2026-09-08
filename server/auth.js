'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const SECRET = process.env.JWT_SECRET || 'nidaan-dev-secret';

function initials(name) {
  return name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

/* Build the session user object that the front end shows in the sidebar. */
function profileFor(user) {
  const base = { id: user.id, role: user.role, email: user.email, name: user.name, ini: initials(user.name) };
  if (user.role === 'patient') {
    const p = q.get('SELECT * FROM patients WHERE user_id=?', user.id);
    return { ...base, patient_id: p.id, nid: p.nid, sub: `${p.age || '—'} ${p.sex || ''} · ${p.nid}`.trim(), hello: 'Welcome back, ' + user.name.split(' ')[0] };
  }
  if (user.role === 'clinic') {
    const s = q.get('SELECT cs.*, c.name AS clinic_name, c.reg_no FROM clinic_staff cs JOIN clinics c ON c.id=cs.clinic_id WHERE cs.user_id=?', user.id);
    return { ...base, clinic_id: s.clinic_id, clinic_name: s.clinic_name, reg_no: s.reg_no, title: s.title, display: s.clinic_name, sub: `${user.name} · ${s.title}`, ini: initials(s.clinic_name), hello: `Signed in · ${s.clinic_name} ${s.title.toLowerCase()}` };
  }
  const d = q.get('SELECT d.*, c.name AS clinic_name FROM doctors d JOIN clinics c ON c.id=d.clinic_id WHERE d.user_id=?', user.id);
  return { ...base, doctor_id: d.id, clinic_id: d.clinic_id, clinic_name: d.clinic_name, specialty: d.specialty, hours_from: d.hours_from, hours_to: d.hours_to, paused: !!d.paused, sub: `${d.specialty} · ${d.clinic_name}`, hello: 'Signed in · ' + user.name };
}

function login(req, res) {
  const { role, email, password } = req.body || {};
  if (!role || !email || !password) return res.status(400).json({ error: 'role, email and password are required' });
  const u = q.get('SELECT * FROM users WHERE email=? AND role=?', String(email).trim().toLowerCase(), role);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Email or password does not match this role.' });
  const token = jwt.sign({ uid: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: profileFor(u) });
}

function auth(roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    try {
      const { uid } = jwt.verify(token, SECRET);
      const u = q.get('SELECT * FROM users WHERE id=?', uid);
      if (!u) throw new Error('no user');
      if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed for this role' });
      req.user = profileFor(u);
      next();
    } catch {
      res.status(401).json({ error: 'Please sign in again' });
    }
  };
}

module.exports = { login, auth, initials };
