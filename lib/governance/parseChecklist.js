// Deterministic checklist parser — Phase 5. Column-driven: every sheet's
// column list, required fields, enum values, and date columns come from
// parser_profiles.sheets (invariant 11), nothing is hardcoded here except
// the wins/blockers/dependencies/todos table-name mapping, which mirrors
// the sheet names 1:1 and would need a matching profile change anyway if
// it ever needed to differ.
//
// By the time a file reaches this parser, Phase 4's upload gate has already
// guaranteed every expected sheet exists and every expected column header is
// present (structure). This parser only ever rejects a ROW, never the file:
// a bad cell value goes to unmapped_rows, exactly per invariant 10's
// structure-vs-content split. Column ORDER is not assumed — Phase 4's
// structural check is order-independent, so headers are resolved by name.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SHEET_TABLE = { Wins: 'wins', Blockers: 'blockers', Dependencies: 'dependencies', Todos: 'todos' };
const SHEET_ORDER = ['Wins', 'Blockers', 'Dependencies', 'Todos'];

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
function parseDateCell(v) {
  if (v == null || v === '') return { ok: false, ambiguous: false };
  if (v instanceof Date) return { ok: true, value: v.toISOString().slice(0, 10) };
  if (typeof v === 'object' && 'result' in v) return parseDateCell(v.result);
  const s = String(v).trim();
  if (ISO_DATE_RE.test(s)) return { ok: true, value: s };
  return { ok: false, ambiguous: /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s) };
}

// Our own templates always put the header at row 1, but a user who inserted
// a row above (or pasted from elsewhere) shouldn't hard-fail parsing — scan
// the first 10 rows and use whichever matches the most expected column names.
function findHeaderRow(ws, expectedColumns) {
  const wanted = new Set(expectedColumns.map(c => c.toLowerCase()));
  let best = { row: 1, score: -1 };
  for (let r = 1; r <= Math.min(10, ws.rowCount || 1); r++) {
    let score = 0;
    ws.getRow(r).eachCell({ includeEmpty: false }, cell => {
      const v = cellToText(cell.value).replace(/\*$/, '').toLowerCase();
      if (wanted.has(v)) score++;
    });
    if (score > best.score) best = { row: r, score };
  }
  return best.row;
}

function resolveColumnIndexes(ws, headerRow, expectedColumns) {
  const colIndex = {};
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, cell => {
    const name = cellToText(cell.value).replace(/\*$/, '').trim();
    if (expectedColumns.includes(name)) colIndex[name] = cell.col;
  });
  return colIndex;
}

// Parses one sheet into { validRecords[], unmappedRows[], warnings[] }.
// `dynamicEnums` lets the caller supply a validator sourced from a live
// table (Wins.category -> win_categories) instead of a static list in the
// profile — the whole reason that column became a lookup table was so new
// values don't need a profile/parser change, so this parser must ask the
// table, not a hardcoded set.
function parseSheet(ws, sheetDef, dynamicEnums) {
  const columns = sheetDef.columns || [];
  const required = new Set(sheetDef.required || []);
  const dateCols = new Set(sheetDef.dates || []);
  const enums = sheetDef.enums || {};
  const headerRow = findHeaderRow(ws, columns);
  const colIndex = resolveColumnIndexes(ws, headerRow, columns);

  const validRecords = [];
  const unmappedRows = [];
  const warnings = [];
  let sawBlankRow = false;
  let lastDataRow = headerRow;

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = {};
    let anyValue = false;
    for (const col of columns) {
      const idx = colIndex[col];
      const text = idx ? cellToText(row.getCell(idx).value) : '';
      raw[col] = text;
      if (text) anyValue = true;
    }

    if (!anyValue) {
      // "Jangan sisipkan baris kosong di tengah — parser berhenti di situ,"
      // per the template's own README. Stop scanning this sheet entirely
      // rather than skipping past the gap — rows after it are not read.
      sawBlankRow = true;
      break;
    }
    lastDataRow = r;

    const errors = [];
    const record = {};
    for (const col of columns) {
      const idx = colIndex[col];
      const cellVal = idx ? row.getCell(idx).value : null;
      const text = raw[col];

      if (dateCols.has(col)) {
        if (!text) {
          if (required.has(col)) errors.push(`${col} is required`);
          record[col] = null;
        } else {
          const parsed = parseDateCell(cellVal);
          if (!parsed.ok) {
            errors.push(parsed.ambiguous
              ? `${col} "${text}" is ambiguous — use YYYY-MM-DD, not a locale-specific format`
              : `${col} "${text}" is not a valid date`);
          } else {
            record[col] = parsed.value;
          }
        }
        continue;
      }

      if (required.has(col) && !text) { errors.push(`${col} is required`); record[col] = null; continue; }

      if (enums[col] && text && !enums[col].includes(text)) {
        errors.push(`${col} "${text}" is not one of: ${enums[col].join(', ')}`);
        record[col] = text;
        continue;
      }
      if (dynamicEnums && dynamicEnums.column === col && text && !dynamicEnums.values.has(text)) {
        errors.push(`${col} "${text}" is not a recognized category`);
        record[col] = text;
        continue;
      }

      record[col] = text || null;
    }

    if (errors.length) unmappedRows.push({ sheet: ws.name, row: r, raw, errors });
    else validRecords.push(record);
  }

  if (sawBlankRow && lastDataRow < ws.rowCount) {
    warnings.push(`${ws.name}: stopped reading at a blank row (row ${lastDataRow + 1}) — any rows after it were not parsed.`);
  }

  return { validRecords, unmappedRows, warnings };
}

// buffer -> { tableRows: {wins,blockers,dependencies,todos}, unmappedRows, warnings, counts }
async function parseChecklistWorkbook(buffer, parserProfile, winCategories) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const tableRows = { wins: [], blockers: [], dependencies: [], todos: [] };
  const unmappedRows = [];
  const warnings = [];
  const counts = { wins: 0, blockers: 0, dependencies: 0, todos: 0 };

  for (const sheetName of SHEET_ORDER) {
    const def = parserProfile.sheets[sheetName];
    const ws = wb.getWorksheet(sheetName);
    if (!def || !ws) continue; // already guaranteed present by Phase 4's gate; defensive only

    const dynamicEnums = sheetName === 'Wins' ? { column: 'category', values: winCategories } : null;
    const { validRecords, unmappedRows: sheetUnmapped, warnings: sheetWarnings } = parseSheet(ws, def, dynamicEnums);

    const table = SHEET_TABLE[sheetName];
    tableRows[table] = validRecords;
    counts[table] = validRecords.length;
    unmappedRows.push(...sheetUnmapped);
    warnings.push(...sheetWarnings);
  }

  return { tableRows, unmappedRows, warnings, counts };
}

module.exports = { parseChecklistWorkbook, parseDateCell, cellToText };
