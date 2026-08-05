// Lightweight test runner, same pattern as test-parser.js. Run with:
//   node fixtures/test-mom-parser.js
// Exercises lib/governance/parseMom.js (content) and readSubmissionMeta.js
// (structure) against the two MoM fixtures, plus mergeSubmissionRows.js's
// pure title-similarity helper (the merge itself needs live Supabase rows,
// so it's covered separately by the Phase 6 live upload verification, not
// here).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseMomWorkbook } = require('../lib/governance/parseMom');
const { readSubmissionMeta, diffStructure } = require('../lib/governance/readSubmissionMeta');
const { normalizeTitle, titleSimilarity } = require('../lib/governance/mergeSubmissionRows');

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
  console.log('sample_mom_valid.md');
  {
    const buf = read('sample_mom_valid.md');
    const meta = await readSubmissionMeta(buf, 'md', 'mom');
    const diffs = diffStructure(meta, PARSER_PROFILE, 'mom');
    check('no structural diffs', () => assert.deepStrictEqual(diffs, []));

    const result = await parseMomWorkbook(buf, PARSER_PROFILE, WIN_CATEGORIES);
    check('2 wins rows (1 matches checklist by key, 1 new)', () => assert.strictEqual(result.tableRows.wins.length, 2));
    check('1 blockers row (matches checklist by title, no jira key on mom side)', () => assert.strictEqual(result.tableRows.blockers.length, 1));
    check('1 dependencies row (matches checklist by key)', () => assert.strictEqual(result.tableRows.dependencies.length, 1));
    check('2 todos rows (1 matches checklist by title, 1 new)', () => assert.strictEqual(result.tableRows.todos.length, 2));
    check('no unmapped rows', () => assert.strictEqual(result.unmappedRows.length, 0));
    check('no warnings', () => assert.strictEqual(result.warnings.length, 0));
    check('win jira_issue_key carried through for the key-matched row', () => assert.strictEqual(result.tableRows.wins[0].jira_issue_key, 'AIRPAY-482'));
    check('blocker row has no jira_issue_key (title-match path)', () => assert.strictEqual(result.tableRows.blockers[0].jira_issue_key, null));
  }

  console.log('sample_mom_duplicate.md');
  {
    const buf = read('sample_mom_duplicate.md');
    const meta = await readSubmissionMeta(buf, 'md', 'mom');
    const diffs = diffStructure(meta, PARSER_PROFILE, 'mom');
    check('no structural diffs', () => assert.deepStrictEqual(diffs, []));

    const result = await parseMomWorkbook(buf, PARSER_PROFILE, WIN_CATEGORIES);
    check('1 wins row (the near-duplicate title)', () => assert.strictEqual(result.tableRows.wins.length, 1));
    check('0 blockers/dependencies/todos rows (sections present but empty)', () => {
      assert.strictEqual(result.tableRows.blockers.length, 0);
      assert.strictEqual(result.tableRows.dependencies.length, 0);
      assert.strictEqual(result.tableRows.todos.length, 0);
    });
  }

  console.log('titleSimilarity threshold (§5.5: 0.8-1.0 = possible duplicate, not merged)');
  {
    const a = normalizeTitle('Payment gateway v2 live');
    const b = normalizeTitle('Payment gateway v2 goes live');
    const score = titleSimilarity(a, b);
    check('checklist vs. duplicate-fixture win title lands in [0.8, 1.0)', () => assert.ok(score >= 0.8 && score < 1, `score was ${score}`));

    const c = normalizeTitle('Sandbox credentials not issued');
    check('identical titles score 1.0', () => assert.strictEqual(titleSimilarity(c, c), 1));

    const d = normalizeTitle('Completely unrelated todo item about something else');
    check('unrelated titles score below 0.8', () => assert.ok(titleSimilarity(c, d) < 0.8));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
