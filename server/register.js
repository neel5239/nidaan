'use strict';
/* Self-registration: patients, clinics (creates the admin login) and doctors joining a clinic with its registration number. */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q } = require('./db');

const SECRET = process.env.JWT_SECRET || 'nidaan-dev-secret';
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clean = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);

function newNid() {
  for (let i = 0; i < 50; i++) {
    const nid = 'NID-' + String(1000 + Math.floor(Math.random() * 9000)) + '-' + String(1000 + Math.floor(Math.random() * 9000));
    if (!q.get('SELECT 1 FROM patients WHERE nid=?', nid)) return nid;
  }
  return 'NID-' + Date.now().toString().slice(-8, -4) + '-' + Date.now().toString().slice(-4);
}

function validateAccount(b) {
  const email = clean(b.email).toLowerCase(), password = String(b.password || ''), name = clean(b.name, 80);
  if (!name) return 'Full name is required';
  if (!emailOk(email)) return 'Enter a valid email address';
  if (password.length < 6) return 'Password must be at least 6 characters';
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) return 'An account with this email already exists. Sign in instead.';
  return null;
}

function issue(res, uid, profileFor) {
  const u = q.get('SELECT * FROM users WHERE id=?', uid);
  const token = jwt.sign({ uid: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: profileFor(u) });
}

module.exports = function (profileFor) {
  return {
    patient(req, res) {
      const b = req.body || {};
      const err = validateAccount(b); if (err) return res.status(400).json({ error: err });
      const uid = q.run('INSERT INTO users(role,email,password_hash,name) VALUES(?,?,?,?)', 'patient', clean(b.email).toLowerCase(), bcrypt.hashSync(String(b.password), 8), clean(b.name, 80)).lastInsertRowid;
      q.run('INSERT INTO patients(user_id,nid,age,sex,phone,city,blood_group,allergies,conditions,medicines,emergency_contact) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        uid, newNid(), b.age ? Number(b.age) : null, clean(b.sex, 10) || null, clean(b.phone, 20) || null, clean(b.city, 60) || null,
        clean(b.blood_group, 10) || null, clean(b.allergies) || null, clean(b.conditions) || null, clean(b.medicines) || null, clean(b.emergency_contact) || null);
      issue(res, uid, profileFor);
    },
    clinic(req, res) {
      const b = req.body || {};
      const err = validateAccount(b); if (err) return res.status(400).json({ error: err });
      const clinicName = clean(b.clinic_name, 100), regNo = clean(b.reg_no, 60);
      if (!clinicName) return res.status(400).json({ error: 'Clinic name is required' });
      if (!regNo) return res.status(400).json({ error: 'Clinic registration number is required (doctors use it to join)' });
      if (q.get('SELECT 1 FROM clinics WHERE reg_no=?', regNo)) return res.status(400).json({ error: 'A clinic with this registration number is already registered' });
      const cid = q.run('INSERT INTO clinics(name,reg_no,type,address,phone,email,specialties) VALUES(?,?,?,?,?,?,?)',
        clinicName, regNo, clean(b.type, 40) || 'Single-doctor clinic', clean(b.address, 200) || null, clean(b.phone, 20) || null, clean(b.email).toLowerCase(),
        JSON.stringify(clean(b.specialties, 300).split(',').map(s => s.trim()).filter(Boolean))).lastInsertRowid;
      const uid = q.run('INSERT INTO users(role,email,password_hash,name) VALUES(?,?,?,?)', 'clinic', clean(b.email).toLowerCase(), bcrypt.hashSync(String(b.password), 8), clean(b.name, 80)).lastInsertRowid;
      q.run('INSERT INTO clinic_staff(user_id,clinic_id,title) VALUES(?,?,?)', uid, cid, clean(b.title, 40) || 'Admin');
      issue(res, uid, profileFor);
    },
    doctor(req, res) {
      const b = req.body || {};
      const err = validateAccount(b); if (err) return res.status(400).json({ error: err });
      const clinic = q.get('SELECT * FROM clinics WHERE reg_no=?', clean(b.clinic_reg_no, 60));
      if (!clinic) return res.status(400).json({ error: 'No clinic found with that registration number. Ask your clinic admin for it.' });
      const uid = q.run('INSERT INTO users(role,email,password_hash,name) VALUES(?,?,?,?)', 'doctor', clean(b.email).toLowerCase(), bcrypt.hashSync(String(b.password), 8), clean(b.name, 80)).lastInsertRowid;
      q.run('INSERT INTO doctors(user_id,clinic_id,name,email,specialty,reg_no,hours_from,hours_to) VALUES(?,?,?,?,?,?,?,?)',
        uid, clinic.id, clean(b.name, 80), clean(b.email).toLowerCase(), clean(b.specialty, 60) || 'General physician', clean(b.reg_no, 60) || null, clean(b.hours_from, 5) || '09:00', clean(b.hours_to, 5) || '17:00');
      issue(res, uid, profileFor);
    },
    /* clinic list for the doctor join form (name + masked reg no) */
    clinics(_req, res) { res.json(q.all('SELECT id, name, address FROM clinics ORDER BY name')); }
  };
};
