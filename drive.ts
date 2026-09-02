/**
 * Google Drive access.
 *
 * Files live in YOUR Drive, owned by YOU, inside a folder you can open at any
 * time. This Worker only holds a refresh token and only ever sees the files it
 * created — we request the `drive.file` scope, not full Drive access, so even a
 * total compromise of this Worker cannot read the rest of your Drive.
 */

import type { Env } from './index';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/** Access tokens last an hour; cache in the isolate so we don't refetch per request. */
let cached: { token: string; expires: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error('Google Drive connection has lapsed. Reconnect Google in Settings.');
  }

  const data = await res.json<{ access_token: string; expires_in: number }>();
  cached = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function api(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cached = null; // token went stale mid-flight; one retry with a fresh one
    const retry = await accessToken(env);
    return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${retry}` } });
  }
  return res;
}

/** Find or create a folder, caching the ID in settings so we don't search every time. */
export async function driveEnsureFolder(env: Env, personId: string, name: string): Promise<string> {
  const key = `drive_folder:${personId}:${name}`;
  const known = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(key).first<{ value: string }>();
  if (known?.value) return known.value;

  const root = await ensureRoot(env);
  const parent = personId === '_root' ? root : await ensurePersonFolder(env, personId, root);

  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await api(env, `${API}/files?q=${q}&fields=files(id)`);
  const list = await found.json<{ files: { id: string }[] }>();
  let id = list.files?.[0]?.id;

  if (!id) {
    const created = await api(env, `${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      }),
    });
    id = (await created.json<{ id: string }>()).id;
  }

  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).bind(key, id).run();
  return id;
}

async function ensureRoot(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='drive_root_folder_id'`)
    .first<{ value: string }>();
  if (row?.value) return row.value;

  const created = await api(env, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Family Medical Records', mimeType: 'application/vnd.google-apps.folder' }),
  });
  const id = (await created.json<{ id: string }>()).id;
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key='drive_root_folder_id'`).bind(id).run();
  return id;
}

async function ensurePersonFolder(env: Env, personId: string, root: string): Promise<string> {
  const person = await env.DB.prepare(`SELECT name FROM people WHERE person_id = ?`)
    .bind(personId).first<{ name: string }>();
  const name = person?.name || personId;
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and '${root}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await api(env, `${API}/files?q=${q}&fields=files(id)`);
  const list = await res.json<{ files: { id: string }[] }>();
  if (list.files?.[0]) return list.files[0].id;

  const created = await api(env, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }),
  });
  return (await created.json<{ id: string }>()).id;
}

export async function driveUpload(
  env: Env, folderId: string, name: string, mimeType: string, bytes: Uint8Array
): Promise<{ id: string; webViewLink: string }> {
  const boundary = '----fmr' + crypto.randomUUID();
  const metadata = JSON.stringify({ name: safeName(name), parents: [folderId] });

  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await api(env, `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!res.ok) throw new Error(`Drive upload failed: ${await res.text()}`);
  return res.json<{ id: string; webViewLink: string }>();
}

export async function driveDownload(env: Env, fileId: string): Promise<Uint8Array> {
  const res = await api(env, `${API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error('Could not read that file from Drive.');
  return new Uint8Array(await res.arrayBuffer());
}

export async function driveRename(env: Env, fileId: string, name: string, folderId?: string): Promise<void> {
  const params = folderId ? `?addParents=${folderId}` : '';
  await api(env, `${API}/files/${fileId}${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: safeName(name) }),
  });
}

export async function driveTrash(env: Env, fileId: string): Promise<void> {
  await api(env, `${API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

function safeName(s: string): string {
  return (s || 'Medical document').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120);
}
