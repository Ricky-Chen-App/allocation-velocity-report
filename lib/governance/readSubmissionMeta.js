// Reads just enough of an uploaded submission file to run Phase 4's
// structural validation gates — the Meta block (or YAML frontmatter) and
// each data sheet's header row. This never reads data-row VALUES: cell-level
// validation (enums, required fields per row) is deferred entirely to the
// parser (Phase 5/6), matching the spec's own split between "structure"
// (reject) and "content" (accept + unmapped_rows).
//
// .xlsx is read via exceljs (already a dependency for template generation).
// .xls (legacy BIFF) is deliberately NOT supported: the only maintained Node
// library for it, the `xlsx` npm package (SheetJS), currently ships with an
// unpatched HIGH-severity prototype-pollution/ReDoS advisory with no fix on
// the public registry — exactly the wrong package to hand untrusted,
// attacker-controlled file uploads to. Every file this app's own Phase 3
// templates produce is .xlsx; a legacy .xls upload is rejected with a clear
// message rather than silently accepted by a vulnerable parser.
const ExcelJS = require('exceljs');
const yaml = require('js-yaml');
const { splitFrontmatter, extractSection, extractTable } = require('./markdownTable');

const SHEET_ORDER = ['Wins', 'Blockers', 'Dependencies', 'Todos'];

function stripRequiredMarker(v) {
  return String(v == null ? '' : v).replace(/\*$/, '').trim();
}
function cellToString(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && 'result' in value) return cellToString(value.result); // formula cell
  return String(value).trim();
}

async function readChecklistMeta(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const metaSheet = wb.getWorksheet('Meta');
  if (!metaSheet) return { error: 'missing_sheet', sheet: 'Meta' };

  const metaFields = {};
  metaSheet.eachRow((row, rowNumber) => {
    if (rowNumber < 4) return; // rows 1-3 are title/column-header, data starts row 4 (our template layout)
    const field = stripRequiredMarker(row.getCell(1).value);
    if (!field) return;
    metaFields[field] = cellToString(row.getCell(2).value);
  });

  const sheetHeaders = {};
  wb.eachSheet(ws => {
    if (ws.name === 'Meta' || ws.name === 'README') return;
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, cell => {
      const h = stripRequiredMarker(cell.value);
      if (h) headers.push(h);
    });
    sheetHeaders[ws.name] = headers;
  });

  return { metaFields, sheetNames: wb.worksheets.map(s => s.name), sheetHeaders };
}

function readMomMeta(buffer) {
  const text = buffer.toString('utf8');
  const split = splitFrontmatter(text);
  if (!split) return { error: 'missing_frontmatter' };
  let parsed;
  try {
    // FAILSAFE_SCHEMA: everything comes back as a string, nothing auto-typed
    // to number/bool/date — the same "don't let the reader silently coerce
    // values" principle invariant 12 asks for on the spreadsheet side.
    parsed = yaml.load(split.frontmatter, { schema: yaml.FAILSAFE_SCHEMA }) || {};
  } catch (e) {
    return { error: 'invalid_frontmatter', message: e.message };
  }
  const metaFields = {};
  Object.keys(parsed).forEach(k => { metaFields[k] = cellToString(parsed[k]); });

  // Table structure is checked the same way an .xlsx checklist's sheet
  // headers are — a MoM missing a whole "## Wins" section, or with a
  // mistyped column, is a structural problem (reject), not row content.
  // Added when Phase 6 introduced the table-extraction logic this needs;
  // Phase 4 originally only checked Meta fields for MoM because that logic
  // didn't exist yet — this closes that gap rather than leaving MoM
  // permanently less strictly checked than the checklist path.
  const sheetHeaders = {};
  for (const sheetName of SHEET_ORDER) {
    const lines = extractSection(split.body, sheetName);
    if (!lines) continue; // section missing entirely -> sheetHeaders[name] stays undefined -> reported as missing_sheet
    const table = extractTable(lines, []); // [] = accept whatever header cells are present; diffSheetColumns does the real comparison
    if (table) sheetHeaders[sheetName] = table.headerCells;
  }

  return { metaFields, sheetNames: SHEET_ORDER.filter(s => sheetHeaders[s]), sheetHeaders };
}

// .xlsx checklist and MoM-as-Markdown (.md/.txt) can both be structurally
// checked against parser_profiles in Phase 4. .docx/.pdf MoM files have no
// accessible Meta without full text extraction — that's Phase 6's job,
// so for those two formats this returns null and the caller skips layers
// 3/4/6 entirely for that file (documented limitation, not a silent gap).
async function readSubmissionMeta(buffer, ext, kind) {
  if (kind === 'checklist') {
    if (ext !== 'xlsx') return { error: 'unsupported_format', message: '.xls is not supported yet — please use the .xlsx template.' };
    return readChecklistMeta(buffer);
  }
  if (ext === 'md' || ext === 'txt') return readMomMeta(buffer);
  return null; // .docx / .pdf — structural check not possible yet
}

// Required regardless of file type (checklist or MoM-as-Markdown) — without
// these, layers 4/6 (project_key match, period match) have nothing to
// compare against.
const REQUIRED_META_FIELDS = ['project_key', 'period_type', 'period_start', 'schema_version'];

function diffMetaFields(metaFields, parserProfile) {
  const differences = [];
  for (const f of REQUIRED_META_FIELDS) {
    if (!metaFields[f]) differences.push({ type: 'missing_meta_field', field: f });
  }
  if (metaFields.schema_version && String(metaFields.schema_version) !== String(parserProfile.schema_version)) {
    differences.push({ type: 'schema_version_mismatch', expected: parserProfile.schema_version, found: metaFields.schema_version });
  }
  const foundProfile = metaFields.parser_profile;
  // Only flag when the field is present — the two stale Template_v1*
  // candidates never had a parser_profile row at all, and that's already
  // caught by the schema_version mismatch above; no need to double-report it.
  if (foundProfile && foundProfile !== parserProfile.code) {
    differences.push({ type: 'parser_profile_mismatch', expected: parserProfile.code, found: foundProfile });
  }
  return differences;
}

function diffSheetColumns(sheetHeaders, parserProfile) {
  const differences = [];
  const dataSheets = Object.keys(parserProfile.sheets || {}).filter(s => s !== 'Meta');
  for (const sheetName of dataSheets) {
    const def = parserProfile.sheets[sheetName] || {};
    const actualHeaders = sheetHeaders[sheetName];
    if (!actualHeaders) {
      differences.push({ type: 'missing_sheet', sheet: sheetName });
      continue;
    }
    for (const col of def.columns || []) {
      if (!actualHeaders.includes(col)) differences.push({ type: 'missing_column', sheet: sheetName, column: col });
    }
  }
  return differences;
}

// Compares what was actually found in the file against what the project's
// parser profile expects. Structure only (Meta fields, sheets, columns) —
// never row content, per the file's top comment. Checklist (.xlsx) and MoM
// (.md/.txt) get the identical check now that both populate sheetHeaders;
// .docx/.pdf never reach here at all (readSubmissionMeta returns null for
// them), so the `kind` param is unused here but kept for readability at
// call sites.
function diffStructure(read, parserProfile, kind) { // eslint-disable-line no-unused-vars
  return [...diffMetaFields(read.metaFields, parserProfile), ...diffSheetColumns(read.sheetHeaders, parserProfile)];
}

module.exports = { readSubmissionMeta, diffStructure };
