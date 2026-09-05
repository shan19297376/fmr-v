/**
 * Writes a real .xlsx workbook — multiple sheets, a frozen header row, dates as
 * text, numbers as numbers so they sum and chart in Excel without retyping.
 *
 * An .xlsx is a zip of XML parts, so this leans on zip.ts rather than a library.
 */

import { makeZip, type ZipEntry } from './zip';

export interface Sheet {
  /** Tab name. Excel forbids : \ / ? * [ ] and caps this at 31 characters. */
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

const safeTab = (name: string) =>
  name.replace(/[:\\/?*\[\]]/g, '-').slice(0, 31) || 'Sheet';

/** Column index to letter: 0 -> A, 26 -> AA. */
function col(n: number): string {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - r) / 26);
  }
  return s;
}

function sheetXml(sheet: Sheet): string {
  const lines: string[] = [];

  const cells = (values: (string | number | null | undefined)[], rowNum: number, bold: boolean) =>
    values.map((v, i) => {
      const ref = `${col(i)}${rowNum}`;
      const style = bold ? ' s="1"' : '';
      if (v === null || v === undefined || v === '') return `<c r="${ref}"${style}/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('');

  lines.push(`<row r="1">${cells(sheet.headers, 1, true)}</row>`);
  sheet.rows.forEach((row, i) => {
    lines.push(`<row r="${i + 2}">${cells(row, i + 2, false)}</row>`);
  });

  const widths = sheet.headers.map((h, i) => {
    const longest = Math.max(h.length, ...sheet.rows.slice(0, 200).map(r => String(r[i] ?? '').length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, Math.max(10, longest + 2))}" customWidth="1"/>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="A1:${col(sheet.headers.length - 1)}${sheet.rows.length + 1}"/>
</worksheet>`;
}

export function makeXlsx(sheets: Sheet[]): Uint8Array {
  const enc = new TextEncoder();
  const used = new Set<string>();
  const named = sheets.map((s, i) => {
    let name = safeTab(s.name);
    while (used.has(name.toLowerCase())) name = safeTab(`${name} ${i + 1}`);
    used.add(name.toLowerCase());
    return { ...s, name };
  });

  const entries: ZipEntry[] = [];
  const add = (name: string, xml: string) =>
    entries.push({ name, data: enc.encode(xml) });

  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`);

  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`);

  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  // Two styles: 0 normal, 1 bold — used for the header row.
  add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`);

  named.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));

  return makeZip(entries);
}
