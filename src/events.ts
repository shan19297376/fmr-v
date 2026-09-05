/**
 * Care events.
 *
 * A hospital admission produces an admission note, four lab reports, a
 * discharge summary and three bills. Individually they are noise; grouped under
 * one event they are a story you can hand to a doctor.
 *
 * This is the v4 "Care Events" tab, with the pieces it was missing: you can
 * promote a record you have already filed into an event, and move records
 * between events after the fact.
 */

import { Hono } from 'hono';
import type { Env, Caller } from './index';
import { parseDate } from './format';

type Ctx = { Bindings: Env; Variables: { caller: Caller } };

const TYPES = [
  'Doctor Visit', 'Prescription', 'Lab Test', 'Imaging', 'Hospital Admission',
  'Discharge Summary', 'Vaccination', 'Procedure', 'Bill / Insurance', 'Other',
];

export const events = new Hono<Ctx>();

/** Events for one person, each with what it contains. */
events.get('/', async (c) => {
  const person = c.req.query('person');
  assertScope(c.get('caller'), person);

  const { results } = await c.env.DB.prepare(
    `SELECT e.care_event_id, e.event_date, e.event_type, e.title, e.facility, e.notes, e.auto_created,
            (SELECT COUNT(*) FROM health_timeline t WHERE t.care_event_id = e.care_event_id AND t.deleted = 0) items,
            (SELECT MIN(t.date) FROM health_timeline t WHERE t.care_event_id = e.care_event_id AND t.deleted = 0) first_date,
            (SELECT MAX(t.date) FROM health_timeline t WHERE t.care_event_id = e.care_event_id AND t.deleted = 0) last_date
       FROM health_care_events e
      WHERE e.person_id = ? AND e.deleted = 0
      ORDER BY e.event_date DESC`
  ).bind(person).all();
  return c.json(results);
});

/** Everything filed under one event, on one timeline. */
events.get('/:id', async (c) => {
  const id = c.req.param('id');
  const event = await c.env.DB.prepare(
    `SELECT * FROM health_care_events WHERE care_event_id = ? AND deleted = 0`
  ).bind(id).first<any>();
  if (!event) throw new Error('That event no longer exists.');
  assertScope(c.get('caller'), event.person_id);

  const { results } = await c.env.DB.prepare(
    `SELECT kind, ref_id, date, title, value, detail, flag FROM health_timeline
      WHERE care_event_id = ? AND deleted = 0 ORDER BY date DESC, kind`
  ).bind(id).all();

  return c.json({ event, items: results });
});

events.post('/', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const b = await c.req.json<{
    person: string; date: string; title: string;
    type?: string; facility?: string; notes?: string;
  }>();
  assertScope(caller, b.person);

  const date = parseDate(b.date);
  const title = String(b.title ?? '').trim().slice(0, 180);
  if (!date || !title) throw new Error('An event needs a date and a name.');

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO health_care_events (care_event_id, person_id, event_date, event_type, title, facility, notes)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, b.person, date, TYPES.includes(String(b.type)) ? b.type : 'Other',
         title, b.facility ?? '', b.notes ?? '').run();

  return c.json({ careEventId: id, title, date });
});

events.put('/:id', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT person_id FROM health_care_events WHERE care_event_id = ? AND deleted = 0`
  ).bind(id).first<{ person_id: string }>();
  if (!row) throw new Error('That event no longer exists.');
  assertScope(caller, row.person_id);

  const b = await c.req.json<{ date?: string; title?: string; type?: string; facility?: string; notes?: string }>();
  await c.env.DB.prepare(
    `UPDATE health_care_events SET event_date=COALESCE(?,event_date), title=COALESCE(?,title),
            event_type=COALESCE(?,event_type), facility=COALESCE(?,facility), notes=COALESCE(?,notes),
            updated_at=datetime('now')
      WHERE care_event_id = ?`
  ).bind(parseDate(b.date ?? '') || null, b.title ?? null,
         TYPES.includes(String(b.type)) ? b.type : null, b.facility ?? null, b.notes ?? null, id).run();

  return c.json({ ok: true });
});

/** Unlinking is safe: records survive, they just stop being grouped. */
events.delete('/:id', async (c) => {
  const caller = c.get('caller');
  if (caller.role !== 'owner') throw new Error('Only the owner can remove events.');

  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT person_id FROM health_care_events WHERE care_event_id = ?`
  ).bind(id).first<{ person_id: string }>();
  if (!row) throw new Error('Already gone.');
  assertScope(caller, row.person_id);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE health_care_events SET deleted = 1 WHERE care_event_id = ?`).bind(id),
    c.env.DB.prepare(`UPDATE health_records SET care_event_id = NULL WHERE care_event_id = ?`).bind(id),
    c.env.DB.prepare(`UPDATE health_timeline SET care_event_id = NULL WHERE care_event_id = ?`).bind(id),
    c.env.DB.prepare(`INSERT INTO core_audit_log (actor, action, ref_id) VALUES (?, 'event_removed', ?)`)
      .bind(caller.email, id),
  ]);
  return c.json({ ok: true });
});

/** File an existing record under an event, or pull it out with careEventId null. */
events.post('/link', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const { recordId, careEventId } = await c.req.json<{ recordId: string; careEventId: string | null }>();
  const record = await c.env.DB.prepare(
    `SELECT person_id FROM health_records WHERE record_id = ? AND deleted = 0`
  ).bind(recordId).first<{ person_id: string }>();
  if (!record) throw new Error('Record not found.');
  assertScope(caller, record.person_id);

  if (careEventId) {
    const event = await c.env.DB.prepare(
      `SELECT person_id FROM health_care_events WHERE care_event_id = ? AND deleted = 0`
    ).bind(careEventId).first<{ person_id: string }>();
    if (!event) throw new Error('That event no longer exists.');
    if (event.person_id !== record.person_id) throw new Error('That event belongs to someone else.');
  }

  // Everything filed from the same upload moves together.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE health_records SET care_event_id = ?, updated_at = datetime('now') WHERE record_id = ?`)
      .bind(careEventId, recordId),
    c.env.DB.prepare(`UPDATE health_timeline SET care_event_id = ? WHERE ref_id = ? OR ref_id IN (
        SELECT result_id FROM health_test_results WHERE record_id = ?
        UNION ALL SELECT medicine_id FROM health_medicines WHERE record_id = ?
        UNION ALL SELECT diagnosis_id FROM health_diagnoses WHERE record_id = ?
        UNION ALL SELECT follow_up_id FROM health_follow_ups WHERE record_id = ?
        UNION ALL SELECT bill_id FROM health_bills WHERE record_id = ?
        UNION ALL SELECT document_id FROM core_documents WHERE record_id = ?)`)
      .bind(careEventId, recordId, recordId, recordId, recordId, recordId, recordId, recordId),
  ]);
  return c.json({ ok: true });
});

/** Turn a record you already filed into an event, and put it inside. */
events.post('/promote/:recordId', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');

  const recordId = c.req.param('recordId');
  const r = await c.env.DB.prepare(
    `SELECT * FROM health_records WHERE record_id = ? AND deleted = 0`
  ).bind(recordId).first<any>();
  if (!r) throw new Error('Record not found.');
  assertScope(caller, r.person_id);

  if (r.care_event_id) {
    const existing = await c.env.DB.prepare(
      `SELECT * FROM health_care_events WHERE care_event_id = ? AND deleted = 0`
    ).bind(r.care_event_id).first();
    if (existing) return c.json({ careEventId: r.care_event_id, existing: true });
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO health_care_events (care_event_id, person_id, event_date, event_type, title, facility, notes)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, r.person_id, r.event_date,
         TYPES.includes(r.record_type) ? r.record_type : 'Other',
         (r.summary || r.record_type || 'Medical event').slice(0, 180),
         r.facility ?? '', [r.reason, r.key_findings].filter(Boolean).join(' \u00b7 ')).run();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE health_records SET care_event_id = ? WHERE record_id = ?`).bind(id, recordId),
    c.env.DB.prepare(`UPDATE health_timeline SET care_event_id = ? WHERE ref_id = ? OR ref_id IN (
        SELECT result_id FROM health_test_results WHERE record_id = ?
        UNION ALL SELECT medicine_id FROM health_medicines WHERE record_id = ?
        UNION ALL SELECT diagnosis_id FROM health_diagnoses WHERE record_id = ?
        UNION ALL SELECT follow_up_id FROM health_follow_ups WHERE record_id = ?
        UNION ALL SELECT bill_id FROM health_bills WHERE record_id = ?
        UNION ALL SELECT document_id FROM core_documents WHERE record_id = ?)`)
      .bind(id, recordId, recordId, recordId, recordId, recordId, recordId, recordId),
  ]);

  return c.json({ careEventId: id, existing: false });
});

function assertScope(caller: Caller, personId: string | undefined | null): void {
  if (!personId) throw new Error('Which person?');
  if (caller.personIds !== 'all' && !caller.personIds.includes(personId)) {
    throw new Error('You do not have access to this person\u2019s records.');
  }
}
