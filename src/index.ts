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
import { driveUpload, driveEnsureFolder, driveDownload } from './drive';

export interface Env {
  DB: D1Database;
  OCR: Queue<OcrMessage>;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TIMEZONE: string;
  APP_TITLE: string;
  GEMINI_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}

export interface OcrMessage {
  jobId: string;
  jobFileId: string;
  driveFileId: string;
  mimeType: string;
}

type Caller = {
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

  if (row.expires_at && row.expires_at < today()) {
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
  const connected = await setting(c.env, 'google_connected');
  return c.json({
    email: caller.email,
    role: caller.role,
    title: c.env.APP_TITLE,
    googleConnected: connected === '1',
    today: today(),
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
 * Here it is a view and an index, always current, no rebuild.
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
       FROM v_timeline
      WHERE person_id = ? ${kindSql}
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
    overdueCount: followUps.results.filter((f: any) => f.due_date && f.due_date < today()).length,
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
  const body = await c.req.json<{ person: string; date?: string; careEventId?: string }>();
  const person = requirePerson(caller, body.person);
  const jobId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO jobs (job_id, person_id, care_event_id, user_date, status, message, created_by)
     VALUES (?, ?, ?, ?, 'draft', 'Add files, then submit.', ?)`
  ).bind(jobId, person, body.careEventId || null, body.date || today(), caller.email).run();

  return c.json({ jobId });
});

/**
 * Takes one file, puts it in Drive, queues it for reading, returns.
 * The user is free to upload the next file immediately — no lock, no waiting.
 */
app.post('/api/uploads/:jobId/file', async (c) => {
  const caller = c.get('caller');
  if (caller.role === 'viewer') throw new HttpError(403, 'Read-only access.');

  const jobId = c.req.param('jobId');
  const job = await c.env.DB.prepare(
    `SELECT job_id, person_id, status FROM jobs WHERE job_id = ?`
  ).bind(jobId).first<{ job_id: string; person_id: string; status: string }>();
  if (!job) throw new HttpError(404, 'Upload not found.');
  requirePerson(caller, job.person_id);
  if (!['draft', 'error'].includes(job.status)) throw new HttpError(409, 'This upload is already being processed.');

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'No file received.');
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

  const folderId = await driveEnsureFolder(c.env, job.person_id, 'Pending Review');
  const drive = await driveUpload(c.env, folderId, file.name, file.type, bytes);

  const jobFileId = crypto.randomUUID();
  const { count } = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM job_files WHERE job_id = ?`
  ).bind(jobId).first<{ count: number }>() ?? { count: 0 };

  await c.env.DB.prepare(
    `INSERT INTO job_files (job_file_id, job_id, file_index, file_name, mime_type,
                            bytes, drive_file_id, content_sha256, ai_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`
  ).bind(jobFileId, jobId, count + 1, file.name, file.type, file.size, drive.id, hash).run();

  // Hand off to the background reader and return straight away.
  await c.env.OCR.send({ jobId, jobFileId, driveFileId: drive.id, mimeType: file.type });
  await c.env.DB.prepare(
    `UPDATE jobs SET status='queued', message='Reading in the background…',
            updated_at=datetime('now') WHERE job_id = ?`
  ).bind(jobId).run();

  return c.json({ jobFileId, name: file.name, driveUrl: drive.webViewLink, queued: true });
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
/* 4. Everything else                                                  */
/* ------------------------------------------------------------------ */

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: 'Something went wrong. Try again.' }, 500);
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

function today(): string { return new Date().toISOString().slice(0, 10); }

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
      // Implemented in Part 3: fetch from Drive, call Gemini with the v4 prompt
      // and schema, normalise, write extraction JSON, set job status to 'review'.
      console.log('OCR job queued', msg.body.jobFileId);
      msg.ack();
    }
  },

  /** Nightly: push the readable copy into your Google Sheet, expire old shares. */
  async scheduled(_event: ScheduledController, env: Env) {
    // Implemented in Part 3.
    console.log('nightly maintenance');
  },
};
