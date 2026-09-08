'use strict';
/* Language module: thin wrapper over Gemini generateContent (REST, no SDK). */
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
/* Fallback chain: if the primary model is overloaded / times out, the next one is tried. */
const MODELS = [MODEL, ...(process.env.GEMINI_FALLBACKS || 'gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.6-flash').split(',').map(s => s.trim()).filter(Boolean)]
  .filter((m, i, a) => a.indexOf(m) === i);
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45000;

async function callModel(model, body) {
  const r = await fetch(`${BASE}/${model}:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const data = await r.json();
  if (!r.ok) { const e = new Error(data?.error?.message || `Gemini HTTP ${r.status}`); e.status = r.status; throw e; }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned empty response (' + (data.candidates?.[0]?.finishReason || 'no candidate') + ')');
  return text;
}

async function generate({ system, parts, json = true, temperature = 0.4 }) {
  if (!KEY) throw new Error('GEMINI_API_KEY missing in .env');
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callModel(model, body);
        return json ? parseJson(text) : text;
      } catch (e) {
        lastErr = e;
        const transient = e.name === 'TimeoutError' || e.status === 429 || e.status === 503 || e.status === 500 || /high demand|overloaded|timeout|non-JSON|empty response/i.test(e.message);
        if (!transient) break;               /* hard error on this model -> try next model */
        if (attempt === 0 && e.status === 429) await new Promise(r => setTimeout(r, 800));
        else break;                          /* overloaded -> move to the next model immediately */
      }
    }
    console.warn(`[gemini] ${model} failed: ${lastErr.message.slice(0, 120)}`);
  }
  throw lastErr;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s > -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error('Gemini returned non-JSON: ' + text.slice(0, 200));
}

const inline = (buffer, mime) => ({ inlineData: { mimeType: mime, data: buffer.toString('base64') } });

/* ---------- questionnaire ---------- */
const INTAKE_SYSTEM = `You are Nidaan, a pre-consultation intake assistant used in Indian outpatient clinics.
You ask the short, plain-language questions a doctor asks at the START of a consultation, ONE at a time, in the order a doctor would ask them.
You never diagnose, never suggest treatment, never give medical advice to the patient. Keep each question under 20 words. Use simple English a 12-year-old understands.
Follow-up questions must depend on the patient's main complaint and earlier answers (site, onset/duration, character, radiation, associated symptoms, timing, exacerbating/relieving factors, severity, similar episodes, medicines/allergies/conditions).
Never repeat a question already answered. Stop after 5 to 7 follow-ups (after the first "what is troubling you" question). Always respond with JSON only.`;

/* Dashavidha Pariksha (Ayurvedic tenfold examination) - the patient-answerable items, asked after the complaint questions.
   Sara and Vikriti are left to the doctor's examination. */
const DASHAVIDHA = [
  { field: 'prakriti', question: 'How would you describe your body and nature: light and quick, medium and warm, or heavy and calm?', hint: 'For example: thin build, feel cold easily, restless mind / medium build, feel hot, sharp hunger / solid build, slow, calm and steady', kind: 'text', label: 'Prakriti · constitution' },
  { field: 'ahara_shakti', question: 'How are your appetite, digestion and bowel habit these days?', hint: 'For example: good hunger, gas or heaviness after meals, motions once a day', kind: 'text', label: 'Ahara-shakti · digestion' },
  { field: 'vyayama_shakti', question: 'How much walking, work or exercise can you do before you feel tired?', hint: 'For example: one flight of stairs, 30 minutes walk, a full day of work', kind: 'text', label: 'Vyayama-shakti · exercise capacity' },
  { field: 'satmya', question: 'Which foods, weather and habits suit you? Do you take tea, coffee, tobacco or alcohol?', hint: 'For example: spicy food upsets me, cold weather suits me, two cups of tea a day, no tobacco', kind: 'text', label: 'Satmya · habituation' },
  { field: 'sattva', question: 'How are your sleep, mood and ability to handle stress right now?', hint: 'For example: sleep 6 hours, wake often, anxious about work', kind: 'text', label: 'Sattva · mental strength' },
  { field: 'pramana', question: 'What is your approximate height and weight?', hint: 'For example: 5 feet 4 inches, 68 kg', kind: 'text', label: 'Pramana · body measure' }
];
function dashavidhaNext(history) {
  const done = new Set(history.filter(h => h.section === 'dashavidha').map(h => h.field));
  const q = DASHAVIDHA.find(d => !done.has(d.field));
  if (!q) return { done: true, question: '', hint: '', kind: 'text', field: '' };
  return { done: false, question: q.question, hint: q.hint, kind: q.kind, field: q.field, section: 'dashavidha', label: q.label };
}

async function nextQuestion({ patient, history, doctor, complaintDone }) {
  const dasha = history.filter(h => h.section === 'dashavidha');
  if (complaintDone || dasha.length) return dashavidhaNext(history);
  history = history.filter(h => h.section !== 'dashavidha');
  const asked = history.length;
  if (asked === 0) return { done: false, question: 'What is troubling you today, and where do you feel it?', hint: 'Describe it in your own words. Point to the place if it helps.', kind: 'text', field: 'chief_complaint' };
  const transcript = history.map((h, i) => `Q${i + 1}: ${h.q}\nA${i + 1}: ${h.a || '(no answer)'}`).join('\n');
  const parts = [{ text:
`Patient: ${patient.age || '?'} ${patient.sex || ''}${patient.conditions ? ' · known conditions: ' + patient.conditions : ''}${patient.medicines ? ' · regular medicines: ' + patient.medicines : ''}.
Consultation with: ${doctor?.specialty || 'general physician'}.
Questions asked so far: ${asked} (max 7 follow-ups after the first question, then finish).

Transcript so far:
${transcript || '(nothing yet)'}

Decide the next single question. Return JSON:
{"done": boolean,               // true when enough has been asked (5-7 follow-ups done, or the patient's answers already cover everything)
 "question": string,            // the next question to ask (empty if done)
 "hint": string,                // short example of how to answer, e.g. "For example: 3 days, since last night"
 "kind": "text"|"scale"|"yesno", // "scale" ONLY for a 0-10 pain/severity question; "yesno" for a yes/no question
 "field": string}               // snake_case key naming what the question captures, e.g. "duration", "pain_location", "severity"
Rules: the first question (asked=0) must be exactly "What is troubling you today, and where do you feel it?" with kind "text" and field "chief_complaint".
Ask a severity 0-10 scale question exactly once, around the 3rd or 4th follow-up. Ask about fever/other symptoms, previous similar episode, and regular medicines/allergies before finishing if not already covered.` }];
  const out = await generate({ system: INTAKE_SYSTEM, parts, temperature: 0.3 });
  if (out.done) return { ...dashavidhaNext(history), complaint_done: true };
  return { done: !!out.done, question: out.question || '', hint: out.hint || '', kind: ['text', 'scale', 'yesno'].includes(out.kind) ? out.kind : 'text', field: out.field || ('q' + asked) };
}

async function urgentSigns({ history }) {
  const transcript = history.map((h, i) => `Q: ${h.q}\nA: ${h.a}`).join('\n');
  const parts = [{ text:
`Based on this intake transcript, list 4 red-flag warning signs specific to this complaint that, if present, a doctor would want to see the patient urgently. Each as a short checkbox label (max 8 words) with an optional one-line reason.
Transcript:
${transcript}
Return JSON: {"signs":[{"label":string,"why":string}]}` }];
  const out = await generate({ system: INTAKE_SYSTEM, parts, temperature: 0.2 });
  const signs = Array.isArray(out.signs) ? out.signs.slice(0, 4) : [];
  return signs.length ? signs : [
    { label: 'High fever with the problem', why: '' }, { label: 'Severe pain that is getting worse quickly', why: '' },
    { label: 'Difficulty breathing or chest pain', why: '' }, { label: 'Fainting, confusion or weakness on one side', why: '' }];
}

/* ---------- summary for doctor (after send) ---------- */
async function intakeSummary({ patient, history, pain, urgent, documents }) {
  const transcript = history.filter(h => h.section !== 'dashavidha').map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n');
  const dashaText = history.filter(h => h.section === 'dashavidha').map(h => `${h.field}: ${h.a}`).join('\n');
  const docText = (documents || []).map(d => {
    const ex = d.extracted || {};
    return `- ${d.name} (${d.doc_type || 'document'}, ${d.doc_date || 'date unknown'}): ${ex.summary || 'not read'}${(ex.red_flags || []).length ? ' · flags: ' + ex.red_flags.map(f => f.title).join('; ') : ''}`;
  }).join('\n');
  const parts = [{ text:
`Patient: ${patient.age || '?'} ${patient.sex || ''}. Known conditions: ${patient.conditions || 'none recorded'}. Regular medicines: ${patient.medicines || 'none recorded'}. Allergies: ${patient.allergies || 'none recorded'}.
Self-reported pain/severity: ${pain != null ? pain + '/10' : 'not given'}.
Urgent signs ticked by patient: ${urgent && urgent.length ? urgent.join('; ') : 'none'}.

Intake transcript:
${transcript}

Reports shared by patient:
${docText || 'none'}

Dashavidha Pariksha answers (Ayurvedic tenfold examination, patient-reported):
${dashaText || 'not asked'}

Write a structured pre-consultation summary for the doctor. Do NOT diagnose. Return JSON:
{"title": string,                 // 3-6 word episode title, e.g. "Right knee pain"
 "one_liner": string,             // one sentence: complaint + duration, e.g. "Chest discomfort on exertion, 5 days"
 "fields": [{"k":string,"v":string}],  // 6-9 rows: Main problem, Since, Character, Severity, Triggers, Relieved by, Associated, Similar before, Medicines/allergies (only rows with info)
 "red_flags": [{"title":string,"detail":string,"level":"crit"|"warn"}],  // concerning features from answers AND from reports; empty array if none. crit = needs to be seen before others
 "considerations": [{"name":string,"specialty":string,"why":string,"features":number}],  // 1 or 2 POSSIBLE DISEASE AREAS the reported pattern fits, e.g. name "Ischaemic heart disease pattern", specialty "Cardiology", why = the matched features in under 15 words, features = how many reported features match. Ordered by features. Areas/patterns only, NOT a diagnosis
 "dashavidha": {                   // only from the Dashavidha answers; null if not asked. Each value one short phrase for the doctor
   "prakriti": string,            // likely dominant dosha(s) as SELF-REPORTED, e.g. "Vata-Pitta (lean, restless, feels hot)"; "unclear" if answers do not allow
   "vikriti": string,             // dosha imbalance suggested by the complaint, phrased as "consider ..." - for the doctor to confirm on examination
   "sara": "On examination",
   "samhanana": string,           // body build/compactness from answers
   "pramana": string,             // height/weight as given
   "satmya": string,
   "sattva": string,              // pravara / madhyama / avara with a word of reason
   "ahara_shakti": string,        // abhyavaharana (appetite) and jarana (digestion)
   "vyayama_shakti": string,      // pravara / madhyama / avara with reason
   "vaya": string},               // bala / madhya / vriddha with age
 "answer_count": number}` }];
  const out = await generate({ system: 'You write concise clinical pre-consultation summaries for doctors from patient-reported answers. You never diagnose; you orient. JSON only.', parts, temperature: 0.2 });
  return {
    title: out.title || (history[0]?.a || 'Health concern').slice(0, 40),
    one_liner: out.one_liner || '',
    fields: Array.isArray(out.fields) ? out.fields : [],
    red_flags: Array.isArray(out.red_flags) ? out.red_flags.map(f => ({ title: f.title, detail: f.detail || '', level: f.level === 'crit' ? 'crit' : 'warn' })) : [],
    considerations: Array.isArray(out.considerations) ? out.considerations.slice(0, 2).map(c => ({ name: c.name || '', specialty: c.specialty || '', why: c.why || '', features: Number(c.features) || 0 })) : [],
    dashavidha: dashaText && out.dashavidha && typeof out.dashavidha === 'object' ? out.dashavidha : null,
    answer_count: history.length
  };
}

/* ---------- document extraction (OCR module hands text + file here) ---------- */
async function extractDocument({ buffer, mime, ocrText, filename, patient }) {
  const parts = [];
  const okInline = /^(application\/pdf|image\/(png|jpeg|jpg|webp|heic|heif))$/i.test(mime) && buffer.length < 18 * 1024 * 1024;
  if (okInline) parts.push(inline(buffer, mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime));
  const schema = [
    '{"doc_type": "Lab report"|"Imaging report"|"Prescription"|"Discharge summary"|"Doctor\'s letter"|"Other",',
    ' "title": string,               // short document title, e.g. "Lipid profile", "X-ray right knee"',
    ' "issued_by": string,           // lab / hospital / doctor name, or ""',
    ' "doc_date": string,            // ISO date YYYY-MM-DD if found, else ""',
    ' "summary": string,             // 1-2 sentences of what the document says (for a doctor)',
    ' "values": [{"name":string,"value":string,"unit":string,"ref":string,"status":"normal"|"high"|"low"|"critical"|"unknown"}],  // lab values / key findings, max 15',
    ' "red_flags": [{"title":string,"detail":string,"level":"crit"|"warn"}],  // abnormal or clinically concerning findings only; empty if none',
    ' "readable": boolean}           // false if the file could not be read at all'
  ].join('\n');
  const ocrPart = ocrText
    ? 'OCR text extracted locally (may contain errors):\n"""\n' + ocrText.slice(0, 12000) + '\n"""'
    : 'No local OCR text available; read the attached file directly.';
  parts.push({ text:
    'This is a medical document uploaded by a patient (' + (patient?.age || '?') + ' ' + (patient?.sex || '') + ') in India. File name: ' + filename + '.\n' +
    ocrPart + '\n\nExtract the key information. Return JSON:\n' + schema });
  const out = await generate({ system: 'You are a careful medical document reader. Extract only what is written. Do not invent values. JSON only.', parts, temperature: 0.1 });
  return {
    doc_type: out.doc_type || 'Other', title: out.title || '', issued_by: out.issued_by || '', doc_date: out.doc_date || '',
    summary: out.summary || '', values: Array.isArray(out.values) ? out.values.slice(0, 15) : [],
    red_flags: Array.isArray(out.red_flags) ? out.red_flags.map(f => ({ title: f.title, detail: f.detail || '', level: f.level === 'crit' ? 'crit' : 'warn' })) : [],
    readable: out.readable !== false
  };
}

/* ---------- speech-to-text fallback (browser without Web Speech API) ---------- */
async function transcribe({ buffer, mime }) {
  const parts = [inline(buffer, mime || 'audio/webm'), { text: 'Transcribe this audio exactly as spoken. The speaker is a patient answering a health question, possibly in Indian English or Hindi/Marathi; if not English, translate to English. Return JSON {"text": string}.' }];
  const out = await generate({ parts, temperature: 0 });
  return out.text || '';
}

module.exports = { generate, nextQuestion, DASHAVIDHA, urgentSigns, intakeSummary, extractDocument, transcribe, MODEL };
