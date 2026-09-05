/**
 * Formatting shared by the API and the app.
 *
 * Dates are stored as ISO (yyyy-mm-dd) because that is what sorts and compares
 * correctly in SQL, and shown as dd-mmm-yyyy because 03-11-2026 is ambiguous in
 * India and 11-Mar-2026 is not. Storage format and display format are separate
 * decisions and this is the only place the second one is made.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-11' -> '11-Mar-2026'. Anything unparseable comes back unchanged. */
export function displayDate(iso: string | null | undefined): string {
  const s = String(iso ?? '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? m[2]}-${m[1]}`;
}

/** '11-Mar-2026', '11/03/2026' and '2026-03-11' all become '2026-03-11'. */
export function parseDate(text: string | null | undefined): string {
  const s = String(text ?? '').trim();
  if (!s) return '';

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})$/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === m![2].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  return '';
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 'in 3 days', '2 months ago' — for follow-ups and last-seen lines. */
export function relativeDays(iso: string | null | undefined): string {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const days = Math.round((Date.parse(s) - Date.parse(today())) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const n = Math.abs(days);
  const unit = n < 31 ? `${n} days` : n < 365 ? `${Math.round(n / 30)} months` : `${(n / 365).toFixed(1)} years`;
  return days > 0 ? `in ${unit}` : `${unit} ago`;
}
