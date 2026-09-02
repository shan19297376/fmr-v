/**
 * Exports.
 *
 * Two deliverables, both built on demand and never stored:
 *   1. A multi-sheet .xlsx of everything, ready to pivot and filter.
 *   2. A .zip of the original scans, foldered by person and year, decrypted on
 *      the way out and named so the archive reads without the app.
 *
 * This is the "you are not locked in" guarantee. Anyone can take these two
 * files and walk away from the app entirely.
 */

import type { Env } from './index';
import { makeXlsx, type Sheet } from './xlsx';
import { makeZip, type ZipEntry } from './zip';
import { getDocument, documentFileName } from './storage';

/** Scope is applied by the caller; this only shapes what comes back. */
export async function buildWorkbook(env: Env, personIds: string[] | 'all'): Promise<Uint8Array> {
  const where = personIds === 'all' ? '' : `AND t.person_id IN (${personIds.map(() => '?').join(',')})`;
  const binds = personIds === 'all' ? [] : personIds;

  const q = async (sql: string) => (await env.DB.prepare(sql).bind(...binds).all()).results as any[];

  const [tests, meds, records, diagnoses, followUps, bills, documents, people] = await Promise.all([
    q(`SELECT p.name person, t.test_date, t.panel, t.parameter, t.parameter_raw, t.result_text,
              t.value_a, t.unit, t.ref_range_text, t.flag, t.lab
         FROM test_results t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.parameter, t.test_date`),
    q(`SELECT p.name person, t.name medicine, t.composition, t.strength, t.dose, t.frequency,
              t.duration_text, t.start_date, t.end_date, t.status, t.instructions
         FROM medicines t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.prescribed_on DESC`),
    q(`SELECT p.name person, t.event_date, t.record_type, t.doctor, t.speciality, t.facility,
              t.reason, t.summary, t.key_diagnosis, t.key_findings
         FROM records t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.event_date DESC`),
    q(`SELECT p.name person, t.noted_on, t.diagnosis, t.status, t.notes
         FROM diagnoses t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.noted_on DESC`),
    q(`SELECT p.name person, t.due_date, t.type, t.instruction, t.status
         FROM follow_ups t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.due_date`),
    q(`SELECT p.name person, t.bill_date, t.bill_type, t.vendor, t.invoice_number, t.item,
              t.medicine_name, t.quantity, t.line_amount, t.bill_total, t.payment_status
         FROM bills t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.bill_date DESC`),
    q(`SELECT p.name person, t.document_date, t.document_type, t.provider, t.file_name,
              t.bytes, t.document_id
         FROM documents t JOIN people p USING (person_id)
        WHERE t.deleted = 0 ${where} ORDER BY p.name, t.document_date DESC`),
    q(`SELECT p.name person, pr.date_of_birth, pr.blood_group, pr.allergies,
              pr.chronic_conditions, pr.regular_doctors, pr.emergency_contact, pr.insurance
         FROM people p LEFT JOIN profiles pr USING (person_id)
         JOIN people t USING (person_id)
        WHERE p.active = 1 ${where} ORDER BY p.name`),
  ]);

  const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

  const sheets: Sheet[] = [
    { name: 'People', headers: ['Person', 'Date of birth', 'Blood group', 'Allergies', 'Chronic conditions', 'Regular doctors', 'Emergency contact', 'Insurance'],
      rows: people.map(r => [r.person, r.date_of_birth, r.blood_group, r.allergies, r.chronic_conditions, r.regular_doctors, r.emergency_contact, r.insurance]) },

    { name: 'Test results', headers: ['Person', 'Test date', 'Panel', 'Test', 'As printed', 'Result', 'Value', 'Unit', 'Reference range', 'Flag', 'Lab'],
      rows: tests.map(r => [r.person, r.test_date, r.panel, r.parameter, r.parameter_raw, r.result_text, num(r.value_a), r.unit, r.ref_range_text, r.flag, r.lab]) },

    { name: 'Medicines', headers: ['Person', 'Medicine', 'Composition', 'Strength', 'Dose', 'Frequency', 'Duration', 'Start', 'End', 'Status', 'Instructions'],
      rows: meds.map(r => [r.person, r.medicine, r.composition, r.strength, r.dose, r.frequency, r.duration_text, r.start_date, r.end_date, r.status, r.instructions]) },

    { name: 'Visits and reports', headers: ['Person', 'Date', 'Type', 'Doctor', 'Speciality', 'Hospital or lab', 'Reason', 'Summary', 'Diagnosis', 'Findings'],
      rows: records.map(r => [r.person, r.event_date, r.record_type, r.doctor, r.speciality, r.facility, r.reason, r.summary, r.key_diagnosis, r.key_findings]) },

    { name: 'Diagnoses', headers: ['Person', 'Recorded on', 'Diagnosis', 'Status', 'Notes'],
      rows: diagnoses.map(r => [r.person, r.noted_on, r.diagnosis, r.status, r.notes]) },

    { name: 'Follow-ups', headers: ['Person', 'Due', 'Type', 'Instruction', 'Status'],
      rows: followUps.map(r => [r.person, r.due_date, r.type, r.instruction, r.status]) },

    { name: 'Bills', headers: ['Person', 'Bill date', 'Type', 'Vendor', 'Invoice', 'Item', 'Medicine', 'Quantity', 'Line amount', 'Bill total', 'Payment status'],
      rows: bills.map(r => [r.person, r.bill_date, r.bill_type, r.vendor, r.invoice_number, r.item, r.medicine_name, r.quantity, num(r.line_amount), num(r.bill_total), r.payment_status]) },

    { name: 'Documents', headers: ['Person', 'Date', 'Type', 'Provider', 'File in archive', 'Size (KB)'],
      rows: documents.map(r => [
        r.person, r.document_date, r.document_type, r.provider,
        documentFileName({ date: r.document_date, person: r.person, recordType: r.document_type, provider: r.provider, documentId: r.document_id, originalName: r.file_name }),
        num(r.bytes) ? Math.round(Number(r.bytes) / 1024) : null,
      ]) },
  ];

  return makeXlsx(sheets);
}

/**
 * The scans, foldered by person and year:
 *   Reena/2026/2026-03-11_Reena_Lab-Test_Dr-Lals-PathLabs_a1b2c3d4.pdf
 *
 * Capped per call because a Worker holds the whole archive in memory.
 */
export async function buildDocumentArchive(
  env: Env, personIds: string[] | 'all', limit = 300
): Promise<{ zip: Uint8Array; included: number; skipped: number; total: number }> {
  const where = personIds === 'all' ? '' : `AND d.person_id IN (${personIds.map(() => '?').join(',')})`;
  const binds = personIds === 'all' ? [] : personIds;

  const { results } = await env.DB.prepare(
    `SELECT d.document_id, d.person_id, d.document_date, d.document_type, d.provider,
            d.file_name, d.r2_key, p.name person
       FROM documents d JOIN people p USING (person_id)
      WHERE d.deleted = 0 ${where}
      ORDER BY d.document_date DESC`
  ).bind(...binds).all();

  const all = results as any[];
  const take = all.slice(0, limit);
  const entries: ZipEntry[] = [];
  let skipped = 0;

  for (const d of take) {
    try {
      const bytes = await getDocument(env, d.r2_key);
      const year = (d.document_date || '').slice(0, 4) || 'undated';
      const name = documentFileName({
        date: d.document_date, person: d.person, recordType: d.document_type,
        provider: d.provider, documentId: d.document_id, originalName: d.file_name,
      });
      entries.push({
        name: `${d.person.replace(/[^A-Za-z0-9 ]+/g, '')}/${year}/${name}`,
        data: bytes,
        date: d.document_date ? new Date(d.document_date) : new Date(),
      });
    } catch {
      skipped++;   // a missing or unreadable object must not sink the whole export
    }
  }

  return { zip: makeZip(entries), included: entries.length, skipped, total: all.length };
}

/** Download filename for the exports themselves. */
export function exportFileName(kind: 'xlsx' | 'zip', who: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const scope = who.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30) || 'family';
  return kind === 'xlsx'
    ? `Medical-records_${scope}_${stamp}.xlsx`
    : `Medical-documents_${scope}_${stamp}.zip`;
}
