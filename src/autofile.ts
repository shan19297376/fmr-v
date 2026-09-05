/**
 * Filing a report without anyone reviewing it.
 *
 * The intent is: drop ten documents from the last two years and come back to
 * them sorted — by person, by episode of care, by type — with every value
 * captured. No form filling.
 *
 * The judgement that matters is when NOT to do this. A report the reader could
 * not place, could not date, or could not get anything out of is worse than
 * useless once filed, because it looks like a record and isn't one. Those stop
 * and wait for you. Everything else files itself and tells you what it did.
 */

import type { Env } from './index';
import type { Extraction } from './gemini';
import { approveJob } from './approve';
import { upsertReminder } from './care';
import { displayDate } from './format';

/** How far apart two documents can be and still belong to the same episode. */
const DEFAULT_WINDOW_DAYS = 14;

const daysBetween = (a: string, b: string) =>
  Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400000));

/**
 * Find the episode this document belongs to, or start one.
 *
 * Two documents join up when they are close in time. A prescription, the lab
 * report it asked for and the pharmacy bill are typically days apart, so a
 * fortnight window collects a visit without swallowing the next one. A shared
 * facility widens that; a different facility narrows it, because two hospitals
 * in the same fortnight are usually two different things.
 */
export async function findOrCreateEpisode(
  env: Env, personId: string, date: string, facility: string, recordType: string
): Promise<{ careEventId: string; created: boolean }> {

  const setting = await env.DB.prepare(`SELECT value FROM core_settings WHERE key='episode_window_days'`)
    .first<{ value: string }>();
  const window = Number(setting?.value) || DEFAULT_WINDOW_DAYS;

  const { results } = await env.DB.prepare(
    `SELECT care_event_id, event_date, facility, title,
            (SELECT MIN(t.date) FROM health_timeline t WHERE t.care_event_id = e.care_event_id AND t.deleted = 0) first_date,
            (SELECT MAX(t.date) FROM health_timeline t WHERE t.care_event_id = e.care_event_id AND t.deleted = 0) last_date
       FROM health_care_events e
      WHERE person_id = ? AND deleted = 0
        AND event_date BETWEEN date(?, '-60 days') AND date(?, '+60 days')`
  ).bind(personId, date, date).all<any>();

  const sameFacility = (a: string, b: string) => {
    const n = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return Boolean(n(a)) && Boolean(n(b)) && (n(a).includes(n(b)) || n(b).includes(n(a)));
  };

  let best: { id: string; gap: number } | null = null;
  for (const e of results) {
    const anchors = [e.event_date, e.first_date, e.last_date].filter(Boolean) as string[];
    const gap = Math.min(...anchors.map((a) => daysBetween(a, date)));
    const allowed = sameFacility(e.facility, facility) ? window * 2 : window;
    if (gap <= allowed && (!best || gap < best.gap)) best = { id: e.care_event_id, gap };
  }
  if (best) return { careEventId: best.id, created: false };

  const careEventId = crypto.randomUUID();
  const title = facility
    ? `${facility} \u00b7 ${displayDate(date)}`
    : `Care around ${displayDate(date)}`;

  await env.DB.prepare(
    `INSERT INTO health_care_events (care_event_id, person_id, event_date, event_type, title, facility, auto_created)
     VALUES (?,?,?,?,?,?,1)`
  ).bind(careEventId, personId, date, recordType || 'Other', title.slice(0, 180), facility || '').run();

  return { careEventId, created: true };
}

/** Is there enough here to file without a person looking at it? */
export function canAutoFile(data: Extraction, personId: string | null): { ok: boolean; why: string } {
  if (!personId) return { ok: false, why: 'The name on this report did not match anyone.' };
  if (!data.event_date) return { ok: false, why: 'No date could be read from this document.' };

  const captured = data.tests.length + data.medicines.length + data.diagnoses.length +
    data.bills.length + data.follow_ups.length;
  if (!captured && !data.summary) {
    return { ok: false, why: 'Nothing could be read from this document.' };
  }
  // A page the reader flagged as unclear is exactly the page worth checking.
  if (data.uncertain_fields.length > 3) {
    return { ok: false, why: 'Several fields were hard to read.' };
  }
  return { ok: true, why: '' };
}

/**
 * File a finished job: put it in the right episode, write the records, raise
 * reminders for anything it asks you to come back for.
 *
 * Used by the automatic path and by the review screen, so both behave the same.
 */
export async function fileJob(
  env: Env, job: any, data: Extraction, files: any[], actor: string, autoEpisode: boolean
): Promise<{ recordId: string; counts: Record<string, number>; careEventId: string | null; episodeCreated: boolean }> {

  let careEventId: string | null = job.care_event_id ?? null;
  let episodeCreated = false;

  if (!careEventId && autoEpisode) {
    const ep = await findOrCreateEpisode(
      env, job.person_id, data.event_date, data.facility, data.record_type
    );
    careEventId = ep.careEventId;
    episodeCreated = ep.created;
    await env.DB.prepare(`UPDATE core_jobs SET care_event_id = ? WHERE job_id = ?`)
      .bind(careEventId, job.job_id).run();
  }

  const out = await approveJob(
    env, job.job_id, job.person_id, job.person_name ?? '', careEventId, data, files, actor
  );

  for (const f of data.follow_ups) {
    if (!f.due_date) continue;
    await upsertReminder(env, {
      personId: job.person_id, kind: 'followup', sourceRef: null,
      title: f.instruction || f.type || 'Follow-up',
      detail: 'From ' + (data.facility || data.record_type), dueDate: f.due_date,
    });
  }

  await env.DB.prepare(
    `UPDATE core_jobs SET filed_at = datetime('now'), record_id = ? WHERE job_id = ?`
  ).bind(out.recordId, job.job_id).run();

  return { ...out, careEventId, episodeCreated };
}

/**
 * Called from the queue once every file in a job has been read. Files the job
 * outright when it safely can, and otherwise leaves it for review with the
 * reason showing.
 */
export async function tryAutoFile(env: Env, jobId: string, data: Extraction): Promise<boolean> {
  const job = await env.DB.prepare(
    `SELECT j.*, p.name person_name FROM core_jobs j LEFT JOIN core_people p ON p.person_id = j.person_id
      WHERE j.job_id = ?`
  ).bind(jobId).first<any>();
  if (!job) return false;

  if (!job.auto_file) {
    await env.DB.prepare(
      `UPDATE core_jobs SET needs_attention = 1, updated_at = datetime('now') WHERE job_id = ?`
    ).bind(jobId).run();
    return false;
  }

  const verdict = canAutoFile(data, job.person_id);
  if (!verdict.ok) {
    await env.DB.prepare(
      `UPDATE core_jobs SET status='review', needs_attention = 1, message=?,
              updated_at=datetime('now') WHERE job_id = ?`
    ).bind(verdict.why, jobId).run();
    return false;
  }

  const { results: files } = await env.DB.prepare(
    `SELECT job_file_id, file_name, mime_type, bytes, r2_key, content_sha256
       FROM core_job_files WHERE job_id = ? ORDER BY file_index`
  ).bind(jobId).all<any>();
  if (!files.length) return false;

  try {
    const out = await fileJob(env, job, data, files, job.created_by ?? 'auto', true);
    await env.DB.prepare(
      `INSERT INTO core_audit_log (actor, action, ref_id, detail) VALUES (?, 'auto_filed', ?, ?)`
    ).bind(job.created_by ?? 'auto', out.recordId,
           `${job.person_name}: ${data.record_type} on ${data.event_date}`).run();
    return true;
  } catch (err) {
    await env.DB.prepare(
      `UPDATE core_jobs SET status='review', message=?, updated_at=datetime('now') WHERE job_id = ?`
    ).bind('Could not file automatically: ' + String(err instanceof Error ? err.message : err).slice(0, 200), jobId).run();
    await env.DB.prepare(`UPDATE core_jobs SET needs_attention = 1 WHERE job_id = ?`).bind(jobId).run();
    return false;
  }
}
