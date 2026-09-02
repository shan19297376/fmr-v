/**
 * Reading a medical document with Gemini.
 *
 * The prompt is deliberately narrow: transcribe what is printed, never
 * interpret. It must not diagnose, must not convert units, must not fill gaps.
 * Anything it cannot read goes into uncertain_fields so the review screen can
 * flag it rather than quietly inventing a value.
 *
 * Everything here runs on the queue, never in a request.
 */

import type { Env } from './index';

export const RECORD_TYPES = [
  'Doctor Visit', 'Prescription', 'Lab Test', 'Manual Reading', 'Imaging',
  'Hospital Admission', 'Discharge Summary', 'Vaccination', 'Procedure',
  'Bill / Insurance', 'Medicine Purchase', 'Other',
] as const;

/** Names Gemini should prefer when a printed name matches one of them. */
const VOCAB = [
  'Haemoglobin', 'Total WBC Count', 'Platelet Count', 'RBC Count', 'Haematocrit (PCV)', 'MCV', 'MCH', 'MCHC', 'RDW', 'ESR',
  'Neutrophils %', 'Lymphocytes %', 'Eosinophils %', 'Monocytes %', 'Basophils %', 'Absolute Neutrophil Count', 'Absolute Lymphocyte Count',
  'Fasting Blood Sugar', 'Post Meal Blood Sugar', 'Random Blood Sugar', 'HbA1c', 'Estimated Average Glucose', 'Fasting Insulin',
  'Total Cholesterol', 'HDL Cholesterol', 'LDL Cholesterol', 'VLDL Cholesterol', 'Triglycerides', 'Non-HDL Cholesterol', 'Cholesterol / HDL Ratio',
  'Urea', 'Blood Urea Nitrogen', 'Creatinine', 'eGFR', 'Uric Acid', 'Sodium', 'Potassium', 'Chloride', 'Calcium', 'Phosphorus', 'Magnesium',
  'Total Bilirubin', 'Direct Bilirubin', 'Indirect Bilirubin', 'ALT (SGPT)', 'AST (SGOT)', 'Alkaline Phosphatase', 'GGT',
  'Total Protein', 'Albumin', 'Globulin', 'A/G Ratio',
  'TSH', 'Free T3', 'Free T4', 'Total T3', 'Total T4', 'Anti-TPO Antibody',
  'Vitamin D', 'Vitamin B12', 'Folate', 'Ferritin', 'Serum Iron', 'TIBC', 'Transferrin Saturation',
  'CRP', 'hs-CRP', 'D-Dimer', 'Procalcitonin', 'PSA', 'Testosterone', 'Cortisol', 'Prolactin',
  'Blood Pressure', 'Pulse', 'SpO2', 'Temperature', 'Weight', 'Height', 'BMI', 'Respiratory Rate', 'Waist Circumference',
  'Urine Protein', 'Urine Sugar', 'Urine pH', 'Urine Specific Gravity', 'Urine Pus Cells',
];

export interface Extraction {
  event_date: string;
  record_type: string;
  doctor_name: string;
  speciality: string;
  facility: string;
  reason_or_symptoms: string;
  summary: string;
  key_findings: string;
  uncertain_fields: string[];
  documents: any[];
  diagnoses: any[];
  medicines: any[];
  tests: any[];
  follow_ups: any[];
  bills: any[];
}

function prompt(person: string, date: string | null, fileName: string): string {
  return [
    'Transcribe the facts printed in this medical document. Do not diagnose, interpret, recommend or infer.',
    `Patient: ${person}. Approximate date given by the user: ${date || 'not provided'}. File: ${fileName}.`,
    `record_type must be exactly one of: ${RECORD_TYPES.join(', ')}.`,
    'Capture every test result, medicine, diagnosis, follow-up instruction and billed line item.',
    'Copy doses, decimal points, units and abnormal flags exactly as printed. Never convert a unit.',
    `For each test also give parameter_standard: the widely used standard name, chosen from this list when one fits: ${VOCAB.join(' | ')}.`,
    'Keep the printed name in parameter and the standard name in parameter_standard. If nothing fits, repeat the printed name.',
    'Dates must be yyyy-mm-dd. Indian reports are usually dd/mm/yyyy, so read them that way.',
    'Use an empty string for anything not stated. List anything unreadable in uncertain_fields.',
    'Return JSON only, matching the schema.',
  ].join('\n');
}

function schema() {
  const s = { type: 'string' as const };
  const i = { type: 'integer' as const };
  const arr = (props: Record<string, unknown>) => ({ type: 'array', items: { type: 'object', properties: props } });
  return {
    type: 'object',
    properties: {
      event_date: s, record_type: s, doctor_name: s, speciality: s, facility: s,
      reason_or_symptoms: s, summary: s, key_findings: s,
      uncertain_fields: { type: 'array', items: s },
      documents: arr({ document_date: s, document_type: s, provider: s, document_summary: s }),
      diagnoses: arr({ diagnosis: s, status: s, notes: s }),
      medicines: arr({ name: s, generic_or_composition: s, strength: s, form: s, dose: s, frequency: s, route: s, duration: s, timing_or_instructions: s, start_date: s, end_date: s, status: s }),
      tests: arr({ test_date: s, test_or_panel: s, parameter: s, parameter_standard: s, result: s, unit: s, reference_range: s, flag: s, lab: s }),
      follow_ups: arr({ due_date: s, type: s, instruction: s, status: s }),
      bills: arr({ bill_date: s, bill_type: s, vendor: s, invoice_number: s, item_or_service: s, medicine_name: s, quantity: s, batch_number: s, expiry_date: s, line_amount: s, bill_total: s, payment_status: s, notes: s }),
    },
    required: ['event_date', 'record_type', 'summary', 'documents', 'diagnoses', 'medicines', 'tests', 'follow_ups', 'bills'],
  };
}

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];

export async function readDocument(
  env: Env, bytes: Uint8Array, mimeType: string, person: string, userDate: string | null, fileName: string
): Promise<Extraction> {
  if (!env.GEMINI_API_KEY) throw new Error('No Gemini key is configured.');

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt(person, userDate, fileName) },
        { inlineData: { mimeType: mimeType || 'application/pdf', data: base64(bytes) } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema(), maxOutputTokens: 32000 },
  };

  let lastError = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );

      if ([429, 500, 503].includes(res.status)) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        continue;
      }

      if (!res.ok) {
        lastError = `Gemini returned ${res.status}: ${(await res.text()).slice(0, 300)}`;
        if ([400, 401, 403].includes(res.status)) break;   // config problem; another model won't help
        continue;
      }

      const parsed = await res.json<any>();
      const finish = parsed?.candidates?.[0]?.finishReason ?? '';
      if (finish === 'MAX_TOKENS') {
        throw new Error('This document is too long to read in one go. Split it into smaller files.');
      }
      if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
        throw new Error('Gemini declined to read this file. Enter it by hand instead.');
      }

      const text = (parsed?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p?.text ?? '').filter(Boolean).join('');
      if (!text) { lastError = 'Gemini returned nothing.'; continue; }

      try {
        return normalise(JSON.parse(text));
      } catch {
        lastError = 'Gemini\u2019s reply was cut off before it finished.';
      }
    }
  }

  throw new Error(lastError || 'Gemini could not read this document.');
}

function base64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;   // avoids blowing the argument limit on large files
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Accepts yyyy-mm-dd, dd/mm/yyyy and dd-mm-yyyy. Anything else becomes ''. */
export function cleanDate(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

/** Force whatever came back into the shape the rest of the app expects. */
export function normalise(x: any): Extraction {
  const a = (v: unknown) => (Array.isArray(v) ? v : []);
  const type = str(x?.record_type);

  return {
    event_date: cleanDate(x?.event_date),
    record_type: (RECORD_TYPES as readonly string[]).includes(type) ? type : 'Other',
    doctor_name: str(x?.doctor_name),
    speciality: str(x?.speciality),
    facility: str(x?.facility),
    reason_or_symptoms: str(x?.reason_or_symptoms),
    summary: str(x?.summary),
    key_findings: str(x?.key_findings),
    uncertain_fields: a(x?.uncertain_fields).map(str).filter(Boolean),

    documents: a(x?.documents).map((v: any) => ({
      document_date: cleanDate(v?.document_date), document_type: str(v?.document_type),
      provider: str(v?.provider), document_summary: str(v?.document_summary),
    })),

    diagnoses: a(x?.diagnoses).map((v: any) => ({
      diagnosis: str(v?.diagnosis), status: str(v?.status), notes: str(v?.notes),
    })).filter((v: any) => v.diagnosis),

    medicines: a(x?.medicines).map((v: any) => ({
      name: str(v?.name), generic_or_composition: str(v?.generic_or_composition),
      strength: str(v?.strength), form: str(v?.form), dose: str(v?.dose),
      frequency: str(v?.frequency), route: str(v?.route), duration: str(v?.duration),
      timing_or_instructions: str(v?.timing_or_instructions),
      start_date: cleanDate(v?.start_date), end_date: cleanDate(v?.end_date), status: str(v?.status),
    })).filter((v: any) => v.name),

    tests: a(x?.tests).map((v: any) => ({
      test_date: cleanDate(v?.test_date), test_or_panel: str(v?.test_or_panel),
      parameter: str(v?.parameter), parameter_standard: str(v?.parameter_standard),
      result: str(v?.result), unit: str(v?.unit), reference_range: str(v?.reference_range),
      flag: str(v?.flag), lab: str(v?.lab),
    })).filter((v: any) => v.parameter || v.test_or_panel || v.result),

    follow_ups: a(x?.follow_ups).map((v: any) => ({
      due_date: cleanDate(v?.due_date), type: str(v?.type),
      instruction: str(v?.instruction), status: str(v?.status),
    })).filter((v: any) => v.instruction || v.due_date),

    bills: a(x?.bills).map((v: any) => ({
      bill_date: cleanDate(v?.bill_date), bill_type: str(v?.bill_type), vendor: str(v?.vendor),
      invoice_number: str(v?.invoice_number), item_or_service: str(v?.item_or_service),
      medicine_name: str(v?.medicine_name), quantity: str(v?.quantity),
      batch_number: str(v?.batch_number), expiry_date: cleanDate(v?.expiry_date),
      line_amount: str(v?.line_amount), bill_total: str(v?.bill_total),
      payment_status: str(v?.payment_status), notes: str(v?.notes),
    })).filter((v: any) => v.vendor || v.item_or_service || v.medicine_name || v.bill_total),
  };
}

/** Merge per-file extractions into one record for the review screen. */
export function mergeExtractions(parts: Extraction[], fallbackDate: string): Extraction {
  if (!parts.length) return normalise({ event_date: fallbackDate });
  const first = parts[0];
  const joined = (pick: (e: Extraction) => string, sep: string) =>
    parts.map(pick).filter(Boolean).join(sep);

  return normalise({
    event_date: first.event_date || fallbackDate,
    record_type: first.record_type,
    doctor_name: first.doctor_name,
    speciality: first.speciality,
    facility: first.facility,
    reason_or_symptoms: first.reason_or_symptoms,
    summary: joined((e) => e.summary, '\n\n'),
    key_findings: joined((e) => e.key_findings, '\n'),
    uncertain_fields: parts.flatMap((e) => e.uncertain_fields),
    documents: parts.flatMap((e) => e.documents),
    diagnoses: parts.flatMap((e) => e.diagnoses),
    medicines: parts.flatMap((e) => e.medicines),
    tests: parts.flatMap((e) => e.tests),
    follow_ups: parts.flatMap((e) => e.follow_ups),
    bills: parts.flatMap((e) => e.bills),
  });
}
