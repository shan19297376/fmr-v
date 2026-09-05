/**
 * The doctor handout.
 *
 * One page you can hand over or print to PDF from the browser. No PDF library
 * in the Worker: the browser already has an excellent one, and print CSS is
 * easier to get right than laying out a PDF by hand.
 *
 * The clinical judgement that matters is in `medicineEnd`. v4 printed anything
 * without an end date as a current medication, so finished antibiotic courses
 * appeared as active. Here an unknown end says so on the page.
 */

import type { Env } from './index';
import { displayDate, relativeDays, today } from './format';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function handoutHtml(env: Env, personId: string, shared = false): Promise<string> {
  // A shared link has nowhere to go back to.
  const person = await env.DB.prepare(
    `SELECT p.name, pr.* FROM core_people p LEFT JOIN core_profiles pr USING (person_id) WHERE p.person_id = ?`
  ).bind(personId).first<any>();
  if (!person) return '<p>Not found.</p>';

  const [meds, labs, diagnoses, follow, visits] = await env.DB.batch([
    env.DB.prepare(
      `SELECT name, strength, dose, frequency, start_date, end_date, status, instructions
         FROM health_medicines WHERE person_id = ? AND deleted = 0
          AND status IN ('active','unknown') ORDER BY prescribed_on DESC LIMIT 25`).bind(personId),
    env.DB.prepare(
      `SELECT parameter, result_text, unit_raw, test_date, ref_range_text, ref_low, ref_high,
              is_abnormal, value_a, lab,
              LAG(result_text) OVER w prev_result, LAG(test_date) OVER w prev_date,
              LAG(value_a) OVER w prev_value,
              ROW_NUMBER() OVER (PARTITION BY parameter ORDER BY test_date DESC) rn
         FROM health_test_results WHERE person_id = ? AND deleted = 0
        WINDOW w AS (PARTITION BY parameter ORDER BY test_date)`).bind(personId),
    env.DB.prepare(
      `SELECT diagnosis, status, noted_on FROM health_diagnoses
        WHERE person_id = ? AND deleted = 0 ORDER BY noted_on DESC LIMIT 15`).bind(personId),
    env.DB.prepare(
      `SELECT due_date, type, instruction FROM health_follow_ups
        WHERE person_id = ? AND deleted = 0 AND status = 'pending'
        ORDER BY due_date LIMIT 12`).bind(personId),
    env.DB.prepare(
      `SELECT event_date, record_type, summary, doctor, facility FROM health_records
        WHERE person_id = ? AND deleted = 0 ORDER BY event_date DESC LIMIT 8`).bind(personId),
  ]);

  const latest = (labs.results as any[])
    .filter((r) => r.rn === 1)
    .sort((a, b) => (b.is_abnormal - a.is_abnormal) || String(b.test_date).localeCompare(String(a.test_date)))
    .slice(0, 26);

  const age = person.date_of_birth
    ? Math.floor((Date.parse(today()) - Date.parse(person.date_of_birth)) / 31557600000)
    : null;

  const arrow = (now: number | null, prev: number | null) => {
    if (now === null || prev === null || now === prev) return '';
    return now > prev ? '\u2191' : '\u2193';
  };

  const rows = <T,>(items: T[], cells: ((x: T) => string)[]) =>
    items.map((x) => `<tr>${cells.map((f) => `<td>${f(x)}</td>`).join('')}</tr>`).join('');

  const section = (title: string, head: string[], body: string) => body
    ? `<section><h2>${esc(title)}</h2><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></section>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(person.name)} — medical summary</title>
<style>
  :root{--ink:#16232a;--muted:#5d7179;--line:#d6e0e4;--deep:#12414d;--alert:#a8433a}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;color:var(--ink);background:#fff;
       font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:860px}
  h1{margin:0;font-size:22px;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:3px 0 18px;font-size:12px}
  h2{font-size:12px;margin:20px 0 6px;padding-bottom:4px;border-bottom:2px solid var(--deep);color:var(--deep)}
  table{width:100%;border-collapse:collapse;margin-bottom:2px}
  th{text-align:left;font-size:11px;color:var(--muted);font-weight:600;padding:5px 8px;background:#f1f6f7;border:1px solid var(--line)}
  td{padding:5px 8px;border:1px solid var(--line);vertical-align:top;font-variant-numeric:tabular-nums}
  .facts td{border:1px solid var(--line)}
  .facts .k{background:#f1f6f7;font-weight:600;color:var(--deep);width:20%}
  .hi{color:var(--alert);font-weight:600}
  .q{color:var(--muted);font-style:italic}
  footer{margin-top:22px;padding-top:8px;border-top:1px solid var(--line);color:var(--muted);font-size:10.5px}
  .bar{position:sticky;top:0;display:flex;gap:8px;justify-content:space-between;
       background:#fff;padding:10px 0 14px;margin:-8px 0 8px;z-index:9}
  .print{background:var(--deep);color:#fff;border:0;padding:11px 18px;border-radius:8px;
         font-size:14px;cursor:pointer}
  .back{background:#fff;border:1px solid var(--line);color:var(--deep);padding:11px 16px;
        border-radius:8px;font-size:14px;cursor:pointer}
  @media print{.bar{display:none}body{padding:0}}
</style></head><body>
<div class="bar">
  ${shared ? '<span></span>' : '<button class="back" id="backBtn" type="button">&#8592; Back</button>'}
  <button class="print" id="printBtn" type="button">Print / save as PDF</button>
</div>

<h1>${esc(person.name)}</h1>
<p class="sub">Medical summary prepared ${esc(displayDate(today()))}${age !== null ? ` &middot; age ${age}` : ''}</p>

<table class="facts">
  <tr><td class="k">Blood group</td><td>${esc(person.blood_group || 'Not recorded')}</td>
      <td class="k">Date of birth</td><td>${esc(person.date_of_birth ? displayDate(person.date_of_birth) : 'Not recorded')}</td></tr>
  <tr><td class="k">Allergies</td><td colspan="3" class="${person.allergies ? 'hi' : ''}">${esc(person.allergies || 'None recorded')}</td></tr>
  <tr><td class="k">Ongoing conditions</td><td colspan="3">${esc(person.chronic_conditions || 'None recorded')}</td></tr>
  <tr><td class="k">Regular doctors</td><td colspan="3">${esc(person.regular_doctors || 'Not recorded')}</td></tr>
  <tr><td class="k">Emergency contact</td><td>${esc(person.emergency_contact || 'Not recorded')}</td>
      <td class="k">Insurance</td><td>${esc(person.insurance || 'Not recorded')}</td></tr>
</table>

${section('Current medicines', ['Medicine', 'Dose', 'Since', 'Until'],
  rows(meds.results as any[], [
    (m: any) => esc([m.name, m.strength].filter(Boolean).join(' ')),
    (m: any) => esc([m.dose, m.frequency].filter(Boolean).join(', ')),
    (m: any) => esc(displayDate(m.start_date)),
    (m: any) => m.end_date ? esc(displayDate(m.end_date))
      : '<span class="q">no end date recorded &mdash; please confirm</span>',
  ]))}

${section('Latest results', ['Test', 'Result', 'Reference', 'Taken', 'Previous'],
  rows(latest, [
    (t: any) => esc(t.parameter),
    (t: any) => `<span class="${t.is_abnormal ? 'hi' : ''}">${esc([t.result_text, t.unit_raw].filter(Boolean).join(' '))} ${arrow(t.value_a, t.prev_value)}</span>`,
    (t: any) => esc(t.ref_range_text || (t.ref_low !== null || t.ref_high !== null
      ? `${t.ref_low ?? ''}${t.ref_low !== null && t.ref_high !== null ? ' \u2013 ' : ''}${t.ref_high ?? ''}` : '\u2014')),
    (t: any) => esc(displayDate(t.test_date)),
    (t: any) => t.prev_result ? esc(`${t.prev_result} on ${displayDate(t.prev_date)}`) : '\u2014',
  ]))}

${section('Recorded diagnoses', ['Diagnosis', 'Status', 'Noted'],
  rows(diagnoses.results as any[], [
    (d: any) => esc(d.diagnosis), (d: any) => esc(d.status || ''), (d: any) => esc(displayDate(d.noted_on)),
  ]))}

${section('Open follow-ups', ['Due', 'What', 'When'],
  rows(follow.results as any[], [
    (f: any) => esc(f.due_date ? displayDate(f.due_date) : 'No date'),
    (f: any) => esc(f.instruction || f.type || ''),
    (f: any) => esc(relativeDays(f.due_date)),
  ]))}

${section('Recent visits and reports', ['Date', 'Type', 'Summary'],
  rows(visits.results as any[], [
    (v: any) => esc(displayDate(v.event_date)),
    (v: any) => esc(v.record_type),
    (v: any) => esc([v.summary, [v.doctor, v.facility].filter(Boolean).join(', ')].filter(Boolean).join(' \u2014 ').slice(0, 220)),
  ]))}

<footer>
  Compiled from documents uploaded by the family. Values are transcribed from the
  original reports and have not been checked by a clinician. Where a medicine has
  no end date, it is shown as unconfirmed rather than assumed to be current.
  Original reports available on request.
</footer>
<script>
  // An inline onclick can be blocked; a listener is not. Opening the print
  // dialog on load for a shared link is intrusive, so it stays on the button.
  document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
  var back = document.getElementById('backBtn');
  if (back) back.addEventListener('click', function () {
    if (history.length > 1) history.back(); else location.href = '/';
  });
</script>
</body></html>`;
}
