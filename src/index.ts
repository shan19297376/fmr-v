/**
 * FAMILY MEDICAL RECORDS — Cloudflare Worker
 *
 * Serves the PWA and the JSON API from one deployment.
 *
 * Security model, in order:
 *   1. Cloudflare Access blocks anyone not on the allowlist before we run at all.
 *   2. verifyAccess() below re-checks the signed JWT, so a leaked Worker URL is useless.
 *   3. scopeFor() decides which people this email may see. Every query goes through it.
 *
 * Rule for anyone editing this file: never build SQL that touches person data
 * without passing the scope. There is one helper for it and no exceptions.
 */

import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { putDocument, getDocument, objectKey, documentFileName } from './storage';
import { buildWorkbook, buildDocumentArchive, exportFileName } from './export';
import { readDocument, mergeExtractions, normalise, type Extraction } from './gemini';
import { approveJob } from './approve';
import { records } from './records';
import { events } from './events';
import { displayDate, parseDate, today as todayIso } from './format';
import { handoutHtml } from './handout';

export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  OCR: Queue<OcrMessage>;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TIMEZONE: string;
  APP_TITLE: string;
  GEMINI_API_KEY: string;
  DOC_ENCRYPTION_KEY: string;
}

export interface OcrMessage {
  jobId: string;
  jobFileId: string;
  r2Key: string;
  mimeType: string;
}

export type Caller = {
  email: string;
  role: 'owner' | 'member' | 'viewer';
  personIds: string[] | 'all';
};

const app = new Hono<{ Bindings: Env; Variables: { caller: Caller } }>();

/* ------------------------------------------------------------------ */
/* 1. Authentication                                                   */
/* ------------------------------------------------------------------ */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function verifyAccess(env: Env, req: Request): Promise<string> {
  const token =
    req.headers.get('Cf-Access-Jwt-Assertion') ||
    (req.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];

  if (!token) throw new HttpError(401, 'Not signed in.');

  jwks ??= createRemoteJWKSet(
    new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
  );

  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience: env.ACCESS_AUD,
  });

  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new HttpError(401, 'No identity on this request.');
  return email;
}

/** Turns a verified email into the set of people they are allowed to see. */
async function scopeFor(env: Env, email: string): Promise<Caller> {
  const row = await env.DB.prepare(
    `SELECT role, scope_person_id, expires_at FROM app_users WHERE email = ?`
  ).bind(email).first<{ role: string; scope_person_id: string | null; expires_at: string | null }>();

  // First person through the door becomes the owner. After that, Access decides
  // who may knock, and this table decides what they see.
  if (!row) {
    const { count } = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM app_users`
    ).first<{ count: number }>() ?? { count: 0 };

    if (count === 0) {
      await env.DB.prepare(
        `INSERT INTO app_users (email, role, display_name) VALUES (?, 'owner', ?)`
      ).bind(email, email.split('@')[0]).run();
      return { email, role: 'owner', personIds: 'all' };
    }
    throw new HttpError(403, 'Your account has not been given access to any records yet.');
  }

  if (row.expires_at && row.expires_at < todayIso()) {
    throw new HttpError(403, 'Your access to these records has expired.');
  }

  return {
    email,
    role: row.role as Caller['role'],
    personIds: row.scope_person_id ? [row.scope_person_id] : 'all',
  };
}

/** The only sanctioned way to filter a query by person. */
function scopeClause(caller: Caller, column = 'person_id'): { sql: string; binds: string[] } {
  if (caller.personIds === 'all') return { sql: '1=1', binds: [] };
  const marks = caller.personIds.map(() => '?').join(',');
  return { sql: `${column} IN (${marks})`, binds: caller.personIds };
}

app.use('/api/*', async (c, next) => {
  const email = await verifyAccess(c.env, c.req.raw);
  c.set('caller', await scopeFor(c.env, email));
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE app_users SET last_seen_at = datetime('now') WHERE email = ?`)
      .bind(email).run()
  );
  await next();
});

/* ------------------------------------------------------------------ */
/* 2. Read API — everything the app needs to draw a screen             */
/* ------------------------------------------------------------------ */

app.get('/api/me', async (c) => {
  const caller = c.get('caller');
  const connected = await setting(c.env, 'storage_backend');
  return c.json({
    email: caller.email,
    role: caller.role,
    title: c.env.APP_TITLE,
    storage: connected || 'r2',
    today: todayIso(),
  });
});

app.get('/api/people', async (c) => {
  const s = scopeClause(c.get('caller'));
  const { results } = await c.env.DB.prepare(
    `SELECT p.person_id, p.name, pr.date_of_birth, pr.blood_group, pr.allergies,
            pr.chronic_conditions, pr.emergency_contact
       FROM people p LEFT JOIN profiles pr USING (person_id)
      WHERE p.active = 1 AND ${s.sql}
      ORDER BY p.sort_order, p.name`
  ).bind(...s.binds).all();
  return c.json(results);
});

/**
 * The whole history for one person, one page at a time.
 * In v4 this needed a hidden index sheet per person, rebuilt on every write.
 * Here it is one indexed table, appended to as records are filed, never rebuilt.
 */
app.get('/api/timeline', async (c) => {
  const caller = c.get('caller');
  const person = requirePerson(caller, c.req.query('person'));
  const kind = c.req.query('kind') || 'all';
  const page = Math.max(0, Number(c.req.query('page') || 0));
  const size = 25;

  const kindSql = kind === 'all' ? '' : 'AND kind = ?';
  const binds: unknown[] = kind === 'all' ? [person] : [person, kind];

  const { results } = await c.env.DB.prepare(
    `SELECT kind, ref_id, date, title, value, detail, flag, care_event_id
       FROM timeline
      WHERE person_id = ? AND deleted = 0 ${kindSql}
      ORDER BY date DESC, kind
      LIMIT ? OFFSET ?`
  ).bind(...binds, size + 1, page * size).all();

  const hasMore = results.length > size;
  return c.json({ page, hasMore, items: results.slice(0, size) });
});

/** Which tests this person has, and whether each is chartable. */
app.get('/api/trends', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const { results } = await c.env.DB.prepare(
    `SELECT parameter, unit,
            COUNT(*)                                   AS total,
            SUM(CASE WHEN value_a IS NOT NULL THEN 1 ELSE 0 END) AS chartable,
            SUM(is_abnormal)                           AS flagged,
            MAX(test_date)                             AS latest
       FROM test_results
      WHERE person_id = ? AND deleted = 0
      GROUP BY parameter, unit
      ORDER BY flagged DESC, latest DESC`
  ).bind(person).all();
  return c.json(results);
});

/** One test over time, with the reference band for shading the chart. */
app.get('/api/trends/series', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const parameter = c.req.query('parameter');
  if (!parameter) throw new HttpError(400, 'Which test?');

  const months = { '3m': 3, '6m': 6, '1y': 12, '3y': 36 }[c.req.query('range') || ''] ?? null;
  const cutoff = months ? `date('now','-${months} months')` : `'0000-00-00'`;

  const { results } = await c.env.DB.prepare(
    `SELECT test_date, result_text, value_a, value_b, unit,
            ref_low, ref_high, ref_range_text, flag, is_abnormal, lab, record_id
       FROM test_results
      WHERE person_id = ? AND parameter = ? AND deleted = 0
        AND test_date >= ${cutoff}
      ORDER BY test_date`
  ).bind(person, parameter).all();

  const band = await c.env.DB.prepare(
    `SELECT low, high, unit FROM reference_bands
      WHERE parameter = ? ORDER BY sex = 'any' LIMIT 1`
  ).bind(parameter).first();

  return c.json({ parameter, points: results, band });
});

/** The person card: what a doctor would ask first. */
app.get('/api/snapshot', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const [profile, meds, followUps, abnormal, lastVisit] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM profiles WHERE person_id = ?`).bind(person),
    c.env.DB.prepare(`SELECT * FROM v_active_medicines WHERE person_id = ? ORDER BY prescribed_on DESC`).bind(person),
    c.env.DB.prepare(`SELECT * FROM v_open_follow_ups WHERE person_id = ? ORDER BY due_date`).bind(person),
    c.env.DB.prepare(
      `SELECT parameter, result_text, unit, test_date, flag FROM v_latest_tests
        WHERE person_id = ? AND rn = 1 AND is_abnormal = 1 ORDER BY test_date DESC LIMIT 8`
    ).bind(person),
    c.env.DB.prepare(
      `SELECT event_date, record_type, summary, facility FROM records
        WHERE person_id = ? AND deleted = 0 ORDER BY event_date DESC LIMIT 1`
    ).bind(person),
  ]);

  return c.json({
    profile: profile.results[0] ?? null,
    activeMedicines: meds.results,
    openFollowUps: followUps.results,
    overdueCount: followUps.results.filter((f: any) => f.due_date && f.due_date < todayIso()).length,
    abnormalTests: abnormal.results,
    lastVisit: lastVisit.results[0] ?? null,
  });
});

/* ------------------------------------------------------------------ */
/* 3. Upload — returns immediately, reads in the background            */
/* ------------------------------------------------------------------ */

app.post('/api/uploads', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');
  const body = await c.req.json<{ person?: string; date?: string; careEventId?: string }>();
  // The person is optional. If it is not given, the reader works out who the
  // report belongs to from the name printed on it.
  const person = body.person ? requirePerson(caller, body.person) : null;
  const jobId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO jobs (job_id, person_id, care_event_id, user_date, status, message, created_by)
     VALUES (?, ?, ?, ?, 'draft', 'Add files, then submit.', ?)`
  ).bind(jobId, person, body.careEventId || null, body.date || todayIso(), caller.email).run();

  return c.json({ jobId });
});

/**
 * Takes one file, encrypts it into R2, queues it for reading, returns.
 * The user is free to upload the next file immediately — no lock, no waiting.
 */
app.post('/api/uploads/:jobId/file', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');

  const jobId = c.req.param('jobId');
  const job = await c.env.DB.prepare(
    `SELECT job_id, person_id, status FROM jobs WHERE job_id = ?`
  ).bind(jobId).first<{ job_id: string; person_id: string | null; status: string }>();
  if (!job) throw new HttpError(404, 'Upload not found.');
  if (job.person_id) requirePerson(caller, job.person_id);
  if (!['draft', 'error'].includes(job.status)) throw new HttpError(409, 'This upload is already being processed.');

  const form = await c.req.formData();
  const file = form.get('file') as unknown as
    { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null;
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'No file received.');
  if (file.size > 30 * 1024 * 1024) throw new HttpError(413, 'Each file must be 30 MB or smaller.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(bytes);

  // Exact duplicate of something already filed? Tell the user before storing it again.
  const dupe = await c.env.DB.prepare(
    `SELECT document_id, person_id, document_date, file_name FROM documents
      WHERE content_sha256 = ? AND deleted = 0`
  ).bind(hash).first();
  if (dupe && form.get('allowDuplicate') !== 'true') {
    return c.json({ duplicate: true, match: dupe }, 409);
  }

  const jobFileId = crypto.randomUUID();
  const r2Key = objectKey(job.person_id ?? 'unassigned', jobFileId);
  await putDocument(c.env, r2Key, bytes, file.type);

  const { count } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM job_files WHERE job_id = ?`
  ).bind(jobId).first<{ count: number }>() ?? { count: 0 };

  await c.env.DB.prepare(
    `INSERT INTO job_files (job_file_id, job_id, file_index, file_name, mime_type,
                            bytes, r2_key, content_sha256, ai_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`
  ).bind(jobFileId, jobId, count + 1, file.name, file.type, file.size, r2Key, hash).run();

  // Hand off to the background reader and return straight away.
  await c.env.OCR.send({ jobId, jobFileId, r2Key, mimeType: file.type });
  await c.env.DB.prepare(
    `UPDATE jobs SET status='queued', message='Reading in the background…',
            updated_at=datetime('now') WHERE job_id = ?`
  ).bind(jobId).run();

  return c.json({ jobFileId, name: file.name, queued: true });
});

/** The app polls this to show progress. Cheap, indexed, no locks. */
app.get('/api/uploads/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE job_id = ?`).bind(jobId).first<any>();
  if (!job) throw new HttpError(404, 'Upload not found.');
  requirePerson(c.get('caller'), job.person_id);
  const { results: files } = await c.env.DB.prepare(
    `SELECT job_file_id, file_name, ai_status, last_error FROM job_files WHERE job_id = ? ORDER BY file_index`
  ).bind(jobId).all();
  return c.json({ ...job, extraction: job.extraction ? JSON.parse(job.extraction) : null, files });
});


/* ------------------------------------------------------------------ */
/* 3b. People                                                          */
/* ------------------------------------------------------------------ */

app.post('/api/people', async (c) => {
  const caller = c.get('caller');
  if (caller.role !== 'owner') throw new HttpError(403, 'Only the owner can add people.');

  const { name } = await c.req.json<{ name: string }>();
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) throw new HttpError(400, 'Enter a name.');

  const exists = await c.env.DB.prepare(
    `SELECT 1 FROM people WHERE lower(name) = lower(?)`
  ).bind(clean).first();
  if (exists) throw new HttpError(409, `${clean} is already in the list.`);

  const personId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO people (person_id, name, sort_order) VALUES (?, ?, (SELECT COUNT(*) FROM people))`
    ).bind(personId, clean),
    c.env.DB.prepare(`INSERT INTO profiles (person_id) VALUES (?)`).bind(personId),
    c.env.DB.prepare(
      `INSERT INTO audit_log (actor, action, ref_id, detail) VALUES (?, 'person_added', ?, ?)`
    ).bind(caller.email, personId, clean),
  ]);

  return c.json({ personId, name: clean });
});


/** Approve what the reader found. Nothing is filed until this is called. */
app.post('/api/uploads/:jobId/approve', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');

  const jobId = c.req.param('jobId');
  const job = await c.env.DB.prepare(
    `SELECT j.*, p.name person_name FROM jobs j LEFT JOIN people p ON p.person_id = j.person_id
      WHERE j.job_id = ?`
  ).bind(jobId).first<any>();
  if (!job) throw new HttpError(404, 'Upload not found.');
  if (!job.person_id) throw new HttpError(400, 'Choose who this report belongs to first.');
  requirePerson(caller, job.person_id);
  if (job.status !== 'review') throw new HttpError(409, `This upload is ${job.status}, not awaiting review.`);

  // The reviewer may have corrected values on screen; theirs win over Gemini's.
  const edited = await c.req.json<Partial<Extraction>>().catch(() => null);
  const data = normalise(edited ?? JSON.parse(job.extraction ?? '{}'));
  if (!data.event_date) throw new HttpError(400, 'A record date is required.');
  if (!data.summary) throw new HttpError(400, 'A short summary is required.');

  const { results: files } = await c.env.DB.prepare(
    `SELECT job_file_id, file_name, mime_type, bytes, r2_key, content_sha256
       FROM job_files WHERE job_id = ? ORDER BY file_index`
  ).bind(jobId).all<any>();
  if (!files.length) throw new HttpError(400, 'No document is attached to this upload.');

  const out = await approveJob(
    c.env, jobId, job.person_id, job.person_name, job.care_event_id, data, files, caller.email
  );
  return c.json(out);
});

app.post('/api/uploads/:jobId/reject', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');

  const jobId = c.req.param('jobId');
  const job = await c.env.DB.prepare(`SELECT person_id, status FROM jobs WHERE job_id = ?`)
    .bind(jobId).first<any>();
  if (!job) throw new HttpError(404, 'Upload not found.');
  requirePerson(caller, job.person_id);
  if (job.status === 'approved') throw new HttpError(409, 'This one has already been filed.');

  // Scans are deleted with the job: an abandoned upload should leave nothing behind.
  const { results: files } = await c.env.DB.prepare(
    `SELECT r2_key FROM job_files WHERE job_id = ?`
  ).bind(jobId).all<{ r2_key: string }>();
  for (const f of files) { try { await c.env.DOCS.delete(f.r2_key); } catch { /* already gone */ } }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE jobs SET status='rejected', message='Discarded.', updated_at=datetime('now') WHERE job_id = ?`).bind(jobId),
    c.env.DB.prepare(`INSERT INTO audit_log (actor, action, ref_id) VALUES (?, 'rejected', ?)`).bind(caller.email, jobId),
  ]);
  return c.json({ ok: true });
});

/** Anything waiting on the reviewer, across everyone this caller can see. */
app.get('/api/inbox', async (c) => {
  const s = scopeClause(c.get('caller'), 'j.person_id');
  const { results } = await c.env.DB.prepare(
    `SELECT j.job_id, j.status, j.message, j.updated_at, j.detected_name, j.person_id,
            COALESCE(p.name, '') person,
            (SELECT COUNT(*) FROM job_files f WHERE f.job_id = j.job_id) files
       FROM jobs j LEFT JOIN people p ON p.person_id = j.person_id
      WHERE j.status IN ('queued','reading','review','error')
        AND (j.person_id IS NULL OR ${s.sql})
      ORDER BY CASE j.status WHEN 'error' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, j.updated_at DESC
      LIMIT 40`
  ).bind(...s.binds).all();
  return c.json(results);
});


/** Set or correct who an upload belongs to, before it is filed. */
app.post('/api/uploads/:jobId/person', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');
  const { person, careEventId } = await c.req.json<{ person: string; careEventId?: string | null }>();
  requirePerson(caller, person);

  await c.env.DB.prepare(
    `UPDATE jobs SET person_id = ?, care_event_id = COALESCE(?, care_event_id),
            message = 'Ready for you to check.', updated_at = datetime('now')
      WHERE job_id = ?`
  ).bind(person, careEventId ?? null, c.req.param('jobId')).run();
  return c.json({ ok: true });
});

/**
 * One panel of tests as a grid: a row per test, a column per date it was taken.
 * This is how a lab prints a report and how a doctor reads one.
 */
app.get('/api/panel', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const category = c.req.query('category');

  const { results } = await c.env.DB.prepare(
    `SELECT t.parameter, t.test_date, t.result_text, t.unit_raw, t.value_a,
            t.ref_range_text, t.ref_low, t.ref_high, t.is_abnormal,
            COALESCE(tc.category, 'Other tests') category, COALESCE(tc.sort_order, 9999) ord
       FROM test_results t
       LEFT JOIN test_categories tc ON tc.parameter = t.parameter
      WHERE t.person_id = ? AND t.deleted = 0
        AND (? IS NULL OR COALESCE(tc.category,'Other tests') = ?)
      ORDER BY ord, t.parameter, t.test_date DESC`
  ).bind(person, category ?? null, category ?? null).all<any>();

  // Newest twelve columns; older values stay reachable on the single-test view.
  const dates = [...new Set(results.map((r) => r.test_date))].sort().reverse().slice(0, 12);
  const byParam = new Map<string, any>();

  for (const r of results) {
    if (!byParam.has(r.parameter)) {
      byParam.set(r.parameter, {
        parameter: r.parameter, category: r.category, unit: r.unit_raw,
        reference: r.ref_range_text, refLow: r.ref_low, refHigh: r.ref_high,
        values: {}, chartable: 0, total: 0,
      });
    }
    const row = byParam.get(r.parameter);
    row.total++;
    if (r.value_a !== null) row.chartable++;
    if (!row.values[r.test_date]) {
      row.values[r.test_date] = { text: r.result_text, abnormal: !!r.is_abnormal };
    }
    if (!row.reference && r.ref_range_text) row.reference = r.ref_range_text;
  }

  return c.json({ dates, rows: [...byParam.values()] });
});

/** Which panels this person has results in, and how many need attention. */
app.get('/api/panels', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(tc.category,'Other tests') category,
            COUNT(DISTINCT t.parameter) tests, COUNT(*) results,
            MAX(t.test_date) latest,
            SUM(CASE WHEN t.is_abnormal = 1 THEN 1 ELSE 0 END) flagged
       FROM test_results t LEFT JOIN test_categories tc ON tc.parameter = t.parameter
      WHERE t.person_id = ? AND t.deleted = 0
      GROUP BY category ORDER BY latest DESC`
  ).bind(person).all();
  return c.json(results);
});

/** One call at start-up instead of three: the app opens noticeably faster. */
app.get('/api/bootstrap', async (c) => {
  const caller = c.get('caller');
  const s = scopeClause(caller, 'p.person_id');
  const [people, inbox] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT p.person_id, p.name, pr.blood_group, pr.allergies, pr.chronic_conditions
         FROM people p LEFT JOIN profiles pr USING (person_id)
        WHERE p.active = 1 AND ${s.sql} ORDER BY p.sort_order, p.name`).bind(...s.binds),
    c.env.DB.prepare(
      `SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','reading','review','error')`),
  ]);
  return c.json({
    email: caller.email, role: caller.role, today: todayIso(),
    people: people.results, pending: (inbox.results[0] as any)?.n ?? 0,
  });
});

/* ------------------------------------------------------------------ */
/* 3c. Exports — the "you are not locked in" guarantee                 */
/* ------------------------------------------------------------------ */

/** Everything as a multi-sheet workbook. Built fresh, never stored. */
app.get('/api/export/workbook', async (c) => {
  const caller = c.get('caller');
  const bytes = await buildWorkbook(c.env, caller.personIds);
  const name = exportFileName('xlsx', caller.personIds === 'all' ? 'family' : 'selected');

  c.executionCtx.waitUntil(c.env.DB.prepare(
    `INSERT INTO audit_log (actor, action, detail) VALUES (?, 'export_workbook', ?)`
  ).bind(caller.email, name).run());

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
});

/** The original scans, foldered by person and year, decrypted on the way out. */
app.get('/api/export/documents', async (c) => {
  const caller = c.get('caller');
  const { zip, included, skipped, total } = await buildDocumentArchive(c.env, caller.personIds);
  const name = exportFileName('zip', caller.personIds === 'all' ? 'family' : 'selected');

  c.executionCtx.waitUntil(c.env.DB.prepare(
    `INSERT INTO audit_log (actor, action, detail) VALUES (?, 'export_documents', ?)`
  ).bind(caller.email, `${included} of ${total} documents, ${skipped} unreadable`).run());

  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Documents-Included': String(included),
      'X-Documents-Total': String(total),
      'Cache-Control': 'no-store',
    },
  });
});

/** One document, streamed through the Worker so R2 is never exposed directly. */
app.get('/api/documents/:documentId/file', async (c) => {
  const caller = c.get('caller');
  const doc = await c.env.DB.prepare(
    `SELECT d.*, p.name person FROM documents d JOIN people p USING (person_id)
      WHERE d.document_id = ? AND d.deleted = 0`
  ).bind(c.req.param('documentId')).first<any>();
  if (!doc) throw new HttpError(404, 'Document not found.');
  requirePerson(caller, doc.person_id);

  const bytes = await getDocument(c.env, doc.r2_key);
  const name = documentFileName({
    date: doc.document_date, person: doc.person, recordType: doc.document_type,
    provider: doc.provider, documentId: doc.document_id, originalName: doc.file_name,
  });

  return new Response(bytes, {
    headers: {
      'Content-Type': doc.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});


app.route('/api/records', records);
app.route('/api/events', events);

/* ------------------------------------------------------------------ */
/* 3d. Profile, search, dashboard, documents, handout                  */
/* ------------------------------------------------------------------ */

app.get('/api/profile', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const row = await c.env.DB.prepare(`SELECT * FROM profiles WHERE person_id = ?`).bind(person).first();
  return c.json(row ?? { person_id: person });
});

app.put('/api/profile', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');
  const b = await c.req.json<any>();
  const person = requirePerson(caller, b.person_id);

  await c.env.DB.prepare(
    `INSERT INTO profiles (person_id, date_of_birth, blood_group, allergies, chronic_conditions,
                           regular_doctors, emergency_contact, insurance, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(person_id) DO UPDATE SET
       date_of_birth=excluded.date_of_birth, blood_group=excluded.blood_group,
       allergies=excluded.allergies, chronic_conditions=excluded.chronic_conditions,
       regular_doctors=excluded.regular_doctors, emergency_contact=excluded.emergency_contact,
       insurance=excluded.insurance, notes=excluded.notes, updated_at=datetime('now')`
  ).bind(person, parseDate(b.date_of_birth) || null, b.blood_group ?? '', b.allergies ?? '',
         b.chronic_conditions ?? '', b.regular_doctors ?? '', b.emergency_contact ?? '',
         b.insurance ?? '', b.notes ?? '').run();

  return c.json({ ok: true });
});

/** One box across everything filed for a person. */
app.get('/api/search', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  const q = String(c.req.query('q') ?? '').trim().toLowerCase().slice(0, 80);
  if (!q) return c.json({ items: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT kind, ref_id, date, title, value, detail, flag, care_event_id
       FROM timeline
      WHERE person_id = ? AND deleted = 0 AND search_text LIKE ?
      ORDER BY date DESC LIMIT 60`
  ).bind(person, `%${q}%`).all();
  return c.json({ query: q, items: results });
});

/** What needs attention, across everyone this caller can see. */
app.get('/api/dashboard', async (c) => {
  const s = scopeClause(c.get('caller'), 'f.person_id');
  const s2 = scopeClause(c.get('caller'), 't.person_id');
  const s3 = scopeClause(c.get('caller'), 'r.person_id');

  const [overdue, upcoming, abnormal, recent] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT f.follow_up_id, f.due_date, f.type, f.instruction, p.name person
         FROM follow_ups f JOIN people p USING (person_id)
        WHERE f.deleted = 0 AND f.status = 'pending' AND f.due_date < date('now') AND ${s.sql}
        ORDER BY f.due_date LIMIT 20`).bind(...s.binds),
    c.env.DB.prepare(
      `SELECT f.follow_up_id, f.due_date, f.type, f.instruction, p.name person
         FROM follow_ups f JOIN people p USING (person_id)
        WHERE f.deleted = 0 AND f.status = 'pending' AND f.due_date >= date('now') AND ${s.sql}
        ORDER BY f.due_date LIMIT 20`).bind(...s.binds),
    c.env.DB.prepare(
      `SELECT t.parameter, t.result_text, t.unit_raw, t.test_date, t.flag, p.name person
         FROM test_results t JOIN people p USING (person_id)
        WHERE t.deleted = 0 AND t.is_abnormal = 1 AND ${s2.sql}
          AND t.test_date = (SELECT MAX(t2.test_date) FROM test_results t2
                              WHERE t2.person_id = t.person_id AND t2.parameter = t.parameter AND t2.deleted = 0)
        ORDER BY t.test_date DESC LIMIT 15`).bind(...s2.binds),
    c.env.DB.prepare(
      `SELECT r.record_id, r.event_date, r.record_type, r.summary, r.facility, p.name person
         FROM records r JOIN people p USING (person_id)
        WHERE r.deleted = 0 AND ${s3.sql} ORDER BY r.event_date DESC LIMIT 10`).bind(...s3.binds),
  ]);

  return c.json({
    overdue: overdue.results, upcoming: upcoming.results,
    abnormal: abnormal.results, recent: recent.results,
  });
});

/** Documents attached to one record, with links. */
app.get('/api/records/:recordId/documents', async (c) => {
  const recordId = c.req.param('recordId');
  const { results } = await c.env.DB.prepare(
    `SELECT d.document_id, d.file_name, d.document_type, d.document_date, d.provider,
            d.mime_type, d.bytes, d.legacy_url, p.name person, d.person_id
       FROM documents d JOIN people p USING (person_id)
      WHERE d.record_id = ? AND d.deleted = 0 ORDER BY d.document_date`
  ).bind(recordId).all<any>();
  if (results.length) requirePerson(c.get('caller'), results[0].person_id);
  return c.json(results);
});

/** A printable one-page summary, and a link a doctor can open without an account. */
app.get('/api/handout', async (c) => {
  const person = requirePerson(c.get('caller'), c.req.query('person'));
  return new Response(await handoutHtml(c.env, person), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

app.post('/api/handout/share', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');
  const { person, hours } = await c.req.json<{ person: string; hours?: number }>();
  requirePerson(caller, person);

  const shareId = crypto.randomUUID().replace(/-/g, '');
  const ttl = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const expires = new Date(Date.now() + ttl * 3600_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO shares (share_id, person_id, kind, r2_key, created_by, expires_at, max_views)
     VALUES (?,?,'handout','',?,?,20)`
  ).bind(shareId, person, caller.email, expires).run();

  return c.json({ url: `${new URL(c.req.url).origin}/s/${shareId}`, expiresAt: expires, hours: ttl });
});

/* ------------------------------------------------------------------ */
/* 4. Everything else                                                  */
/* ------------------------------------------------------------------ */

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  // Four family members debugging their own tool are better served by the real
  // message than by a polite placeholder.
  const detail = err instanceof Error ? err.message : String(err);
  return c.json({ error: detail.slice(0, 400) || 'Something went wrong.' }, 500);
});

/**
 * The one route with no Access in front of it: a doctor opening a share link.
 * Guarded by an unguessable id, an expiry and a view cap instead.
 */
app.get('/s/:shareId', async (c) => {
  const share = await c.env.DB.prepare(
    `SELECT * FROM shares WHERE share_id = ? AND revoked = 0`
  ).bind(c.req.param('shareId')).first<any>();

  if (!share) return c.text('This link is not valid.', 404);
  if (share.expires_at < new Date().toISOString()) return c.text('This link has expired.', 410);
  if (share.max_views && share.views >= share.max_views) return c.text('This link has expired.', 410);

  await c.env.DB.prepare(`UPDATE shares SET views = views + 1 WHERE share_id = ?`)
    .bind(share.share_id).run();

  return new Response(await handoutHtml(c.env, share.person_id, true), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function requirePerson(caller: Caller, personId?: string | null): string {
  if (!personId) throw new HttpError(400, 'Which person?');
  if (caller.personIds !== 'all' && !caller.personIds.includes(personId)) {
    throw new HttpError(403, 'You do not have access to this person\u2019s records.');
  }
  return personId;
}

/**
 * Match a name printed on a report to a person on file. Reports write names in
 * every possible way — "Mrs. REENA ARORA", "Arora, Reena", "R. Arora" — so
 * compare on the parts, not the whole string.
 */
async function matchPerson(env: Env, printed: string): Promise<string | null> {
  const norm = (s: string) => s.toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|shri|smt|master|baby)\b\.?/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

  const target = norm(printed);
  if (!target) return null;
  const parts = target.split(' ').filter((w) => w.length > 2);

  const { results } = await env.DB.prepare(
    `SELECT person_id, name FROM people WHERE active = 1`
  ).all<{ person_id: string; name: string }>();

  let best: { id: string; score: number } | null = null;
  for (const p of results) {
    const name = norm(p.name);
    const words = name.split(' ').filter(Boolean);
    let score = 0;
    if (name === target) score = 100;
    else if (target.includes(name) || name.includes(target)) score = 80;
    else score = words.filter((w) => parts.includes(w)).length * 30;
    if (score > 0 && (!best || score > best.score)) best = { id: p.person_id, score };
  }
  // A single shared surname is not enough to file someone's blood work.
  return best && best.score >= 60 ? best.id : null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? '';
}

/* ------------------------------------------------------------------ */
/* Worker entry points                                                 */
/* ------------------------------------------------------------------ */

export default {
  fetch: app.fetch,

  /** Background document reading. Retries and failures are handled by the queue. */
  async queue(batch: MessageBatch<OcrMessage>, env: Env) {
    for (const msg of batch.messages) {
      const { jobId, jobFileId, r2Key, mimeType } = msg.body;
      try {
        await env.DB.prepare(
          `UPDATE job_files SET ai_status='reading', attempts=attempts+1 WHERE job_file_id = ?`
        ).bind(jobFileId).run();
        await env.DB.prepare(
          `UPDATE jobs SET status='reading', message='Reading the document\u2026', updated_at=datetime('now')
            WHERE job_id = ? AND status <> 'review'`
        ).bind(jobId).run();

        const job = await env.DB.prepare(
          `SELECT j.user_date, j.person_id, p.name person
             FROM jobs j LEFT JOIN people p ON p.person_id = j.person_id WHERE j.job_id = ?`
        ).bind(jobId).first<{ user_date: string | null; person_id: string | null; person: string | null }>();
        const file = await env.DB.prepare(
          `SELECT file_name FROM job_files WHERE job_file_id = ?`
        ).bind(jobFileId).first<{ file_name: string }>();

        const bytes = await getDocument(env, r2Key);
        const extraction = await readDocument(
          env, bytes, mimeType, job?.person ?? null, job?.user_date ?? null, file?.file_name ?? 'document'
        );

        // Nobody was chosen at upload time: match the printed name to a person.
        if (!job?.person_id && extraction.patient_name) {
          const match = await matchPerson(env, extraction.patient_name);
          if (match) {
            await env.DB.prepare(
              `UPDATE jobs SET person_id = ?, detected_name = ? WHERE job_id = ? AND person_id IS NULL`
            ).bind(match, extraction.patient_name, jobId).run();
          } else {
            await env.DB.prepare(`UPDATE jobs SET detected_name = ? WHERE job_id = ?`)
              .bind(extraction.patient_name, jobId).run();
          }
        }

        await env.DB.prepare(
          `UPDATE job_files SET ai_status='done', ai_json=?, last_error='' WHERE job_file_id = ?`
        ).bind(JSON.stringify(extraction), jobFileId).run();

        // Only assemble the review once every file in the batch has been read.
        const pending = await env.DB.prepare(
          `SELECT COUNT(*) n FROM job_files WHERE job_id = ? AND ai_status <> 'done'`
        ).bind(jobId).first<{ n: number }>();

        if (!pending?.n) {
          const { results } = await env.DB.prepare(
            `SELECT ai_json FROM job_files WHERE job_id = ? ORDER BY file_index`
          ).bind(jobId).all<{ ai_json: string }>();
          const merged = mergeExtractions(
            results.map((r) => JSON.parse(r.ai_json)),
            job?.user_date || new Date().toISOString().slice(0, 10)
          );
          if (!merged.summary) merged.summary = 'Document filed; add a short summary.';

          await env.DB.prepare(
            `UPDATE jobs SET status='review', message='Ready for you to check.', extraction=?,
                    updated_at=datetime('now') WHERE job_id = ?`
          ).bind(JSON.stringify(merged), jobId).run();
        }

        msg.ack();
      } catch (err) {
        const detail = String(err instanceof Error ? err.message : err).slice(0, 400);
        await env.DB.prepare(
          `UPDATE job_files SET ai_status='error', last_error=? WHERE job_file_id = ?`
        ).bind(detail, jobFileId).run();
        await env.DB.prepare(
          `UPDATE jobs SET status='error', message=?, updated_at=datetime('now') WHERE job_id = ?`
        ).bind(detail, jobId).run();

        // Retry transient failures; give up on ones a retry cannot fix.
        if (/too long|declined|not configured|No Gemini key/i.test(detail)) msg.ack();
        else msg.retry();
      }
    }
  },

  /** Nightly: push the readable copy into your Google Sheet, expire old shares. */
  async scheduled(_event: ScheduledController, env: Env) {
    // Implemented in Part 3.
    console.log('nightly maintenance');
  },
};
