# Nidaan – working prototype (front end + back end)

Three-portal health-record app. The UI is the original prototype; every screen now reads and writes a real
database through the API in `server/`. There is **no demo data** – only the eight demo logins are seeded.
Everything else (episodes, reports, intakes, shares, queue, notes) is created live as you use it.

## Run

```bash
npm install
npm start
```

Open <http://localhost:3000>. Needs Node 22.13+ (uses the built-in `node:sqlite`).

`.env` (copy from `.env.example`):

| Key | Meaning |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key used by the language module |
| `GEMINI_MODEL` | primary model (`gemini-3.5-flash-lite`, ~1 s per question) |
| `GEMINI_FALLBACKS` | comma list tried when the primary is overloaded / times out |
| `TESSERACT_BIN` | optional path to a system Tesseract; otherwise `tesseract.js` is used |
| `JWT_SECRET` | session signing secret |

Wipe all data and start again (demo logins are re-seeded on next start):

```bash
npm run reset-db
```

## Demo logins

| Role    | Email                        | Password   |
|---------|------------------------------|------------|
| Patient | rohan.mehta@gmail.com        | patient123 |
| Patient | sunita.pawar@gmail.com       | patient123 |
| Patient | kavita.joshi@gmail.com       | patient123 |
| Clinic  | frontdesk@arogya.clinic      | clinic123  |
| Clinic  | admin@arogya.clinic          | clinic123  |
| Doctor  | vikram.sethi@arogya.clinic   | doctor123  |
| Doctor  | anjali.rao@arogya.clinic     | doctor123  |
| Doctor  | meera.iyer@arogya.clinic     | doctor123  |

## End-to-end flow

1. **Clinic** → *Patient arrived* → search the patient (name / Nidaan ID / phone / email) → *Add to queue and assign* → pick a doctor.
   This creates a queue entry and sends the patient an **intake request**.
2. **Patient** → *Sharing → Requests* (or the banner on My health) → *Open request*.
   - Choose **Speak** (question is read aloud with the Web Speech API, answer is transcribed live; browsers without
     speech recognition record audio and Gemini transcribes it) or **Type**.
   - Questions come one at a time from Gemini: first "what is troubling you", then 5–7 follow-ups that depend on the
     answers (site, since when, severity 0–10, associated symptoms, previous episodes, medicines/allergies).
   - Then **Dashavidha Pariksha** (Ayurvedic tenfold examination), the six patient-answerable items in fixed order:
     Prakriti, Ahara-shakti, Vyayama-shakti, Satmya, Sattva, Pramana. Sara and Vikriti are left for the doctor's
     examination. The list lives in `DASHAVIDHA` in `server/gemini.js`.
   - Complaint-specific **urgent signs** checklist, then *Previous reports?* → Yes opens the report picker: tick
     existing documents or upload a new one (OCR + extraction run immediately).
   - *Review and send* shows the Gemini summary, red flags and the "for reference only" note. **Send** creates the
     share to that clinic + doctor.
3. **Doctor** → *My patients today* shows the patient with red-flag chips → open → **Intake summary** (with a
   Dashavidha Pariksha block: Prakriti, Vikriti to consider, Sara, Samhanana, Pramana, Satmya, Sattva, Ahara-shakti,
   Vyayama-shakti, Vaya), **Red flags**
   (from answers and from OCR'd reports), **For your consideration** (1–2 areas to examine, never a diagnosis),
   **Shared reports** (values with high/low chips, original file opens), **Medicines & history** (profile basics),
   **My notes** (autosave) and *Upload prescription to patient*. *Mark as seen* closes a "this visit" share.
4. **Patient** sees the prescription in the episode, the share in *Ended*, and every access in the **Access log**.

Patients can also start a share themselves (*Share with a clinic*); it appears under the clinic's *Share requests*
until the front desk accepts it into the queue. Reports can be uploaded any time from *Upload a report*; the OCR
result ("We read these values") is shown for confirmation before saving.

## Architecture

```
server/
  index.js          Express app, static hosting of the UI, /api routes
  db.js             SQLite schema (node:sqlite) + seed of the demo logins
  auth.js           bcrypt passwords, JWT sessions, per-role profiles
  ocr.js            OCR module: pdf-parse for PDFs, Tesseract (system or tesseract.js) for images
  gemini.js         Language module: next question, urgent signs, intake summary, document extraction, STT fallback
  lib.js            share expiry, red-flag counting, view helpers
  routes/patient.js episodes, documents (upload → OCR → extraction → confirm), sharing, access log
  routes/intake.js  request-driven questionnaire, preview, send
  routes/clinic.js  today queue, arrive/assign, share requests, patients, doctors, registration
  routes/doctor.js  assigned queue, patient detail, notes, vitals, prescription upload, history
data/               nidaan.db + uploads/ (created on first run, git-ignored)
index.html, css/, js/app.js   the UI (API-driven)
```

Access rules enforced by the API: a doctor sees a patient only while a queue entry is assigned to them **and** the
share is active; the front desk sees only share summaries (counts, names, dates), never document contents or answers;
patients see the access log of every open.

## Notes

- Documents: PDF text is read locally; scanned PDFs and photos are also sent to Gemini inline so values are still
  extracted. Everything extracted is stored in `documents.extracted` (values, red flags, summary).
- The summary/considerations are explicitly framed as *not a diagnosis* in the prompts and the UI.
- Rotate the Gemini key if it has been shared anywhere; the app reads it only from `.env`.
