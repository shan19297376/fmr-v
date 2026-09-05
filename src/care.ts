/**
 * Medicines and reminders.
 *
 * Records tell you what happened. These two tell you what to do next, which is
 * the part a family actually opens the app for: is Mum still on this, and when
 * is the next appointment.
 *
 * Ongoing medicines are the delicate bit. v4 assumed anything without an end
 * date ran for 90 days, so finished courses lingered as current. Here a
 * medicine is active only when its end date says so, or you have said so
 * explicitly. Everything else reads "unconfirmed" and asks.
 */

import { Hono } from 'hono';
import type { Env, Caller } from './index';
import { parseDate, today, displayDate } from './format';

type Ctx = { Bindings: Env; Variables: { caller: Caller } };

export const care = new Hono<Ctx>();

function assertScope(caller: Caller, personId: string | null | undefined): string {
  if (!personId) throw new Error('Which person?');
  if (caller.personIds !== 'all' && !caller.personIds.includes(personId)) {
    throw new Error('You do not have access to this person\u2019s records.');
  }
  return personId;
}
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* ================================================================== */
/* Medicines                                                           */
/* ================================================================== */

/** Split into what someone is on now and what they have finished. */
care.get('/medicines', async (c) => {
  const person = assertScope(c.get('caller'), c.req.query('person'));
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, r.event_date, r.doctor, r.facility
       FROM health_medicines m LEFT JOIN health_records r USING (record_id)
      WHERE m.person_id = ? AND m.deleted = 0
      ORDER BY m.prescribed_on DESC`
  ).bind(person).all<any>();

  const now = today();
  const isCurrent = (m: any) =>
    m.status === 'active' || (m.status === 'unknown' && (!m.end_date || m.end_date >= now));

  return c.json({
    active: results.filter((m) => isCurrent(m) && m.status !== 'unknown'),
    unconfirmed: results.filter((m) => m.status === 'unknown'),
    past: results.filter((m) => !isCurrent(m) && m.status !== 'unknown'),
  });
});

/** Add a medicine nobody wrote a prescription for — an over-the-counter one, say. */
care.post('/medicines', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');
  const b = await c.req.json<any>();
  const person = assertScope(caller, b.person);
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('What is the medicine called?');

  const start = parseDate(b.start_date) || today();
  const id = crypto.randomUUID();
  const status = b.ongoing ? 'active' : (b.end_date ? 'active' : 'unknown');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO health_medicines (medicine_id, person_id, prescribed_on, name, strength, dose,
                              frequency, instructions, start_date, end_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, person, start, name, b.strength ?? '', b.dose ?? '', b.frequency ?? '',
           b.instructions ?? '', start, parseDate(b.end_date) || null, status),
    c.env.DB.prepare(
      `INSERT INTO health_timeline (entry_id, person_id, kind, ref_id, date, title, value, detail, flag, search_text)
       VALUES (?,?,'medicine',?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), person, id, start,
           [name, b.strength].filter(Boolean).join(' '),
           [b.dose, b.frequency].filter(Boolean).join(' \u00b7 '),
           String(b.instructions ?? ''), status,
           `${name} ${b.dose ?? ''}`.toLowerCase()),
  ]);
  return c.json({ medicineId: id });
});

/** Stop today, mark as continuing indefinitely, or extend by a number of days. */
care.post('/medicines/:id/:action', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');
  const id = c.req.param('id');
  const action = c.req.param('action');

  const m = await c.env.DB.prepare(
    `SELECT person_id, name, end_date FROM health_medicines WHERE medicine_id = ? AND deleted = 0`
  ).bind(id).first<any>();
  if (!m) throw new Error('Medicine not found.');
  assertScope(caller, m.person_id);

  let status = 'active';
  let endDate: string | null = null;

  if (action === 'stop') { status = 'stopped'; endDate = today(); }
  else if (action === 'ongoing') { status = 'active'; endDate = null; }
  else if (action === 'extend') {
    const { days } = await c.req.json<{ days: number }>();
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    endDate = addDays(m.end_date && m.end_date > today() ? m.end_date : today(), n);
  } else throw new Error('Unknown action.');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE health_medicines SET status = ?, end_date = ? WHERE medicine_id = ?`)
      .bind(status, endDate, id),
    c.env.DB.prepare(`UPDATE health_timeline SET flag = ? WHERE ref_id = ?`).bind(status, id),
    c.env.DB.prepare(`INSERT INTO core_audit_log (actor, action, ref_id, detail) VALUES (?, ?, ?, ?)`)
      .bind(caller.email, 'medicine_' + action, id, m.name),
  ]);

  // Running out soon is worth a nudge; running indefinitely is not.
  if (endDate && status === 'active') await upsertReminder(c.env, {
    personId: m.person_id, kind: 'medicine', sourceRef: id,
    title: m.name + ' runs out', detail: 'Reorder or ask whether to continue.',
    dueDate: addDays(endDate, -3),
  });

  return c.json({ ok: true, status, endDate });
});

/* ================================================================== */
/* Reminders                                                           */
/* ================================================================== */

/** Everything due, across everyone the caller can see. */
care.get('/reminders', async (c) => {
  const caller = c.get('caller');
  const scope = caller.personIds === 'all'
    ? { sql: '1=1', binds: [] as string[] }
    : { sql: `r.person_id IN (${caller.personIds.map(() => '?').join(',')})`, binds: caller.personIds };

  const { results } = await c.env.DB.prepare(
    `SELECT r.*, p.name person FROM core_reminders r JOIN core_people p USING (person_id)
      WHERE r.status = 'pending' AND ${scope.sql}
      ORDER BY r.due_date LIMIT 60`
  ).bind(...scope.binds).all<any>();

  const now = today();
  return c.json({
    overdue: results.filter((r) => r.due_date < now),
    today: results.filter((r) => r.due_date === now),
    upcoming: results.filter((r) => r.due_date > now),
  });
});

care.post('/reminders', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');
  const b = await c.req.json<any>();
  const person = assertScope(caller, b.person);
  const title = String(b.title ?? '').trim().slice(0, 160);
  const due = parseDate(b.due_date);
  if (!title || !due) throw new Error('A reminder needs something to do and a date.');

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO core_reminders (reminder_id, person_id, kind, title, detail, due_date, repeat_days, created_by)
     VALUES (?,?,'custom',?,?,?,?,?)`
  ).bind(id, person, title, b.detail ?? '', due, Number(b.repeat_days) || 0, caller.email).run();
  return c.json({ reminderId: id });
});

/** Done, dismissed, or pushed out. A repeating reminder reschedules itself. */
care.post('/reminders/:id/:action', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new Error('Read-only access.');
  const id = c.req.param('id');
  const action = c.req.param('action');

  const r = await c.env.DB.prepare(`SELECT * FROM core_reminders WHERE reminder_id = ?`)
    .bind(id).first<any>();
  if (!r) throw new Error('Reminder not found.');
  assertScope(caller, r.person_id);

  if (action === 'snooze') {
    const { days } = await c.req.json<{ days?: number }>().catch(() => ({ days: 7 }));
    await c.env.DB.prepare(`UPDATE core_reminders SET due_date = ? WHERE reminder_id = ?`)
      .bind(addDays(today(), Math.min(Math.max(Number(days) || 7, 1), 365)), id).run();
    return c.json({ ok: true, snoozed: true });
  }

  if (action !== 'done' && action !== 'dismiss') throw new Error('Unknown action.');

  // A repeating reminder is never really finished; it just moves on.
  if (action === 'done' && r.repeat_days > 0) {
    await c.env.DB.prepare(`UPDATE core_reminders SET due_date = ? WHERE reminder_id = ?`)
      .bind(addDays(r.due_date > today() ? r.due_date : today(), r.repeat_days), id).run();
    return c.json({ ok: true, repeated: true });
  }

  await c.env.DB.prepare(`UPDATE core_reminders SET status = ? WHERE reminder_id = ?`)
    .bind(action === 'done' ? 'done' : 'dismissed', id).run();

  // Ticking off a follow-up reminder should tick off the follow-up itself.
  if (action === 'done' && r.kind === 'followup' && r.source_ref) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE health_follow_ups SET status = 'completed' WHERE follow_up_id = ?`).bind(r.source_ref),
      c.env.DB.prepare(`UPDATE health_timeline SET flag = 'completed' WHERE ref_id = ?`).bind(r.source_ref),
    ]);
  }
  return c.json({ ok: true });
});

/** Idempotent: the nightly job calls this repeatedly for the same source. */
export async function upsertReminder(env: Env, r: {
  personId: string; kind: string; sourceRef: string | null;
  title: string; detail?: string; dueDate: string; repeatDays?: number;
}): Promise<void> {
  if (!r.dueDate) return;
  await env.DB.prepare(
    `INSERT INTO core_reminders (reminder_id, person_id, kind, title, detail, due_date, repeat_days, source_ref)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(source_ref, kind) DO UPDATE SET
       due_date = excluded.due_date, title = excluded.title, detail = excluded.detail
     WHERE reminders.status = 'pending'`
  ).bind(crypto.randomUUID(), r.personId, r.kind, r.title.slice(0, 160),
         r.detail ?? '', r.dueDate, r.repeatDays ?? 0, r.sourceRef).run();
}

/**
 * Nightly sweep: turn open follow-ups and medicines about to run out into
 * reminders. Runs from the cron trigger, so nothing depends on the app being
 * open.
 */
export async function refreshReminders(env: Env): Promise<{ created: number }> {
  const soon = addDays(today(), 14);

  const [follow, meds] = await env.DB.batch([
    env.DB.prepare(
      `SELECT follow_up_id, person_id, due_date, type, instruction FROM health_follow_ups
        WHERE deleted = 0 AND status = 'pending' AND due_date IS NOT NULL AND due_date <= ?`
    ).bind(soon),
    env.DB.prepare(
      `SELECT medicine_id, person_id, name, end_date FROM health_medicines
        WHERE deleted = 0 AND status = 'active' AND end_date IS NOT NULL AND end_date <= ?`
    ).bind(soon),
  ]);

  let created = 0;
  for (const f of follow.results as any[]) {
    await upsertReminder(env, {
      personId: f.person_id, kind: 'followup', sourceRef: f.follow_up_id,
      title: f.instruction || f.type || 'Follow-up', detail: 'From a filed report.',
      dueDate: f.due_date,
    });
    created++;
  }
  for (const m of meds.results as any[]) {
    await upsertReminder(env, {
      personId: m.person_id, kind: 'medicine', sourceRef: m.medicine_id,
      title: m.name + ' runs out', detail: 'Reorder, or ask whether to continue.',
      dueDate: addDays(m.end_date, -3),
    });
    created++;
  }

  // Close out reminders whose source has since been dealt with.
  await env.DB.prepare(
    `UPDATE core_reminders SET status = 'done'
      WHERE status = 'pending' AND kind = 'followup' AND source_ref IN
        (SELECT follow_up_id FROM health_follow_ups WHERE status <> 'pending' OR deleted = 1)`
  ).run();

  return { created };
}

/** The single next thing due for one person — used on the overview. */
export async function nextDue(env: Env, personId: string): Promise<any | null> {
  return env.DB.prepare(
    `SELECT reminder_id, kind, title, detail, due_date FROM core_reminders
      WHERE person_id = ? AND status = 'pending' ORDER BY due_date LIMIT 1`
  ).bind(personId).first();
}
