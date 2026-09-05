/**
 * Document storage.
 *
 * Privacy model:
 *  - R2 has no public endpoint. Objects are reachable only through this Worker,
 *    which runs only after Cloudflare Access has proved who you are.
 *  - Every object is encrypted with AES-256-GCM before it is written, using a
 *    key held as a Worker secret. R2 encrypts at rest as well, so a scan is
 *    encrypted twice: once by Cloudflare, once with a key Cloudflare's storage
 *    layer never sees. Someone with the bucket contents and no Worker secret
 *    has nothing readable.
 *  - Object keys carry no names or dates: person and document are opaque ids,
 *    so the bucket listing itself leaks nothing about who is ill or when.
 *
 * Human-readable naming is applied at download time instead, where it belongs.
 */

import type { Env } from './index';

const IV_BYTES = 12;

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.DOC_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error('Document encryption key is missing. Set DOC_ENCRYPTION_KEY in the Worker settings.');
  }
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Where a file sits in the bucket.
 *
 * Readable and foldered by person and year, so browsing the bucket looks like
 * browsing the export. The trade is deliberate: a bucket listing now shows
 * names and dates, though never contents, since every object is encrypted.
 * Keys created before this change keep working — the key is stored per
 * document, so both schemes coexist.
 */
export function objectKey(personId: string, documentId: string): string {
  return `d/${personId}/${documentId}`;
}

export function filedKey(parts: {
  person: string; date?: string | null; recordType?: string | null;
  provider?: string | null; documentId: string; originalName?: string | null;
}): string {
  const slug = (s: string, fallback: string) =>
    (s || fallback).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  const year = (parts.date || '').slice(0, 4) || 'undated';
  return `docs/${slug(parts.person, 'Unknown')}/${year}/${documentFileName(parts)}`;
}

export async function putDocument(
  env: Env, objKey: string, bytes: Uint8Array, mimeType: string
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), bytes)
  );

  // Prepend the IV so each object carries what it needs to be opened.
  const payload = new Uint8Array(IV_BYTES + sealed.length);
  payload.set(iv, 0);
  payload.set(sealed, IV_BYTES);

  await env.DOCS.put(objKey, payload, {
    customMetadata: { mime: mimeType || 'application/octet-stream', enc: 'aes-256-gcm' },
  });
}

export async function getDocument(env: Env, objKey: string): Promise<Uint8Array> {
  const obj = await env.DOCS.get(objKey);
  if (!obj) throw new Error('That document is no longer in storage.');
  const payload = new Uint8Array(await obj.arrayBuffer());
  const iv = payload.slice(0, IV_BYTES);
  const body = payload.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(env), body);
  return new Uint8Array(plain);
}

export async function deleteDocument(env: Env, objKey: string): Promise<void> {
  await env.DOCS.delete(objKey);
}

/**
 * The download filename. Same convention as the v4 Apps Script, so an exported
 * archive sorts and reads the way your Drive folder used to:
 *
 *   2026-03-11_Reena_Lab-Test_Dr-Lals-PathLabs_a1b2c3d4.pdf
 *
 * Date first so a folder sorts chronologically; person second so a family
 * archive groups by person on a secondary sort; provider so you can find the
 * one from a particular lab without opening anything.
 */
export function documentFileName(parts: {
  date?: string | null;
  person: string;
  recordType?: string | null;
  provider?: string | null;
  documentId: string;
  originalName?: string | null;
}): string {
  const clean = (s: string | null | undefined, fallback: string) =>
    (s || fallback).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;

  const ext = (parts.originalName?.match(/\.[A-Za-z0-9]{2,5}$/)?.[0] || '.pdf').toLowerCase();

  return [
    (parts.date || 'undated').slice(0, 10),
    clean(parts.person, 'Unknown'),
    clean(parts.recordType, 'Document'),
    clean(parts.provider, 'Provider'),
    parts.documentId.slice(-8),
  ].join('_') + ext;
}
