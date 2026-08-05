// Shared by the checklist (xlsx) and MoM (markdown-table) parsers — the
// content-level validation rules (required / date / enum) must produce
// identical results and identical error messages regardless of which file
// format a given row came from. Only extraction of the raw per-column value
// differs by format; that's the caller's job via `getCellValue`.
const { cellToText, parseDateCell } = require('./cellValue');

// getCellValue(col) -> raw value for that column in the current row (an
// exceljs cell.value for the checklist, or a plain string for MoM).
// dynamicEnums: { column, values: Set } for a column whose valid values live
// in a DB table (wins.category -> win_categories) rather than the profile.
function validateRow(getCellValue, columns, sheetDef, dynamicEnums) {
  const required = new Set(sheetDef.required || []);
  const dateCols = new Set(sheetDef.dates || []);
  const enums = sheetDef.enums || {};

  const errors = [];
  const raw = {};
  const record = {};

  for (const col of columns) {
    const cellVal = getCellValue(col);
    const text = cellToText(cellVal);
    raw[col] = text;

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

  return { record, errors, raw };
}

// True when every expected column is empty for this row — both parsers stop
// scanning a sheet/table at the first such row, per the template's own
// README instruction, rather than skipping past the gap.
function rowIsBlank(getCellValue, columns) {
  return columns.every(col => !cellToText(getCellValue(col)));
}

module.exports = { validateRow, rowIsBlank };
