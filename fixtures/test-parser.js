// Lightweight test runner (no test framework in this repo — consistent with
// its 3-dependency-then-a-few-more-for-governance discipline). Run with:
//   node fixtures/test-parser.js
// Exercises lib/governance/parseChecklist.js against the three fixtures.
// sample_checklist_old_schema.xlsx is tested against Phase 4's upload gate
// (readSubmissionMeta + diffStructure), not the parser — it must never reach
// the parser at all, which is the point of that fixture.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseChecklistWorkbook } = require('../lib/governance/parseChecklist');
const { readSubmissionMeta, diffStructure } = require('../lib/governance/readSubmissionMeta');

const PARSER_PROFILE = {
  code: 'default', schema_version: 2,
  sheets: {
    Wins: { columns: ['win_date', 'category', 'title', 'description', 'jira_issue_key', 'impact'], required: ['win_date', 'category', 'title'], dates: ['win_date'] },
    Blockers: { columns: ['title', 'priority', 'status', 'pic', 'bottleneck', 'next_action', 'target_date', 'jira_issue_key'], required: ['title', 'priority', 'status', 'pic', 'bottleneck', 'next_action'], dates: ['target_date'], enums: { priority: ['P0', 'P1', 'P2', 'P3', 'P4'], status: ['Open', 'In Progress', 'Resolved'] } },
    Dependencies: { columns: ['title', 'depends_on', 'direction', 'status', 'pic', 'target_date', 'jira_issue_key', 'notes'], required: ['title', 'depends_on', 'direction', 'status'], dates: ['target_date'], enums: { direction: ['inbound', 'outbound'], status: ['Open', 'In Progress', 'Resolved'] } },
    Todos: { columns: ['title', 'pic', 'due_date', 'priority', 'status', 'jira_issue_key', 'notes'], required: ['title', 'pic', 'due_date', 'priority', 'status'], dates: ['due_date'], enums: { priority: ['P0', 'P1', 'P2', 'P3', 'P4'], status: ['Not Started', 'In Progress', 'Done', 'Blocked'] } }
  }
};
const WIN_CATEGORIES = new Set(['DCB', 'Digital Payment', 'Platform']);

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (e) { failures++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}
function read(name) { return fs.readFileSync(path.join(__dirname, name)); }

(async () => {
  console.log('sample_checklist_valid.xlsx');
  {
    const result = await parseChecklistWorkbook(read('sample_checklist_valid.xlsx'), PARSER_PROFILE, WIN_CATEGORIES);
    check('2 valid wins rows', () => assert.strictEqual(result.tableRows.wins.length, 2));
    check('1 valid blockers row', () => assert.strictEqual(result.tableRows.blockers.length, 1));
    check('1 valid dependencies row', () => assert.strictEqual(result.tableRows.dependencies.length, 1));
    check('2 valid todos rows', () => assert.strictEqual(result.tableRows.todos.length, 2));
    check('no unmapped rows', () => assert.strictEqual(result.unmappedRows.length, 0));
    check('no warnings', () => assert.strictEqual(result.warnings.length, 0));
    check('win_date parsed from a Date cell', () => assert.strictEqual(result.tableRows.wins[0].win_date, '2026-08-05'));
    check('win_date parsed from an ISO string cell', () => assert.strictEqual(result.tableRows.wins[1].win_date, '2026-08-06'));
    check('impact column carried through (not silently dropped)', () => assert.strictEqual(result.tableRows.wins[0].impact, 'Latency -60%'));
    check('optional empty cell is null, not empty string', () => assert.strictEqual(result.tableRows.wins[1].jira_issue_key, null));
  }

  console.log('\nsample_checklist_broken.xlsx');
  {
    const result = await parseChecklistWorkbook(read('sample_checklist_broken.xlsx'), PARSER_PROFILE, WIN_CATEGORIES);
    check('does not throw and returns a result', () => assert.ok(result));
    check('missing title -> 1 unmapped win, 0 valid', () => {
      assert.strictEqual(result.tableRows.wins.length, 0);
    });
    check('merged-cell row -> unmapped (invalid priority AND status)', () => {
      const row = result.unmappedRows.find(u => u.sheet === 'Blockers' && u.row === 2);
      assert.ok(row, 'expected an unmapped row for Blockers row 2');
      assert.ok(row.errors.some(e => e.includes('priority')), 'expected a priority error');
      assert.ok(row.errors.some(e => e.includes('status')), 'expected a status error');
    });
    check('priority="High" -> unmapped with a clear priority error', () => {
      const row = result.unmappedRows.find(u => u.sheet === 'Blockers' && u.row === 3);
      assert.ok(row, 'expected an unmapped row for Blockers row 3');
      assert.ok(row.errors.some(e => e.includes('priority') && e.includes('High')));
    });
    check('0 valid blockers rows (both were bad)', () => assert.strictEqual(result.tableRows.blockers.length, 0));
    check('ambiguous date "05/08/2026" -> unmapped, not guessed', () => {
      const row = result.unmappedRows.find(u => u.sheet === 'Dependencies' && u.row === 2);
      assert.ok(row, 'expected an unmapped Dependencies row');
      assert.ok(row.errors.some(e => e.includes('ambiguous')), `expected an "ambiguous" error, got: ${JSON.stringify(row.errors)}`);
    });
    check('blank row stops the Todos scan: 1 valid, ghost row after gap not parsed', () => {
      assert.strictEqual(result.tableRows.todos.length, 1);
      assert.strictEqual(result.tableRows.todos[0].title, 'Valid todo before the gap');
    });
    check('blank-row stop produces a warning', () => {
      assert.ok(result.warnings.some(w => w.includes('Todos') && w.includes('blank row')));
    });
    check('total unmapped rows = 4 (title, merge, priority, date)', () => assert.strictEqual(result.unmappedRows.length, 4));
  }

  console.log('\nsample_checklist_old_schema.xlsx (must be rejected before parsing, at Phase 4\'s gate)');
  {
    const read1 = await readSubmissionMeta(read('sample_checklist_old_schema.xlsx'), 'xlsx', 'checklist');
    const differences = diffStructure(read1, PARSER_PROFILE, 'checklist');
    check('missing_sheet: Todos is reported', () => {
      assert.ok(differences.some(d => d.type === 'missing_sheet' && d.sheet === 'Todos'));
    });
    check('schema_version_mismatch is reported (1 vs 2)', () => {
      assert.ok(differences.some(d => d.type === 'schema_version_mismatch' && String(d.found) === '1'));
    });
    check('differences is non-empty (upload would 422, never reach the parser)', () => {
      assert.ok(differences.length > 0);
    });
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
