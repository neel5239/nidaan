'use strict';
const { q, json } = require('./db');

/* Expire time-boxed shares lazily on every request. */
function expireShares() {
  q.run(`UPDATE shares SET status='expired', ended_at=datetime('now') WHERE status='active' AND expires_at IS NOT NULL AND expires_at < datetime('now')`);
}

function expiryFor(duration) {
  if (duration === '30d') return q.get(`SELECT datetime('now','+30 days') AS t`).t;
  if (duration === 'revoke') return null;
  return null; /* 'visit': ends when the queue entry is marked seen */
}

function docView(d) {
  const ex = json(d.extracted, null);
  return {
    id: d.id, episode_id: d.episode_id, name: d.name, original_name: d.original_name, mime: d.mime, size: d.size,
    doc_type: d.doc_type, doc_date: d.doc_date, issued_by: d.issued_by, uploader_role: d.uploader_role,
    ocr_status: d.ocr_status, created_at: d.created_at,
    th: thumbLabel(d), extracted: ex,
    flags: ex ? (ex.red_flags || []) : [],
    flag_count: ex ? (ex.red_flags || []).length : 0
  };
}
function thumbLabel(d) {
  if (d.doc_type === 'Prescription') return 'RX';
  if (/pdf/i.test(d.mime || '')) return 'PDF';
  if (/^image\//i.test(d.mime || '')) return 'IMG';
  return 'DOC';
}

function intakeView(i) {
  return {
    id: i.id, episode_id: i.episode_id, request_id: i.request_id, mode: i.mode, pain: i.pain,
    answers: json(i.answers, []), urgent: json(i.urgent, []), urgent_options: json(i.urgent_options, []),
    has_reports: i.has_reports, summary: json(i.summary, null), status: i.status, created_at: i.created_at, sent_at: i.sent_at
  };
}

/* Documents + intake attached to a share. */
function shareContents(share) {
  const docs = q.all('SELECT d.* FROM share_items si JOIN documents d ON d.id=si.document_id WHERE si.share_id=? ORDER BY d.doc_date DESC, d.id DESC', share.id).map(docView);
  const intake = share.intake_id ? intakeView(q.get('SELECT * FROM intakes WHERE id=?', share.intake_id)) : null;
  return { docs, intake };
}

/* Count red flags across intake + shared documents. */
function flagCounts(share) {
  if (!share) return { crit: 0, warn: 0, total: 0, has_intake: false, docs: 0 };
  const { docs, intake } = shareContents(share);
  let crit = 0, warn = 0;
  const add = (f) => { if (f.level === 'crit') crit++; else warn++; };
  if (intake && intake.summary) (intake.summary.red_flags || []).forEach(add);
  docs.forEach(d => d.flags.forEach(add));
  return { crit, warn, total: crit + warn, has_intake: !!intake, docs: docs.length };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.length === 19 ? 'Z' : ''));
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

module.exports = { expireShares, expiryFor, docView, intakeView, shareContents, flagCounts, fmtDate };
