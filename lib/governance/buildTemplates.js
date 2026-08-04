// Governance checklist/MoM template generators — Phase 3.
//
// Neither blank template found in Downloads (Checklist_Template_v1.xlsx,
// Checklist_Template_v1-2.xlsx) matches the schema this app already commits
// to: v1 is team-based (superseded — compliance unit is the project), v1-2
// is project-based but missing the Todos sheet and half of Meta
// (period_end/submitted_by/submitted_at/notes). Both are schema_version 1;
// parser_profiles.default (seeded in the Phase 1 migration) is
// schema_version 2, matching the real Checklist_AIRPAY_W32_v2.xlsx sample.
// Rather than base a new download on a stale file, this builds the workbook
// fresh each request from parser_profiles.sheets — so a future profile
// version changes the template automatically, with no second place to edit.
const ExcelJS = require('exceljs');

const SHEET_ORDER = ['Wins', 'Blockers', 'Dependencies', 'Todos'];

// Illustrative "delete before submitting" row content — not part of the
// column schema (that lives in parser_profiles.sheets), just example text
// styled gray/italic, matching the convention already established in the
// Template_v1* files ("baris 2 = CONTOH, hapus sebelum submit").
const EXAMPLE_ROWS = {
  Wins: ['2026-08-05', 'Platform', 'Payment gateway v2 live in production',
    'Migration completed with zero downtime, latency dropped from 800ms to 210ms',
    'AIRPAY-482', 'Throughput up 3x, ready for peak traffic'],
  Blockers: ['Sandbox credentials not yet issued', 'P1', 'In Progress', 'Andi',
    'Waiting on partner approval, 9 days with no response',
    'Escalated to partner PIC via PM, reply deadline 2026-08-08', '2026-08-12', 'AIRPAY-501'],
  Dependencies: ['Needs settlement endpoint from the PPOB team', 'PPOB Developer', 'outbound', 'Open',
    'Budi', '2026-08-15', 'ARC-77', 'Spec sent 2026-07-28, waiting on API contract confirmation'],
  Todos: ['Instrument gateway v2 metrics', 'Andi', '2026-08-14', 'P1', 'In Progress',
    'AIRPAY-505', 'Needed by the APMS team for the uptime dashboard']
};

const HEADER_STYLE = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } } };
const GRAY_ITALIC = { font: { italic: true, color: { argb: 'FF9CA3AF' } } };

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// weekly: 7-day window starting at period_start. monthly: last day of that
// month. Deliberately simple — the caller supplies period_start rather than
// this resolving "the project's current period" from compliance_policies,
// since no admin UI to set policies exists yet (a later phase).
function computePeriodEnd(periodType, periodStartIso) {
  const start = new Date(`${periodStartIso}T00:00:00Z`);
  if (periodType === 'monthly') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return end.toISOString().slice(0, 10);
}

// Checklist_<KEY>_W<nn>_v<schema>.xlsx (weekly) — spec's own example.
// Monthly isn't specified in the spec; M<mm> is the natural extension.
function checklistFileName(projectKey, periodType, periodStartIso, schemaVersion) {
  const start = new Date(`${periodStartIso}T00:00:00Z`);
  const label = periodType === 'monthly'
    ? `M${String(start.getUTCMonth() + 1).padStart(2, '0')}`
    : `W${String(isoWeek(start)).padStart(2, '0')}`;
  return `Checklist_${projectKey}_${label}_v${schemaVersion}.xlsx`;
}
function momFileName(projectKey, periodType, periodStartIso) {
  const start = new Date(`${periodStartIso}T00:00:00Z`);
  const label = periodType === 'monthly'
    ? `M${String(start.getUTCMonth() + 1).padStart(2, '0')}`
    : `W${String(isoWeek(start)).padStart(2, '0')}`;
  return `MoM_${projectKey}_${label}.md`;
}

// Builds a personalized, pre-filled checklist workbook. Meta's required
// fields (project_key, period_type, period_start, period_end,
// schema_version, parser_profile) are cell-protected so they can't be
// fat-fingered; project_name/team_slug/submitted_by/notes stay editable.
// parser_profile is additionally hidden — it's an internal routing field,
// not something a filler needs to see or touch.
async function buildChecklistWorkbook({ project, periodType, periodStart, periodEnd, parserProfile, submittedByEmail, teamSlug }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Resource Portal — Linkit360';
  wb.created = new Date();

  const readme = wb.addWorksheet('README');
  readme.getColumn(1).width = 100;
  const lines = [
    'Weekly Compliance Checklist — Template (per Project)',
    '',
    'How to use',
    '1. Fill in the Meta sheet first. Required — the parser reads project_key and the period from there, not from the filename.',
    '2. One file = one project. Do not combine multiple projects in one file.',
    '3. Fill Wins, Blockers, Dependencies, and Todos as needed — some may be left empty.',
    '4. Row 2 of each data sheet is an EXAMPLE (gray, italic). Delete it before submitting.',
    '5. Do not leave a blank row in the middle of your data — the parser stops there.',
    '6. Do not change sheet names, column names, or column order. Column names are the database column names.'
  ];
  lines.forEach((line, i) => { readme.getCell(i + 1, 1).value = line; });
  readme.getCell(1, 1).font = { bold: true, size: 13 };

  const meta = wb.addWorksheet('Meta');
  meta.getColumn(1).width = 18;
  meta.getColumn(2).width = 34;
  meta.getColumn(3).width = 72;
  meta.getCell('A1').value = 'Meta — required';
  meta.getCell('A1').font = { bold: true, size: 13 };
  meta.getCell('A3').value = 'Field'; meta.getCell('B3').value = 'Value'; meta.getCell('C3').value = 'Notes';
  ['A3', 'B3', 'C3'].forEach(ref => Object.assign(meta.getCell(ref), HEADER_STYLE));

  const metaRows = [
    { field: 'schema_version', value: parserProfile.schema_version, note: 'Do not change. Used by the parser to pick the right mapping.', locked: true },
    { field: 'project_key*', value: project.key, note: 'Jira project key. Must match exactly, uppercase.', locked: true },
    { field: 'project_name', value: project.name, note: 'Project display name. Prefilled from Jira.', locked: false },
    { field: 'team_slug', value: teamSlug || '', note: 'Owning team. Optional — used to group rows on the Compliance Board.', locked: false },
    { field: 'period_type*', value: periodType, note: 'weekly or monthly.', locked: true },
    { field: 'period_start*', value: periodStart, note: 'Format YYYY-MM-DD.', locked: true },
    { field: 'period_end*', value: periodEnd, note: 'Format YYYY-MM-DD.', locked: true },
    { field: 'submitted_by*', value: submittedByEmail, note: 'Filler’s email. Must be registered in app_users.', locked: false },
    { field: 'submitted_at', value: '', note: 'Format YYYY-MM-DD. Leave blank — filled automatically on upload.', locked: true },
    { field: 'notes', value: '', note: 'Free-text notes. Optional.', locked: false },
    { field: 'parser_profile', value: parserProfile.code, note: 'Do not change. Selects the column mapping.', locked: true, hidden: true }
  ];
  metaRows.forEach((row, i) => {
    const r = i + 4;
    meta.getCell(r, 1).value = row.field;
    meta.getCell(r, 2).value = row.value;
    meta.getCell(r, 3).value = row.note;
    meta.getCell(r, 2).protection = { locked: !!row.locked };
    meta.getCell(r, 1).protection = { locked: true };
    meta.getCell(r, 3).protection = { locked: true };
    if (row.hidden) meta.getRow(r).hidden = true;
  });
  // No real password — this guards against fat-fingering the wrong cell, not
  // a security boundary (that's the server-side re-verification on upload).
  await meta.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  // Data sheets: column list comes from parser_profiles.sheets, never
  // hardcoded here — a future profile version changes the template with no
  // second place to edit.
  for (const sheetName of SHEET_ORDER) {
    const def = parserProfile.sheets[sheetName];
    if (!def) continue;
    const ws = wb.addWorksheet(sheetName);
    const required = new Set(def.required || []);
    (def.columns || []).forEach((col, i) => {
      const cell = ws.getCell(1, i + 1);
      cell.value = col + (required.has(col) ? '*' : '');
      Object.assign(cell, HEADER_STYLE);
      ws.getColumn(i + 1).width = Math.max(16, col.length + 4);
    });
    const example = EXAMPLE_ROWS[sheetName];
    if (example) {
      example.forEach((val, i) => {
        const cell = ws.getCell(2, i + 1);
        cell.value = val;
        Object.assign(cell, GRAY_ITALIC);
      });
    }
  }

  return wb;
}

// No MoM_Template_v1.md was ever supplied, so this format is a deliberate
// design choice: it mirrors the checklist's exact columns as Markdown tables
// (so Phase 6's deterministic Markdown-table parser can read it the same
// way §5.5 expects checklist and MoM rows to line up), with narrative
// sections left free-form.
function buildMomMarkdown({ project, periodType, periodStart, periodEnd, submittedByEmail, teamSlug, schemaVersion }) {
  const fm = [
    '---',
    `schema_version: ${schemaVersion}`,
    `project_key: ${project.key}`,
    `project_name: ${JSON.stringify(project.name)}`,
    `team_slug: "${teamSlug || ''}"`,
    `period_type: ${periodType}`,
    `period_start: ${periodStart}`,
    `period_end: ${periodEnd}`,
    `submitted_by: ${submittedByEmail}`,
    'submitted_at: ""',
    '---'
  ].join('\n');

  return `${fm}

# Minutes of Meeting — ${project.name} (${project.key})

> Fill in each section below. Tables use the same columns as the checklist —
> when both a checklist and a MoM are uploaded for the same period, rows are
> matched by \`jira_issue_key\` (or by title when both lack one). Delete the
> example row in each table before submitting.

## Wins

| win_date* | category* | title* | description | jira_issue_key | impact |
|---|---|---|---|---|---|
| 2026-08-05 | Platform | Payment gateway v2 live in production | Migration completed with zero downtime | AIRPAY-482 | Throughput up 3x |

## Blockers

| title* | priority* | status* | pic* | bottleneck* | next_action* | target_date | jira_issue_key |
|---|---|---|---|---|---|---|---|
| Sandbox credentials not yet issued | P1 | In Progress | Andi | Waiting on partner approval | Escalated via PM | 2026-08-12 | AIRPAY-501 |

## Dependencies

| title* | depends_on* | direction* | status* | pic | target_date | jira_issue_key | notes |
|---|---|---|---|---|---|---|---|
| Needs settlement endpoint from PPOB | PPOB Developer | outbound | Open | Budi | 2026-08-15 | ARC-77 | Spec sent 2026-07-28 |

## Todos

| title* | pic* | due_date* | priority* | status* | jira_issue_key | notes |
|---|---|---|---|---|---|---|
| Instrument gateway v2 metrics | Andi | 2026-08-14 | P1 | In Progress | AIRPAY-505 | Needed for uptime dashboard |

## Notes

_Free-text notes for anything the tables above don't capture._
`;
}

module.exports = {
  buildChecklistWorkbook,
  buildMomMarkdown,
  computePeriodEnd,
  checklistFileName,
  momFileName,
  isoWeek
};
