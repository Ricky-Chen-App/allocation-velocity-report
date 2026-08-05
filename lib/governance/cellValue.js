// Shared by the checklist (xlsx cell values) and MoM (plain markdown-table
// strings) parsers — both formats' raw values funnel through these same two
// functions, so a date or text value is interpreted identically regardless
// of which file format it came from.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cellToText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellToText(v.result);       // formula cell
    if ('richText' in v) return v.richText.map(p => p.text).join('').trim(); // rich text
    if ('text' in v) return String(v.text).trim();          // hyperlink
  }
  return String(v).trim();
}

// Only a native Excel date cell or an exact YYYY-MM-DD string is accepted.
// An ambiguous string like "05/08/2026" (5 Aug or Aug 5?) is rejected
// outright rather than guessed — guessing wrong here silently corrupts a
// real deadline or win date, which is worse than making the filler retype it.
// A plain markdown-table string hits the same String(v) branch an xlsx cell's
// text would, so both formats get identical date handling for free.
function parseDateCell(v) {
  if (v == null || v === '') return { ok: false, ambiguous: false };
  if (v instanceof Date) return { ok: true, value: v.toISOString().slice(0, 10) };
  if (typeof v === 'object' && 'result' in v) return parseDateCell(v.result);
  const s = String(v).trim();
  if (ISO_DATE_RE.test(s)) return { ok: true, value: s };
  return { ok: false, ambiguous: /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s) };
}

module.exports = { cellToText, parseDateCell, ISO_DATE_RE };
