/**
 * Canonical test names and units.
 *
 * This is the part of the v4 Apps Script worth carrying over intact. Indian labs
 * print the same test a dozen ways — "HbA1c", "Glycated Haemoglobin (HbA1c)",
 * "HB1AC" — and until they resolve to one name, no trend can be drawn.
 *
 * The rule that matters: a value is only converted when the conversion is known.
 * A number in an unrecognised unit is never coerced and never plotted, because a
 * silently wrong lab value on a chart is worse than a gap.
 */

import type { Env } from './index';

export interface Alias { parameter: string; unit: string }

let aliasCache: { map: Record<string, Alias>; at: number } | null = null;
let convCache: { map: Record<string, { to: string; mul: number; add: number }>; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Normalised lookup key. Strips "serum", punctuation, case and accents. */
export function normKey(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(serum|plasma|blood|test|level|estimation)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function normUnitKey(s: string): string {
  return String(s ?? '').normalize('NFKD').toLowerCase()
    .replace(/µ/g, 'u').replace(/[^a-z0-9]+/g, '');
}

async function aliases(env: Env): Promise<Record<string, Alias>> {
  if (aliasCache && Date.now() - aliasCache.at < TTL_MS) return aliasCache.map;
  const { results } = await env.DB.prepare(
    `SELECT alias_key, parameter, unit FROM parameter_aliases`
  ).all<{ alias_key: string; parameter: string; unit: string }>();
  const map: Record<string, Alias> = {};
  for (const r of results) map[r.alias_key] = { parameter: r.parameter, unit: r.unit || '' };
  aliasCache = { map, at: Date.now() };
  return map;
}

async function conversions(env: Env): Promise<Record<string, { to: string; mul: number; add: number }>> {
  if (convCache && Date.now() - convCache.at < TTL_MS) return convCache.map;
  const { results } = await env.DB.prepare(
    `SELECT parameter, from_unit_key, to_unit, multiply_by, add_offset FROM unit_conversions`
  ).all<any>();
  const map: Record<string, { to: string; mul: number; add: number }> = {};
  for (const r of results) {
    map[`${r.parameter}|${r.from_unit_key}`] = { to: r.to_unit, mul: Number(r.multiply_by), add: Number(r.add_offset) };
  }
  convCache = { map, at: Date.now() };
  return map;
}

export function clearCanonicalCache(): void { aliasCache = null; convCache = null; }

const tidy = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export interface Resolved { parameter: string; unit: string; known: boolean; key: string }

/** Map a printed test name onto its canonical name and usual unit. */
export async function resolveParameter(env: Env, printed: string, unit?: string | null): Promise<Resolved> {
  const raw = tidy(printed) || 'Unspecified test';
  const key = normKey(raw);
  const hit = key ? (await aliases(env))[key] : undefined;
  return hit?.parameter
    ? { parameter: hit.parameter, unit: hit.unit || String(unit || ''), known: true, key }
    : { parameter: raw, unit: String(unit || ''), known: false, key };
}

/**
 * Teach the table a name it has not seen. Gemini returns its best guess at the
 * standard name alongside each result, so no extra model call is needed.
 */
export async function learnAlias(
  env: Env, printed: string, standard: string | null | undefined, unit: string | null | undefined
): Promise<void> {
  const key = normKey(printed);
  if (!key) return;
  const map = await aliases(env);
  if (map[key]) return;

  const parameter = tidy(standard || printed);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO parameter_aliases (alias_key, original, parameter, unit, source)
     VALUES (?, ?, ?, ?, 'gemini')`
  ).bind(key, tidy(printed), parameter, String(unit || '')).run();
  clearCanonicalCache();
}

/** The unit this canonical parameter is normally expressed in. */
export async function canonicalUnit(env: Env, parameter: string): Promise<string> {
  const map = await aliases(env);
  const direct = map[normKey(parameter)];
  if (direct?.unit) return direct.unit;
  for (const a of Object.values(map)) if (a.parameter === parameter && a.unit) return a.unit;
  return '';
}

/**
 * Convert a result into the canonical unit.
 * Returns null when the unit is unrecognised — deliberately, so the value is
 * kept as printed but left off any chart rather than plotted wrongly.
 */
export async function toCanonicalValue(
  env: Env, parameter: string, printedUnit: string | null | undefined, value: number | null
): Promise<number | null> {
  if (value === null || !Number.isFinite(value)) return null;

  const target = await canonicalUnit(env, parameter);
  if (!target) return value;

  const raw = String(printedUnit || '').trim();
  if (!raw) return value;                                   // no unit printed: assume canonical
  if (normUnitKey(raw) === normUnitKey(target)) return value;

  const conv = (await conversions(env))[`${parameter}|${normUnitKey(raw)}`];
  if (!conv) return null;                                   // unknown unit: refuse to guess
  return Math.round((value * conv.mul + conv.add) * 10000) / 10000;
}

/** Pull numbers out of "12.4", "120/80", "1,20,000". */
export function numericResult(text: string | null | undefined): { a: number | null; b: number | null } {
  const m = String(text ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?/);
  if (!m) return { a: null, b: null };
  const parts = m[0].split('/').map((p) => Number(p.trim()));
  return {
    a: Number.isFinite(parts[0]) ? parts[0] : null,
    b: parts.length > 1 && Number.isFinite(parts[1]) ? parts[1] : null,
  };
}

/** Read "12 - 15", "<200", "Upto 5.6", ">40" into bounds. */
export function parseReferenceRange(text: string | null | undefined): { low: number | null; high: number | null } {
  const s = String(text ?? '').replace(/,/g, '').replace(/[\u2013\u2014]/g, '-').trim();
  if (!s) return { low: null, high: null };

  let m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };

  m = s.match(/(?:<|less than|upto|up to|below)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: null, high: Number(m[1]) };

  m = s.match(/(?:>|greater than|above|at least)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return { low: Number(m[1]), high: null };

  return { low: null, high: null };
}

/** Whether a printed flag means "not normal". */
export function isAbnormal(flag: string | null | undefined): boolean {
  const s = String(flag ?? '').trim().toLowerCase();
  if (!s) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !['normal', 'within range', 'negative', 'nil', 'none', 'n', 'wnl', 'not detected'].includes(s);
}

/** Fall back to the seeded band when a lab prints no reference range. */
export async function referenceBand(
  env: Env, parameter: string
): Promise<{ low: number | null; high: number | null } | null> {
  const row = await env.DB.prepare(
    `SELECT low, high FROM reference_bands WHERE parameter = ? ORDER BY sex = 'any' DESC LIMIT 1`
  ).bind(parameter).first<{ low: number | null; high: number | null }>();
  return row ?? null;
}

/** "10 days", "2 weeks", "3 months" to a day count. */
export function durationDays(text: string | null | undefined): number {
  const s = String(text ?? '').toLowerCase();
  let m = s.match(/(\d+)\s*(days?|d)\b/); if (m) return Number(m[1]);
  m = s.match(/(\d+)\s*(weeks?|wks?)\b/); if (m) return Number(m[1]) * 7;
  m = s.match(/(\d+)\s*(months?|mons?|mo)\b/); if (m) return Number(m[1]) * 30;
  m = s.match(/(\d+)\s*(years?|yrs?)\b/); if (m) return Number(m[1]) * 365;
  return 0;
}

function addDays(iso: string, days: number): string {
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Work out when a medicine actually ends.
 *
 * v4 assumed anything without an end date was active for 90 days, which put
 * finished antibiotic courses on the doctor handout as current medication. Here
 * an unknown end stays unknown, and the handout says so.
 */
export function medicineEnd(m: {
  status?: string | null; end_date?: string | null; start_date?: string | null;
  prescribed_on?: string | null; duration_text?: string | null; instructions?: string | null;
  frequency?: string | null;
}): { endDate: string | null; status: 'active' | 'stopped' | 'completed' | 'unknown' } {
  const status = String(m.status ?? '').toLowerCase();
  if (/stopped|discontinued|ceased/.test(status)) return { endDate: null, status: 'stopped' };
  if (/completed|finished|ended/.test(status)) return { endDate: null, status: 'completed' };

  if (m.end_date) {
    return { endDate: m.end_date, status: m.end_date >= new Date().toISOString().slice(0, 10) ? 'active' : 'completed' };
  }

  const start = m.start_date || m.prescribed_on || null;
  const days = durationDays(m.duration_text);
  if (start && days) {
    const end = addDays(start, days);
    return { endDate: end, status: end >= new Date().toISOString().slice(0, 10) ? 'active' : 'completed' };
  }

  const text = `${m.instructions ?? ''} ${status} ${m.frequency ?? ''}`.toLowerCase();
  if (/ongoing|continue|long ?term|lifelong|maintenance|regular/.test(text)) {
    return { endDate: null, status: 'active' };
  }

  return { endDate: null, status: 'unknown' };
}
