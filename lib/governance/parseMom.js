// Deterministic MoM-as-Markdown parser — Phase 6, §5.5's "checklist path"
// counterpart for the narrative file. No LLM: only .md/.txt are parsed here.
// .docx/.pdf extraction (python-docx/pdfplumber + LLM in the original spec)
// is explicitly out of scope for this phase — see CLAUDE.md. Those two
// formats are still accepted at upload (Phase 4) but their parse_status
// stays 'pending' with a note in the submission's event log.
//
// Mirrors parseChecklist.js's output shape exactly ({tableRows, unmappedRows,
// warnings, counts}) and reuses the same validateSheetRow.js content rules,
// so a bad `priority` value produces an identical error whether it came from
// a spreadsheet cell or a markdown-table cell — and the same
// section/table-extraction helpers Phase 4 already uses to check MoM
// structure, so parsing and structural validation can never disagree about
// where a table starts or ends.
const { splitFrontmatter, extractSection, extractTable } = require('./markdownTable');
const { validateRow, rowIsBlank } = require('./validateSheetRow');

const SHEET_TABLE = { Wins: 'wins', Blockers: 'blockers', Dependencies: 'dependencies', Todos: 'todos' };
const SHEET_ORDER = ['Wins', 'Blockers', 'Dependencies', 'Todos'];

// Parses one section's table into { validRecords[], unmappedRows[], warnings[] }.
function parseSection(sheetName, lines, sheetDef, dynamicEnums) {
  const validRecords = [];
  const unmappedRows = [];
  const warnings = [];

  const table = extractTable(lines, sheetDef.columns || []);
  if (!table) return { validRecords, unmappedRows, warnings }; // no table at all is a STRUCTURAL gap, already rejected at upload (Phase 4) — defensive only

  const colIndex = {};
  table.headerCells.forEach((h, i) => { if ((sheetDef.columns || []).includes(h)) colIndex[h] = i; });

  let sawBlankRow = false;
  for (const dataRow of table.dataRows) {
    // A markdown table is structurally terminated by a blank line or the
    // next heading (extractSection/extractTable already stop there) — that
    // natural end is NOT what "blank row in the middle" means here. What
    // this checks for is a row that's still pipe-delimited but every cell
    // is empty (e.g. "| | | | |"), the markdown equivalent of an xlsx row
    // with cells but no values. Same stop-and-warn rule as the checklist.
    const getCellValue = col => (col in colIndex ? dataRow.cells[colIndex[col]] : null);
    if (rowIsBlank(getCellValue, sheetDef.columns || [])) { sawBlankRow = true; break; }

    const { record, errors, raw } = validateRow(getCellValue, sheetDef.columns || [], sheetDef, dynamicEnums);
    // dataRow.i is the 0-based line index within the section, not a
    // spreadsheet row number — still useful for locating the line in the
    // original file, just not directly comparable across formats.
    if (errors.length) unmappedRows.push({ sheet: sheetName, row: dataRow.i + 1, raw, errors });
    else validRecords.push(record);
  }
  if (sawBlankRow) warnings.push(`${sheetName}: stopped reading at a blank table row — any rows after it were not parsed.`);

  return { validRecords, unmappedRows, warnings };
}

// buffer -> { tableRows: {wins,blockers,dependencies,todos}, unmappedRows, warnings, counts }
// Same shape parseChecklistWorkbook returns, so the caller doesn't need to
// know which format produced it beyond stamping source_kind.
async function parseMomWorkbook(buffer, parserProfile, winCategories) {
  const text = buffer.toString('utf8');
  const split = splitFrontmatter(text);
  const body = split ? split.body : text; // structural gate already rejects missing frontmatter; defensive fallback only

  const tableRows = { wins: [], blockers: [], dependencies: [], todos: [] };
  const unmappedRows = [];
  const warnings = [];
  const counts = { wins: 0, blockers: 0, dependencies: 0, todos: 0 };

  for (const sheetName of SHEET_ORDER) {
    const def = parserProfile.sheets[sheetName];
    if (!def) continue;
    const lines = extractSection(body, sheetName);
    if (!lines) continue; // missing section is structural, already rejected at upload; defensive only

    const dynamicEnums = sheetName === 'Wins' ? { column: 'category', values: winCategories } : null;
    const { validRecords, unmappedRows: sectionUnmapped, warnings: sectionWarnings } = parseSection(sheetName, lines, def, dynamicEnums);

    const table = SHEET_TABLE[sheetName];
    tableRows[table] = validRecords;
    counts[table] = validRecords.length;
    unmappedRows.push(...sectionUnmapped);
    warnings.push(...sectionWarnings);
  }

  return { tableRows, unmappedRows, warnings, counts };
}

module.exports = { parseMomWorkbook };
