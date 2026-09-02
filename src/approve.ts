/**
 * Approval: turn a reviewed extraction into filed records.
 *
 * Nothing reaches these tables without a person clicking approve. Gemini
 * proposes; the reviewer decides.
 *
 * Every insert is batched. v4 appended row by row, which is why filing a
 * forty-parameter blood panel took the better part of a minute.
 */

import type { Env } from './index';
import type { Extraction } from './gemini';
import {
  resolveParameter, learnAlias, toCanonicalValue, numericResult,
  parseReferenceRange, referenceBand, isAbnormal, medicineEnd,
} from './canonical';
import { objectKey } from './storage';

const CATEGORY: Record<string, string> = {
  'Doctor Visit': 'Prescriptions & Visits', 'Prescription': 'Prescriptions & Visits',
  'Lab Test': 'Lab Reports', 'Manual Reading': 'Other', 'Imaging': 'Imaging',
  'Hospital Admission': 'Hospital & Discharge', 'Discharge Summary': 'Hospital & Discharge',
  'Vaccination': 'Vaccinations', 'Procedure': 'Procedures',
  'Bill / Insurance': 'Bills & Insurance', 'Medicine Purchase': 'Bills & Insurance', 'Other': 'Other',
};

interface JobFile {
  job_file_id: string; file_name: string; mime_type: string;
  bytes: number; r2_key: string; content_sha256: string;
}

export async function approveJob(
  env: Env, jobId: string, personId: string, personName: string,
  careEventId: string | null, data: Extraction, files: JobFile[], actor: string
): Promise<{ recordId: string; counts: Record<string, number> }> {

  const recordId = crypto.randomUUID();
  const eventDate = data.event_date || new Date().toISOString().slice(0, 10);
  const stmts: D1PreparedStatement[] = [];
  const timeline: any[][] = [];

  const addTimeline = (kind: string, refId: string, date: string, title: string, value: string, detail: string, flag: string) =>
    timeline.push([
      crypto.randomUUID(), personId, kind, refId, date || eventDate,
      title.slice(0, 200), value.slice(0, 300), detail.slice(0, 400), flag,
      `${title} ${value} ${detail}`.toLowerCase().slice(0, 500), careEventId,
    ]);

  /* ---- the visit or report itself ---- */
  stmts.push(env.DB.prepare(
    `INSERT INTO records (record_id, person_id, care_event_id, event_date, record_type, doctor,
                          speciality, facility, reason, summary, key_diagnosis, key_findings)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    recordId, personId, careEventId, eventDate, data.record_type, data.doctor_name,
    data.speciality, data.facility, data.reason_or_symptoms, data.summary,
    data.diagnoses.map((d) => d.diagnosis).join('; '), data.key_findings
  ));
  addTimeline('record', recordId, eventDate, data.record_type, data.summary,
    [data.doctor_name, data.facility].filter(Boolean).join(' \u00b7 '), '');

  /* ---- the scans, moved out of the pending area into their filed key ---- */
  for (const [i, f] of files.entries()) {
    const documentId = crypto.randomUUID();
    const meta = data.documents[i] ?? {};
    const docDate = meta.document_date || eventDate;

    stmts.push(env.DB.prepare(
      `INSERT INTO documents (document_id, record_id, person_id, document_date, document_type,
                              category, provider, file_name, r2_key, mime_type, bytes,
                              content_sha256, summary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      documentId, recordId, personId, docDate, meta.document_type || data.record_type,
      CATEGORY[data.record_type] ?? 'Other', meta.provider || data.facility,
      f.file_name, f.r2_key, f.mime_type, f.bytes, f.content_sha256,
      meta.document_summary || data.summary
    ));
    addTimeline('document', documentId, docDate, meta.document_type || data.record_type,
      meta.document_summary || '', meta.provider || data.facility || '', '');
  }

  /* ---- test results: the part the trends depend on ---- */
  for (const t of data.tests) {
    await learnAlias(env, t.parameter || t.test_or_panel, t.parameter_standard, t.unit);
    const resolved = await resolveParameter(env, t.parameter || t.test_or_panel, t.unit);

    const nums = numericResult(t.result);
    const valueA = await toCanonicalValue(env, resolved.parameter, t.unit, nums.a);
    const valueB = await toCanonicalValue(env, resolved.parameter, t.unit, nums.b);

    // Prefer the range printed on the report; fall back to the seeded band.
    let { low, high } = parseReferenceRange(t.reference_range);
    if (low === null && high === null) {
      const band = await referenceBand(env, resolved.parameter);
      low = band?.low ?? null;
      high = band?.high ?? null;
    } else {
      low = low === null ? null : await toCanonicalValue(env, resolved.parameter, t.unit, low);
      high = high === null ? null : await toCanonicalValue(env, resolved.parameter, t.unit, high);
    }

    // A printed flag wins. Otherwise derive one from the range, but only when
    // the value was safely convertible.
    let abnormal = isAbnormal(t.flag);
    if (!t.flag && valueA !== null) {
      if (low !== null && valueA < low) abnormal = true;
      if (high !== null && valueA > high) abnormal = true;
    }

    const resultId = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      `INSERT INTO test_results (result_id, record_id, person_id, test_date, panel, parameter_raw,
                                 parameter, result_text, value_a, value_b, unit_raw, unit,
                                 ref_range_text, ref_low, ref_high, flag, is_abnormal, lab, entry_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ai')`
    ).bind(
      resultId, recordId, personId, t.test_date || eventDate, t.test_or_panel,
      t.parameter || t.test_or_panel, resolved.parameter, t.result,
      valueA, valueB, t.unit, resolved.unit, t.reference_range, low, high,
      t.flag, abnormal ? 1 : 0, t.lab
    ));

    addTimeline('test', resultId, t.test_date || eventDate, resolved.parameter,
      [t.result, t.unit].filter(Boolean).join(' '),
      [t.test_or_panel, t.lab, t.reference_range ? `ref ${t.reference_range}` : ''].filter(Boolean).join(' \u00b7 '),
      abnormal ? (t.flag || 'Out of range') : '');
  }

  /* ---- medicines, with a real end date rather than a 90-day guess ---- */
  for (const m of data.medicines) {
    const { endDate, status } = medicineEnd({
      status: m.status, end_date: m.end_date, start_date: m.start_date,
      prescribed_on: eventDate, duration_text: m.duration,
      instructions: m.timing_or_instructions, frequency: m.frequency,
    });

    const medicineId = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      `INSERT INTO medicines (medicine_id, record_id, person_id, prescribed_on, name, composition,
                              strength, form, dose, frequency, route, duration_text, instructions,
                              start_date, end_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      medicineId, recordId, personId, eventDate, m.name, m.generic_or_composition,
      m.strength, m.form, m.dose, m.frequency, m.route, m.duration,
      m.timing_or_instructions, m.start_date || eventDate, endDate, status
    ));
    addTimeline('medicine', medicineId, eventDate,
      [m.name, m.strength].filter(Boolean).join(' '),
      [m.dose, m.frequency, m.duration].filter(Boolean).join(' \u00b7 '),
      [m.generic_or_composition, m.timing_or_instructions].filter(Boolean).join(' \u00b7 '),
      status);
  }

  /* ---- diagnoses, follow-ups, bills ---- */
  for (const d of data.diagnoses) {
    const id = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      `INSERT INTO diagnoses (diagnosis_id, record_id, person_id, noted_on, diagnosis, status, notes)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(id, recordId, personId, eventDate, d.diagnosis, d.status, d.notes));
    addTimeline('diagnosis', id, eventDate, d.diagnosis, d.status, d.notes, '');
  }

  for (const f of data.follow_ups) {
    const id = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      `INSERT INTO follow_ups (follow_up_id, record_id, person_id, due_date, type, instruction, status)
       VALUES (?,?,?,?,?,?,'pending')`
    ).bind(id, recordId, personId, f.due_date || null, f.type || 'Follow-up', f.instruction));
    addTimeline('followup', id, f.due_date || eventDate, f.type || 'Follow-up', f.instruction, '', 'pending');
  }

  for (const b of data.bills) {
    const id = crypto.randomUUID();
    const amount = (v: string) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
    stmts.push(env.DB.prepare(
      `INSERT INTO bills (bill_id, record_id, person_id, bill_date, bill_type, vendor, invoice_number,
                          item, medicine_name, quantity, batch_number, expiry_date,
                          line_amount, bill_total, payment_status, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, recordId, personId, b.bill_date || eventDate, b.bill_type, b.vendor, b.invoice_number,
      b.item_or_service, b.medicine_name, b.quantity, b.batch_number, b.expiry_date || null,
      amount(b.line_amount), amount(b.bill_total), b.payment_status, b.notes
    ));
    addTimeline('bill', id, b.bill_date || eventDate,
      b.medicine_name || b.item_or_service || b.bill_type || 'Bill',
      String(b.bill_total || b.line_amount || ''),
      [b.vendor, b.invoice_number].filter(Boolean).join(' \u00b7 '), b.payment_status);
  }

  /* ---- timeline rows ---- */
  for (const row of timeline) {
    stmts.push(env.DB.prepare(
      `INSERT INTO timeline (entry_id, person_id, kind, ref_id, date, title, value, detail, flag, search_text, care_event_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(...row));
  }

  stmts.push(env.DB.prepare(
    `UPDATE jobs SET status='approved', message='Filed.', updated_at=datetime('now') WHERE job_id = ?`
  ).bind(jobId));
  stmts.push(env.DB.prepare(
    `INSERT INTO audit_log (actor, action, ref_id, detail) VALUES (?, 'approved', ?, ?)`
  ).bind(actor, recordId, `${personName}: ${data.record_type} on ${eventDate}`));

  // D1 caps how much one batch may carry, so send in chunks.
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));

  return {
    recordId,
    counts: {
      tests: data.tests.length, medicines: data.medicines.length,
      diagnoses: data.diagnoses.length, followUps: data.follow_ups.length,
      bills: data.bills.length, documents: files.length,
    },
  };
}

/** Where a filed document lives, once it is no longer pending. */
export { objectKey };
