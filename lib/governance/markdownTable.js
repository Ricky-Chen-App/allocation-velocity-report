// Shared markdown structure helpers, used by both:
//  - readSubmissionMeta.js (Phase 4): structure only — which sections/columns
//    exist, never row content — so a MoM .md gets the same "reject on
//    structure, never on content" gate an .xlsx checklist already gets.
//  - parseMom.js (Phase 6): full row-content parsing, reusing the exact same
//    section/table extraction so both layers agree on where a table starts
//    and ends.
function splitFrontmatter(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!m) return null;
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

// Lines belonging to a "## Heading" section, up to the next "#"/"##" heading
// or end of document. Returns null if the heading isn't present at all.
function extractSection(body, heading) {
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx);
}

// "| a | b | c |" -> ["a","b","c"]; tolerates a missing leading/trailing pipe.
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

// The "|---|---|" (or "|:--|--:|" etc.) rule row under a table header.
function isTableRuleRow(cells) {
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c));
}

// Finds the markdown table within a section's lines and splits it into a
// header (matched against `expectedColumns` the same order-independent way
// the checklist parser resolves xlsx headers) and the remaining data lines.
// Returns null if no table is present at all — that's a structural gap
// (missing_sheet-equivalent), not a content issue.
function extractTable(lines, expectedColumns) {
  const tableLines = lines
    .map((l, i) => ({ i, raw: l, cells: l.trim().startsWith('|') ? splitTableRow(l) : null }))
    .filter(x => x.cells);
  if (!tableLines.length) return null;

  const wanted = new Set(expectedColumns.map(c => c.toLowerCase()));
  let headerIdx = 0, bestScore = -1;
  tableLines.forEach((row, idx) => {
    const score = row.cells.filter(c => wanted.has(c.replace(/\*$/, '').toLowerCase())).length;
    if (score > bestScore) { bestScore = score; headerIdx = idx; }
  });

  const headerCells = tableLines[headerIdx].cells.map(c => c.replace(/\*$/, '').trim());
  let dataStart = headerIdx + 1;
  if (tableLines[dataStart] && isTableRuleRow(tableLines[dataStart].cells)) dataStart++;

  return { headerCells, dataRows: tableLines.slice(dataStart) };
}

module.exports = { splitFrontmatter, extractSection, extractTable };
