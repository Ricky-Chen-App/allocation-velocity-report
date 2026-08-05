// Phase 6, §5.5: merges checklist- and MoM-sourced rows for one submission
// once BOTH files have been parsed. Runs as a reconciliation pass over
// already-inserted rows (Phase 5 writes checklist rows immediately on
// upload; MoM rows are written the same way) rather than trying to merge
// during parsing itself — simpler, and it means either file can arrive
// first without the parser needing to know about the other.
//
// Rule (§5.5): checklist is the base row (its dropdown-validated structured
// fields always win); MoM only fills in narrative fields the checklist left
// empty. The surviving row is always the checklist one — its id, its
// structured fields — with the matched MoM row deleted once its narrative
// content has been folded in and recorded in analysis.merged[].
const TABLES = ['wins', 'blockers', 'dependencies', 'todos'];

// Which fields MoM is allowed to fill in when the checklist left them empty.
// Everything else on the surviving row is the checklist's own value,
// unconditionally — title/jira_issue_key/dates/enums are all either
// structured or identity fields, never narrative.
const NARRATIVE_FIELDS = {
  wins: ['description', 'impact'],
  blockers: ['bottleneck', 'next_action'],
  dependencies: ['notes'],
  todos: ['notes']
};

function normalizeTitle(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// Dice's coefficient over character bigrams: 1.0 = identical, 0 = nothing in
// common. Simple and dependency-free — good enough for short item titles,
// and the only thing riding on its exact value is where a pair falls
// relative to the 0.8 threshold, not an exact score users ever see.
function titleSimilarity(a, b) {
  if (a === b) return 1;
  const bgA = bigrams(a), bgB = bigrams(b);
  if (!bgA.length || !bgB.length) return 0;
  const counts = new Map();
  for (const g of bgB) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of bgA) {
    const c = counts.get(g);
    if (c > 0) { matches++; counts.set(g, c - 1); }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}

async function mergeTable(supabaseRequest, submissionId, table) {
  const rows = await supabaseRequest('GET', `${table}?submission_id=eq.${submissionId}&select=*`);
  const checklistRows = (rows || []).filter(r => r.source_kind === 'checklist');
  const momRows = (rows || []).filter(r => r.source_kind === 'mom');
  const narrativeFields = NARRATIVE_FIELDS[table] || [];

  const merged = [];
  const possibleDuplicates = [];
  const usedChecklistIds = new Set();

  for (const momRow of momRows) {
    // 1. Exact jira_issue_key match (case-insensitive) — the strongest
    // possible signal, used first when both sides have one.
    let match = null;
    if (momRow.jira_issue_key) {
      match = checklistRows.find(c => !usedChecklistIds.has(c.id) && c.jira_issue_key &&
        c.jira_issue_key.toLowerCase() === momRow.jira_issue_key.toLowerCase());
    }
    // 2. Identical title after normalization (used when either side lacks a
    // jira_issue_key, or the keys didn't match — e.g. the checklist row was
    // never linked to Jira but the wording is exactly the same item).
    if (!match) {
      const momTitle = normalizeTitle(momRow.title);
      if (momTitle) match = checklistRows.find(c => !usedChecklistIds.has(c.id) && normalizeTitle(c.title) === momTitle);
    }

    if (match) {
      usedChecklistIds.add(match.id);
      const overridden = [];
      const patch = {};
      for (const field of narrativeFields) {
        if (!match[field] && momRow[field]) { patch[field] = momRow[field]; overridden.push(field); }
      }
      if (Object.keys(patch).length) {
        await supabaseRequest('PATCH', `${table}?id=eq.${match.id}`, patch, 'return=minimal');
      }
      await supabaseRequest('DELETE', `${table}?id=eq.${momRow.id}`, undefined, 'return=minimal');
      merged.push({
        table, key: momRow.jira_issue_key || normalizeTitle(momRow.title),
        kept_from: 'checklist', dropped_from: 'mom', fields_overridden: overridden
      });
      continue;
    }

    // 3. No exact match — check similarity against whatever checklist rows
    // are still unused. A score in [0.8, 1.0) is a POSSIBLE duplicate:
    // flagged for a human, never auto-merged. Silently merging two items
    // that only sound alike would drop one of them from the report with no
    // way for anyone to notice — the entire reason this tier exists
    // separately from tier 2 above.
    let best = { score: 0, row: null };
    const momTitle = normalizeTitle(momRow.title);
    if (momTitle) {
      for (const c of checklistRows) {
        if (usedChecklistIds.has(c.id)) continue;
        const score = titleSimilarity(momTitle, normalizeTitle(c.title));
        if (score > best.score) best = { score, row: c };
      }
    }
    if (best.row && best.score >= 0.8 && best.score < 1) {
      possibleDuplicates.push({
        table, similarity: Math.round(best.score * 100) / 100,
        checklist: { id: best.row.id, title: best.row.title, jira_issue_key: best.row.jira_issue_key || null },
        mom: { id: momRow.id, title: momRow.title, jira_issue_key: momRow.jira_issue_key || null }
      });
    }
    // else: genuinely distinct from everything on the checklist side — both
    // rows stand on their own, nothing to record.
  }

  return { merged, possibleDuplicates };
}

// Runs the reconciliation for every table of one submission. Call this once
// BOTH a checklist and a MoM file have been parsed for the same submission
// — calling it with only one side present is harmless (no mom/checklist
// rows to pair up) but wasted work.
async function mergeSubmission(supabaseRequest, submissionId) {
  const merged = [];
  const possibleDuplicates = [];
  for (const table of TABLES) {
    const result = await mergeTable(supabaseRequest, submissionId, table);
    merged.push(...result.merged);
    possibleDuplicates.push(...result.possibleDuplicates);
  }

  // Recomputed from the actual post-merge DB state rather than tracked
  // in-memory across two separate parse calls — the DB is the source of
  // truth for what's left after deletions.
  const counts = {};
  for (const table of TABLES) {
    const rows = await supabaseRequest('GET', `${table}?submission_id=eq.${submissionId}&select=id`);
    counts[table] = (rows || []).length;
  }

  return { merged, possibleDuplicates, counts };
}

module.exports = { mergeSubmission, normalizeTitle, titleSimilarity };
