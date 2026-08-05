// Generates the three Phase 5 test fixtures. Run with:
//   node fixtures/build-fixtures.js
// Regenerate whenever parser_profiles.default's column list changes, so the
// fixtures stay honest about what a real upload looks like.
const path = require('path');
const ExcelJS = require('exceljs');
const {
  buildChecklistWorkbook, computePeriodEnd
} = require('../lib/governance/buildTemplates');

// Mirrors parser_profiles.default as of the governance_09 migration (incl.
// the `dates` arrays added for Phase 5, and wins.impact). Kept here as a
// literal snapshot for fixture generation only — the parser itself reads
// the real profile from the database, never this copy.
const PARSER_PROFILE = {
  code: 'default', schema_version: 2,
  sheets: {
    Wins: { columns: ['win_date', 'category', 'title', 'description', 'jira_issue_key', 'impact'], required: ['win_date', 'category', 'title'], dates: ['win_date'] },
    Blockers: { columns: ['title', 'priority', 'status', 'pic', 'bottleneck', 'next_action', 'target_date', 'jira_issue_key'], required: ['title', 'priority', 'status', 'pic', 'bottleneck', 'next_action'], dates: ['target_date'], enums: { priority: ['P0', 'P1', 'P2', 'P3', 'P4'], status: ['Open', 'In Progress', 'Resolved'] } },
    Dependencies: { columns: ['title', 'depends_on', 'direction', 'status', 'pic', 'target_date', 'jira_issue_key', 'notes'], required: ['title', 'depends_on', 'direction', 'status'], dates: ['target_date'], enums: { direction: ['inbound', 'outbound'], status: ['Open', 'In Progress', 'Resolved'] } },
    Todos: { columns: ['title', 'pic', 'due_date', 'priority', 'status', 'jira_issue_key', 'notes'], required: ['title', 'pic', 'due_date', 'priority', 'status'], dates: ['due_date'], enums: { priority: ['P0', 'P1', 'P2', 'P3', 'P4'], status: ['Not Started', 'In Progress', 'Done', 'Blocked'] } }
  }
};

async function baseWorkbook(periodStart) {
  return buildChecklistWorkbook({
    project: { key: 'AIRPAY', name: 'Airpay Reengineering' },
    periodType: 'weekly', periodStart, periodEnd: computePeriodEnd('weekly', periodStart),
    parserProfile: PARSER_PROFILE, submittedByEmail: 'fixtures@linkit360.com', teamSlug: ''
  });
}

async function buildValid() {
  const wb = await baseWorkbook('2026-08-03');

  const wins = wb.getWorksheet('Wins');
  wins.getCell('A2').value = new Date(Date.UTC(2026, 7, 5));
  wins.getCell('B2').value = 'Platform'; wins.getCell('C2').value = 'Payment gateway v2 live';
  wins.getCell('D2').value = 'Zero-downtime migration'; wins.getCell('E2').value = 'AIRPAY-482'; wins.getCell('F2').value = 'Latency -60%';
  wins.getCell('A3').value = '2026-08-06'; // exact ISO string, not a Date object — also valid
  wins.getCell('B3').value = 'DCB'; wins.getCell('C3').value = 'Klickmobi billing fix';
  wins.getCell('D3').value = 'Resolved notification bug'; wins.getCell('E3').value = ''; wins.getCell('F3').value = '';

  const blk = wb.getWorksheet('Blockers');
  blk.getCell('A2').value = 'Sandbox credentials not issued'; blk.getCell('B2').value = 'P1'; blk.getCell('C2').value = 'In Progress';
  blk.getCell('D2').value = 'Andi'; blk.getCell('E2').value = 'Waiting on partner approval'; blk.getCell('F2').value = 'Escalated via PM';
  blk.getCell('G2').value = new Date(Date.UTC(2026, 7, 12)); blk.getCell('H2').value = 'AIRPAY-501';

  const dep = wb.getWorksheet('Dependencies');
  dep.getCell('A2').value = 'Needs settlement endpoint'; dep.getCell('B2').value = 'PPOB Developer'; dep.getCell('C2').value = 'outbound';
  dep.getCell('D2').value = 'Open'; dep.getCell('E2').value = 'Budi'; dep.getCell('F2').value = '2026-08-15';
  dep.getCell('G2').value = 'ARC-77'; dep.getCell('H2').value = 'Spec sent 2026-07-28';

  const todo = wb.getWorksheet('Todos');
  todo.getCell('A2').value = 'Instrument gateway v2 metrics'; todo.getCell('B2').value = 'Andi'; todo.getCell('C2').value = '2026-08-14';
  todo.getCell('D2').value = 'P1'; todo.getCell('E2').value = 'In Progress'; todo.getCell('F2').value = 'AIRPAY-505'; todo.getCell('G2').value = 'Needed for uptime dashboard';
  todo.getCell('A3').value = 'Write postmortem'; todo.getCell('B3').value = 'Rani'; todo.getCell('C3').value = '2026-08-16';
  todo.getCell('D3').value = 'P2'; todo.getCell('E3').value = 'Not Started'; todo.getCell('F3').value = ''; todo.getCell('G3').value = '';

  await wb.xlsx.writeFile(path.join(__dirname, 'sample_checklist_valid.xlsx'));
  console.log('wrote sample_checklist_valid.xlsx');
}

async function buildBroken() {
  const wb = await baseWorkbook('2026-08-10');

  // Defect 1 ("kolom hilang" -> read as a required cell left empty, since a
  // literal missing COLUMN would already be rejected at upload time by
  // Phase 4's structural gate, never reaching this parser at all): Wins row 2
  // has no title.
  const wins = wb.getWorksheet('Wins');
  wins.getCell('A2').value = new Date(Date.UTC(2026, 7, 12));
  wins.getCell('B2').value = 'Platform'; wins.getCell('C2').value = ''; // title required, left blank
  wins.getCell('D2').value = 'Missing a title'; wins.getCell('E2').value = ''; wins.getCell('F2').value = '';

  const blk = wb.getWorksheet('Blockers');
  // Defect 2 (merge cell): merge priority (B) with status (C) so both read
  // the same text — verified empirically that exceljs mirrors the master
  // cell's value into merged cells rather than leaving them blank, so this
  // manifests as an invalid value in BOTH columns, not a missing one.
  blk.getCell('B2').value = 'Merged';
  blk.mergeCells('B2:C2');
  blk.getCell('A2').value = 'Row with merged priority/status cells';
  blk.getCell('D2').value = 'Andi'; blk.getCell('E2').value = 'Bottleneck text'; blk.getCell('F2').value = 'Next action text';
  blk.getCell('G2').value = new Date(Date.UTC(2026, 7, 12)); blk.getCell('H2').value = '';
  // Defect 3 (priority "High" — the exact case named in the prompt): a
  // plain, unmerged row with an invalid enum value.
  blk.getCell('A3').value = 'Row with invalid priority';
  blk.getCell('B3').value = 'High'; blk.getCell('C3').value = 'Open';
  blk.getCell('D3').value = 'Someone'; blk.getCell('E3').value = 'Some bottleneck'; blk.getCell('F3').value = 'Some next action';
  blk.getCell('G3').value = ''; blk.getCell('H3').value = '';

  // Defect 4 (ambiguous date "05/08/2026" — could be 5-Aug or Aug-5, never guessed).
  const dep = wb.getWorksheet('Dependencies');
  dep.getCell('A2').value = 'Row with an ambiguous date';
  dep.getCell('B2').value = 'PPOB Developer'; dep.getCell('C2').value = 'outbound'; dep.getCell('D2').value = 'Open';
  dep.getCell('E2').value = 'Budi'; dep.getCell('F2').value = '05/08/2026'; // ambiguous, written as a literal string
  dep.getCell('G2').value = ''; dep.getCell('H2').value = '';

  // Defect 5 (blank row in the middle): row 2 valid, row 3 fully blank, row 4
  // has real-looking data that must NOT be parsed because the scan stops at
  // the blank row per the template's own README instruction.
  const todo = wb.getWorksheet('Todos');
  todo.getCell('A2').value = 'Valid todo before the gap'; todo.getCell('B2').value = 'Andi'; todo.getCell('C2').value = '2026-08-14';
  todo.getCell('D2').value = 'P1'; todo.getCell('E2').value = 'In Progress'; todo.getCell('F2').value = ''; todo.getCell('G2').value = '';
  // row 3 intentionally left fully empty
  todo.getCell('A4').value = 'This must NOT be parsed'; todo.getCell('B4').value = 'Ghost'; todo.getCell('C4').value = '2026-08-20';
  todo.getCell('D4').value = 'P0'; todo.getCell('E4').value = 'Not Started'; todo.getCell('F4').value = ''; todo.getCell('G4').value = '';

  await wb.xlsx.writeFile(path.join(__dirname, 'sample_checklist_broken.xlsx'));
  console.log('wrote sample_checklist_broken.xlsx');
}

// schema_version 1 shape (team-based, no Todos sheet) — must be rejected at
// Phase 4's upload gate (layer 3), never reach this parser. Built directly
// with exceljs rather than buildChecklistWorkbook, since that function only
// knows how to emit the CURRENT (schema_version 2) shape.
async function buildOldSchema() {
  const wb = new ExcelJS.Workbook();
  const meta = wb.addWorksheet('Meta');
  meta.getCell('A4').value = 'schema_version'; meta.getCell('B4').value = 1;
  meta.getCell('A5').value = 'team_slug*'; meta.getCell('B5').value = 'airpay-developer';
  meta.getCell('A6').value = 'period_type*'; meta.getCell('B6').value = 'weekly';
  meta.getCell('A7').value = 'period_start*'; meta.getCell('B7').value = '2026-08-03';
  meta.getCell('A8').value = 'period_end*'; meta.getCell('B8').value = '2026-08-09';

  const wins = wb.addWorksheet('Wins');
  wins.getRow(1).values = ['win_date*', 'category*', 'title*', 'description', 'jira_issue_key'];
  const blk = wb.addWorksheet('Blockers');
  blk.getRow(1).values = ['title*', 'priority*', 'status*', 'pic*', 'bottleneck*', 'next_action*'];
  const dep = wb.addWorksheet('Dependencies');
  dep.getRow(1).values = ['title*', 'depends_on*', 'direction*', 'status*'];
  // Deliberately no Todos sheet at all.

  await wb.xlsx.writeFile(path.join(__dirname, 'sample_checklist_old_schema.xlsx'));
  console.log('wrote sample_checklist_old_schema.xlsx');
}

(async () => {
  await buildValid();
  await buildBroken();
  await buildOldSchema();
})();
