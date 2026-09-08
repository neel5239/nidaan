'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

/* DATA_DIR can point at a mounted volume in production (Railway/Render/Fly): DB + uploads live there */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'nidaan.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('patient','clinic','doctor')),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  reg_no TEXT, type TEXT, address TEXT, phone TEXT, email TEXT,
  specialties TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clinic_staff (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  title TEXT
);
CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  email TEXT,
  specialty TEXT,
  reg_no TEXT,
  hours_from TEXT DEFAULT '09:00', hours_to TEXT DEFAULT '17:00',
  status TEXT DEFAULT 'on_duty',
  paused INTEGER DEFAULT 0,
  invited INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  nid TEXT UNIQUE,
  age INTEGER, sex TEXT, phone TEXT, city TEXT,
  blood_group TEXT, allergies TEXT, conditions TEXT, medicines TEXT, emergency_contact TEXT
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  episode_id INTEGER REFERENCES episodes(id),
  uploaded_by INTEGER REFERENCES users(id),
  uploader_role TEXT DEFAULT 'patient',
  name TEXT NOT NULL,
  original_name TEXT,
  stored_name TEXT NOT NULL,
  mime TEXT, size INTEGER,
  doc_type TEXT, doc_date TEXT, issued_by TEXT,
  ocr_status TEXT DEFAULT 'pending',
  ocr_text TEXT,
  extracted TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER REFERENCES doctors(id),
  created_by INTEGER REFERENCES users(id),
  episode_id INTEGER REFERENCES episodes(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  intake_id INTEGER,
  share_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE TABLE IF NOT EXISTS intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  episode_id INTEGER REFERENCES episodes(id),
  request_id INTEGER REFERENCES requests(id),
  mode TEXT DEFAULT 'text',
  answers TEXT DEFAULT '[]',
  pain INTEGER,
  urgent TEXT DEFAULT '[]',
  urgent_options TEXT,
  complaint_done INTEGER DEFAULT 0,
  has_reports INTEGER,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  doctor_id INTEGER REFERENCES doctors(id),
  episode_id INTEGER REFERENCES episodes(id),
  intake_id INTEGER REFERENCES intakes(id),
  request_id INTEGER REFERENCES requests(id),
  include_profile INTEGER DEFAULT 1,
  duration TEXT DEFAULT 'visit',
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  accepted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS share_items (
  share_id INTEGER NOT NULL REFERENCES shares(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  PRIMARY KEY (share_id, document_id)
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER REFERENCES doctors(id),
  request_id INTEGER REFERENCES requests(id),
  share_id INTEGER REFERENCES shares(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  arrived_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at TEXT, started_at TEXT, seen_at TEXT,
  vitals TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  queue_id INTEGER REFERENCES queue(id),
  text TEXT DEFAULT '',
  outcome TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  clinic_name TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* migrations for databases created before a column existed */
try { db.exec('ALTER TABLE intakes ADD COLUMN complaint_done INTEGER DEFAULT 0'); } catch {}

/* ---------- seed: demo logins only, no demo data ---------- */
function seed() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return;
  const hash = (p) => bcrypt.hashSync(p, 8);
  const insUser = db.prepare('INSERT INTO users(role,email,password_hash,name) VALUES(?,?,?,?)');

  const clinicId = db.prepare(`INSERT INTO clinics(name,reg_no,type,address,phone,email,specialties) VALUES(?,?,?,?,?,?,?)`)
    .run('Arogya Multispeciality', 'MH/PUN/2026/04417', 'Multispeciality clinic',
      'Plot 14, Bhandarkar Road, Deccan Gymkhana, Pune 411004', '+91 20 2567 1190', 'admin@arogya.clinic',
      JSON.stringify(['General medicine', 'Orthopaedics', 'Dermatology'])).lastInsertRowid;

  const staff = [
    ['frontdesk@arogya.clinic', 'clinic123', 'Priya Deshmukh', 'Front desk'],
    ['admin@arogya.clinic', 'clinic123', 'Dr. R. Kulkarni', 'Admin']
  ];
  const insStaff = db.prepare('INSERT INTO clinic_staff(user_id,clinic_id,title) VALUES(?,?,?)');
  for (const [em, pw, nm, title] of staff) {
    const uid = insUser.run('clinic', em, hash(pw), nm).lastInsertRowid;
    insStaff.run(uid, clinicId, title);
  }

  const docs = [
    ['vikram.sethi@arogya.clinic', 'doctor123', 'Dr. Vikram Sethi', 'General physician', 'MMC 2008/11920', '09:00', '17:00'],
    ['anjali.rao@arogya.clinic', 'doctor123', 'Dr. Anjali Rao', 'Orthopaedics', 'MMC 2011/04471', '10:00', '14:00'],
    ['meera.iyer@arogya.clinic', 'doctor123', 'Dr. Meera Iyer', 'Dermatology', 'MMC 2015/00318', '09:30', '13:30']
  ];
  const insDoc = db.prepare('INSERT INTO doctors(user_id,clinic_id,name,email,specialty,reg_no,hours_from,hours_to) VALUES(?,?,?,?,?,?,?,?)');
  for (const [em, pw, nm, sp, reg, hf, ht] of docs) {
    const uid = insUser.run('doctor', em, hash(pw), nm).lastInsertRowid;
    insDoc.run(uid, clinicId, nm, em, sp, reg, hf, ht);
  }

  const pats = [
    ['rohan.mehta@gmail.com', 'patient123', 'Rohan Mehta', 'NID-2041-7783', 34, 'M', '9822012345', 'Pune'],
    ['sunita.pawar@gmail.com', 'patient123', 'Sunita Pawar', 'NID-1187-2290', 58, 'F', '9822098765', 'Pune'],
    ['kavita.joshi@gmail.com', 'patient123', 'Kavita Joshi', 'NID-3320-0451', 45, 'F', '9822055555', 'Pune']
  ];
  const insPat = db.prepare('INSERT INTO patients(user_id,nid,age,sex,phone,city) VALUES(?,?,?,?,?,?)');
  for (const [em, pw, nm, nid, age, sex, ph, city] of pats) {
    const uid = insUser.run('patient', em, hash(pw), nm).lastInsertRowid;
    insPat.run(uid, nid, age, sex, ph, city);
  }
  console.log('[db] seeded demo logins (no demo data)');
}
seed();

/* ---------- tiny helpers ---------- */
/* node:sqlite refuses undefined/objects as bind values: normalise to null / numbers / strings */
const bind = (p) => p.map(v => v === undefined || Number.isNaN(v) ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
const q = {
  get: (sql, ...p) => db.prepare(sql).get(...bind(p)),
  all: (sql, ...p) => db.prepare(sql).all(...bind(p)),
  run: (sql, ...p) => db.prepare(sql).run(...bind(p))
};
function json(v, d) { if (v == null || v === '') return d; try { return JSON.parse(v); } catch { return d; } }
function log(patient_id, actor, action) {
  q.run('INSERT INTO access_log(patient_id,actor_id,actor_name,clinic_name,action) VALUES(?,?,?,?,?)',
    patient_id, actor?.id || null, actor?.name || 'You', actor?.clinic_name || null, action);
}

module.exports = { db, q, json, log, UPLOAD_DIR, DATA_DIR };
