'use strict';
/* Wipe all data (keeps nothing); demo logins are re-seeded on next start. */
const fs = require('fs');
const path = require('path');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
for (const f of ['nidaan.db', 'nidaan.db-wal', 'nidaan.db-shm']) { try { fs.unlinkSync(path.join(DATA, f)); } catch {} }
fs.rmSync(path.join(DATA, 'uploads'), { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
console.log('Database and uploads cleared. Start the server to re-seed demo logins.');
