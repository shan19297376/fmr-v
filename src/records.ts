/**
 * Everything that changes a filed record after the fact.
 *
 * Two rules carried over from v4 and kept deliberately:
 *  - every edit is recorded with a reason, before and after, in `corrections`.
 *    A medical record you cannot audit is a medical record you cannot trust.
 *  - deleting is soft. The row stays, the timeline entry hides. Documents go
 *    with it, but nothing is destroyed on a single click.
 */

import { Hono } from 'hono';
import type { Env, Caller } from './index';
import {
  resolveParameter, learnAlias, toCanonicalValue, numericResult,
  parseReferenceRange, referenceBand, isAbnormal, medicineEnd, clearCanonicalCache,
} from './canonical';
import { parseDate, today } from './format';

type Ctx = { Bindings: Env; Variables: { caller: Caller } };

/** Which columns each kind allows to be edited, and how the timeline reflects it. */
const EDITABLE: Record<string, {
  table: string; idCol: string; fields: string[];
  timeline: (r: any) => { date: string; title: string; value: string; detail: string; flag: string };
}> = {
  record: {
    table: 'health_records', idCol: 'record_id',
    fields: ['event_date', 'record_type', 'doctor', 'speciality', 'facility', 'reason', 'summary', 'key_diagnosis', 'key_findings'],
    timeline: (r) => ({ date: r.event_date, title: r.record_type, value: r.summary ?? '',
      detail: [r.doctor, r.facility].filter(Boolean).join(' \u00b7 '), flag: '' }),
  },
  test: {
    table: 'health_test_results', idCol: 'result_id',
    fields: ['test_date', 'panel', 'parameter_raw', 'result_text', 'unit_raw', 'ref_range_text', 'flag', 'lab', 'notes'],
    timeline: (r) => ({ date: r.test_date, title: r.parameter,
      value: [r.result_text, r.unit_raw].filter(Boolean).join(' '),
      detail: [r.panel, r.lab].filter(Boolean).join(' \u00b7 '),
      flag: r.is_abnormal ? (r.flag || 'Out of range') : '' }),
  },
  medicine: {
    table: 'health_medicines', idCol: 'medicine_id',
    fields: ['prescribed_on', 'name', 'composition', 'strength', 'form', 'dose', 'frequency', 'route', 'duration_text', 'instructions', 'start_date', 'end_date', 'status'],
    timeline: (r) => ({ date: r.prescribed_on, title: [r.name, r.strength].filter(Boolean).join(' '),
      value: [r.dose, r.frequency, r.duration_text].filter(Boolean).join(' \u00b7 '),
      detail: [r.composition, r.instructions].filter(Boolean).join(' \u00b7 '), flag: r.status }),
  },
  diagnosis: {
    table: 'health_diagnoses', idCol: 'diagnosis_id',
    fields: ['noted_on', 'diagnosis', 'status', 'notes'],
    timeline: (r) => ({ date: r.noted_on, title: r.diagnosis, value: r.status ?? '', detail: r.notes ?? '', flag: '' }),
  },
  followup: {
    table: 'health_follow_ups', idCol: 'follow_up_id',
    fields: ['due_date', 'type', 'instruction', 'status'],
    timeline: (r) => ({ date: r.due_date, title: r.type ?? 'Follow-up', value: r.instruction ?? '', detail: '', flag: r.status }),
  },
  bill: {
    table: 'health_bills', idCol: 'bill_id',
    fields: ['bill_date', 'bill_type', 'vendor', 'invoice_number', 'item', 'medicine_name', 'quantity', 'line_amount', 'bill_total', 'payment_status', 'notes'],
    timeline: (r) => ({ date: r.bill_date, title: r.medicine_name || r.item || r.bill_type || 'Bill',
      value: String(r.bill_total ?? r.line_amount ?? ''),
      detail: [r.vendor, r.invoice_number].filter(Boolean).join(' \u00b7 '), flag: r.payment_status ?? '' }),
  },
  document: {
    table: 'core_documents', idCol: 'document_id',
    fields: ['document_date', 'document_type', 'provider', 'summary'],
    timeline: (r) => ({ date: r.document_date, title: r.document_type ?? 'Document',
      value: r.summary ?? '', detail: r.provider ?? '', flag: '' }),
  },
};

const DATE_FIELDS = new Set(['event_date', 'test_date', 'prescribed_on', 'noted_on', 'due_date', 'bill_date', 'document_date', 'start_date', 'end_date']);
const NUMBER_FIELDS = new Set(['line_amount', 'bill_total']);

export const records = new Hono<Ctx>();

/** Load one row for editing, with the field list the UI should render. */
records.get('/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  const spec = EDITABLE[kind];
  if (!spec) throw new Error(`${kind} cannot be edited.`);

  const row = await c.env.DB.prepare(
    `SELECT * FROM ${spec.table} WHERE ${spec.idCol} = ? AND deleted = 0`
  ).bind(c.req.param('id')).first<any>();
  if (!row) throw new Error('That record no longer exists.');
  assertScope(c.get('caller'), row.person_id);

  return c.json({
    kind, id: row[spec.idCol], personId: row.person_id,
    fields: spec.fields.map((name) => ({
      name,
      label: label(name),
      type: DATE_FIELDS.has(name) ? 'date' : NUMBER_FIELDS.has(name) ? 'number'
        : /notes|summary|instruction|findings|reason|composition/.test(name) ? 'textarea' : 'text',
      value: row[name] ?? '',
    })),
  });
});

/** Save an edit. A reason is required and kept forever. */
records.put('/:kind/:id', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const kind = c.req.param('kind');
  const spec = EDITABLE[kind];
  if (!spec) throw new Error(`${kind} cannot be edited.`);

  const body = await c.req.json<{ values: Record<string, string>; reason: string }>();
  const reason = String(body.reason ?? '').trim().slice(0, 400);
  if (!reason) throw new Error('Say briefly why you are changing this.');

  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT * FROM ${spec.table} WHERE ${spec.idCol} = ? AND deleted = 0`
  ).bind(id).first<any>();
  if (!row) throw new Error('That record no longer exists.');
  assertScope(caller, row.person_id);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const sets: string[] = [];
  const binds: unknown[] = [];

  for (const field of spec.fields) {
    if (!(field in body.values)) continue;
    let value: string | number | null = String(body.values[field] ?? '').trim();
    if (DATE_FIELDS.has(field)) value = parseDate(value) || null;
    if (NUMBER_FIELDS.has(field)) value = value === '' ? null : Number(String(value).replace(/[^0-9.]/g, ''));
    if (String(row[field] ?? '') === String(value ?? '')) continue;
    before[field] = row[field];
    after[field] = value;
    sets.push(`${field} = ?`);
    binds.push(value);
  }
  if (!sets.length) throw new Error('Nothing was changed.');

  await c.env.DB.prepare(
    `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${spec.idCol} = ?`
  ).bind(...binds, id).run();

  const updated = await c.env.DB.prepare(
    `SELECT * FROM ${spec.table} WHERE ${spec.idCol} = ?`
  ).bind(id).first<any>();

  // Editing a test can change its canonical name, unit, bounds and flag.
  if (kind === 'test') await recomputeTest(c.env, updated);

  const t = spec.timeline(kind === 'test'
    ? await c.env.DB.prepare(`SELECT * FROM health_test_results WHERE result_id = ?`).bind(id).first<any>()
    : updated);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE health_timeline SET date=?, title=?, value=?, detail=?, flag=?, search_text=?
        WHERE ref_id = ?`
    ).bind(t.date, t.title, t.value, t.detail, t.flag,
           `${t.title} ${t.value} ${t.detail}`.toLowerCase().slice(0, 500), id),
    c.env.DB.prepare(
      `INSERT INTO core_corrections (correction_id, actor, person_id, table_name, row_id, before_json, after_json, reason)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), caller.email, row.person_id, spec.table, id,
           JSON.stringify(before), JSON.stringify(after), reason),
  ]);

  return c.json({ ok: true, changed: Object.keys(after) });
});

/** Soft delete. The row survives for the audit trail; the timeline hides it. */
records.delete('/:kind/:id', async (c) => {
  const caller = c.get('caller');
  if (caller.role !== 'owner') throw new Error('Only the owner can delete records.');

  const spec = EDITABLE[c.req.param('kind')];
  if (!spec) throw new Error('That cannot be deleted here.');
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT person_id FROM ${spec.table} WHERE ${spec.idCol} = ?`
  ).bind(id).first<{ person_id: string }>();
  if (!row) throw new Error('Already gone.');
  assertScope(caller, row.person_id);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${spec.table} SET deleted = 1 WHERE ${spec.idCol} = ?`).bind(id),
    c.env.DB.prepare(`UPDATE health_timeline SET deleted = 1 WHERE ref_id = ?`).bind(id),
    c.env.DB.prepare(`INSERT INTO core_audit_log (actor, action, ref_id, detail) VALUES (?, 'deleted', ?, ?)`)
      .bind(caller.email, id, spec.table),
  ]);
  return c.json({ ok: true });
});

/** Recalculate the derived columns on a test after its printed values change. */
async function recomputeTest(env: Env, t: any): Promise<void> {
  await learnAlias(env, t.parameter_raw, null, t.unit_raw);
  const resolved = await resolveParameter(env, t.parameter_raw, t.unit_raw);
  const nums = numericResult(t.result_text);
  const a = await toCanonicalValue(env, resolved.parameter, t.unit_raw, nums.a);
  const b = await toCanonicalValue(env, resolved.parameter, t.unit_raw, nums.b);

  let { low, high } = parseReferenceRange(t.ref_range_text);
  if (low === null && high === null) {
    const band = await referenceBand(env, resolved.parameter);
    low = band?.low ?? null; high = band?.high ?? null;
  }

  let abnormal = isAbnormal(t.flag);
  if (!t.flag && a !== null) {
    if (low !== null && a < low) abnormal = true;
    if (high !== null && a > high) abnormal = true;
  }

  await env.DB.prepare(
    `UPDATE health_test_results SET parameter=?, unit=?, value_a=?, value_b=?, ref_low=?, ref_high=?, is_abnormal=?
      WHERE result_id = ?`
  ).bind(resolved.parameter, resolved.unit, a, b, low, high, abnormal ? 1 : 0, t.result_id).run();
}

/* ---------------------------------------------------------------- */
/* Follow-up actions                                                 */
/* ---------------------------------------------------------------- */

records.post('/followup/:id/:action', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const id = c.req.param('id');
  const action = c.req.param('action');
  const row = await c.env.DB.prepare(
    `SELECT person_id, type, instruction FROM health_follow_ups WHERE follow_up_id = ? AND deleted = 0`
  ).bind(id).first<any>();
  if (!row) throw new Error('Follow-up not found.');
  assertScope(caller, row.person_id);

  let status: string;
  let dueDate: string | null = null;

  if (action === 'complete') status = 'completed';
  else if (action === 'dismiss') status = 'dismissed';
  else if (action === 'reschedule') {
    const { date } = await c.req.json<{ date: string }>();
    dueDate = parseDate(date);
    if (!dueDate) throw new Error('Choose a new date.');
    status = 'pending';
  } else throw new Error('Unknown action.');

  await c.env.DB.batch([
    dueDate
      ? c.env.DB.prepare(`UPDATE health_follow_ups SET status=?, due_date=? WHERE follow_up_id = ?`).bind(status, dueDate, id)
      : c.env.DB.prepare(`UPDATE health_follow_ups SET status=? WHERE follow_up_id = ?`).bind(status, id),
    c.env.DB.prepare(`UPDATE health_timeline SET flag=?, date=COALESCE(?, date) WHERE ref_id = ?`).bind(status, dueDate, id),
    c.env.DB.prepare(`INSERT INTO core_audit_log (actor, action, ref_id, detail) VALUES (?, ?, ?, ?)`)
      .bind(caller.email, `followup_${action}`, id, row.instruction ?? ''),
  ]);
  return c.json({ ok: true, status });
});

/* ---------------------------------------------------------------- */
/* Manual readings — home BP, sugar, weight                          */
/* ---------------------------------------------------------------- */

records.post('/reading', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const b = await c.req.json<{
    person: string; date: string; parameter: string; result: string;
    unit?: string; context?: string; notes?: string; careEventId?: string;
  }>();

  assertScope(caller, b.person);
  const date = parseDate(b.date) || today();
  const parameter = String(b.parameter ?? '').trim();
  const result = String(b.result ?? '').trim();
  if (!parameter || !result) throw new Error('A reading needs both what was measured and the value.');

  await learnAlias(c.env, parameter, null, b.unit);
  const resolved = await resolveParameter(c.env, parameter, b.unit);
  const nums = numericResult(result);
  const a = await toCanonicalValue(c.env, resolved.parameter, b.unit, nums.a);
  const bb = await toCanonicalValue(c.env, resolved.parameter, b.unit, nums.b);
  const band = await referenceBand(c.env, resolved.parameter);

  let abnormal = false;
  if (a !== null && band) {
    if (band.low !== null && a < band.low) abnormal = true;
    if (band.high !== null && a > band.high) abnormal = true;
  }

  const recordId = crypto.randomUUID();
  const resultId = crypto.randomUUID();
  const context = String(b.context ?? 'Home reading').slice(0, 80);
  const summary = `${resolved.parameter}: ${result}${b.unit ? ' ' + b.unit : ''}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO health_records (record_id, person_id, care_event_id, event_date, record_type, facility, summary, key_findings)
       VALUES (?,?,?,?,'Manual Reading',?,?,?)`
    ).bind(recordId, b.person, b.careEventId ?? null, date, context, summary, b.notes ?? ''),
    c.env.DB.prepare(
      `INSERT INTO health_test_results (result_id, record_id, person_id, test_date, panel, parameter_raw, parameter,
                                 result_text, value_a, value_b, unit_raw, unit, ref_low, ref_high,
                                 is_abnormal, lab, entry_source, notes, context)
       VALUES (?,?,?,?,'Home reading',?,?,?,?,?,?,?,?,?,?,?, 'manual', ?, ?)`
    ).bind(resultId, recordId, b.person, date, parameter, resolved.parameter, result, a, bb,
           b.unit ?? '', resolved.unit, band?.low ?? null, band?.high ?? null,
           abnormal ? 1 : 0, context, b.notes ?? '', context),
    c.env.DB.prepare(
      `INSERT INTO health_timeline (entry_id, person_id, kind, ref_id, date, title, value, detail, flag, search_text, care_event_id)
       VALUES (?,?,'test',?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), b.person, resultId, date, resolved.parameter,
           [result, b.unit].filter(Boolean).join(' '), context,
           abnormal ? 'Out of range' : '', summary.toLowerCase(), b.careEventId ?? null),
  ]);

  return c.json({ recordId, resultId, parameter: resolved.parameter, abnormal });
});

/* ---------------------------------------------------------------- */
/* Test-name standardisation, editable by hand                       */
/* ---------------------------------------------------------------- */

records.get('/aliases/list', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.alias_key, a.original, a.parameter, a.unit, a.source,
            (SELECT COUNT(*) FROM health_test_results t WHERE t.parameter = a.parameter AND t.deleted = 0) uses
       FROM health_parameter_aliases a
      WHERE a.source <> 'seed'
      ORDER BY a.updated_at DESC LIMIT 200`
  ).all();
  return c.json(results);
});

/** Correct a mapping by hand, and re-point every result that used it. */
records.put('/aliases/:key', async (c) => {
  const caller = c.get('caller');
  if (caller.role !== 'owner') throw new Error('Only the owner can change test names.');

  const key = c.req.param('key');
  const { parameter, unit } = await c.req.json<{ parameter: string; unit: string }>();
  const clean = String(parameter ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Enter the standard name for this test.');

  const existing = await c.env.DB.prepare(
    `SELECT parameter FROM health_parameter_aliases WHERE alias_key = ?`
  ).bind(key).first<{ parameter: string }>();
  if (!existing) throw new Error('That mapping no longer exists.');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE health_parameter_aliases SET parameter=?, unit=?, source='manual', updated_at=datetime('now')
        WHERE alias_key = ?`
    ).bind(clean, String(unit ?? ''), key),
    c.env.DB.prepare(
      `UPDATE health_test_results SET parameter = ? WHERE parameter = ? AND deleted = 0`
    ).bind(clean, existing.parameter),
    c.env.DB.prepare(
      `UPDATE health_timeline SET title = ? WHERE kind = 'test' AND title = ?`
    ).bind(clean, existing.parameter),
    c.env.DB.prepare(`INSERT INTO core_audit_log (actor, action, ref_id, detail) VALUES (?, 'alias_edited', ?, ?)`)
      .bind(caller.email, key, `${existing.parameter} \u2192 ${clean}`),
  ]);

  clearCanonicalCache();
  return c.json({ ok: true, parameter: clean });
});

function label(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/, (ch) => ch.toUpperCase())
    .replace('Ref range text', 'Reference range')
    .replace('Parameter raw', 'Test name as printed')
    .replace('Unit raw', 'Unit as printed')
    .replace('Result text', 'Result')
    .replace('Duration text', 'Duration')
    .replace('Prescribed on', 'Prescribed')
    .replace('Noted on', 'Noted');
}

function assertScope(caller: Caller, personId: string): void {
  if (caller.personIds !== 'all' && !caller.personIds.includes(personId)) {
    throw new Error('You do not have access to this person\u2019s records.');
  }
}
