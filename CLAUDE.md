# CLAUDE.md — Resource Portal (Linkit360)

Project context for Claude Code. Read this before editing. It captures what the
product is, who it serves, the design system, and the rules for working here.

## What this is

An internal resource-allocation portal for Linkit360. It reads live data from
Jira (`linkit360.atlassian.net`) and shows, for each developer, how loaded they
are and what they're working on. **The product is allocation-first**: the core
job is answering *who is overloaded, who is free, and what is at risk* at a
glance.

- **Primary user:** PM / team leads doing allocation. Design serves them first.
- **Secondary:** executives (high-level read), developers (their own load).
- **Register:** product UI (a tool in a task), not a marketing site. The tool
  should disappear into the task; earned familiarity beats novelty.

## Current state of the code

Two files do the work, no build step:

- **`server.js`** — Express server. Talks to the live Jira REST API
  (`linkit360.atlassian.net`), owns the weight/utilization model, caching, and
  the JSON endpoints (`/api/timeline`, `/api/timeline-subtasks`, `/api/drilldown`,
  capacity/velocity/members/sync, …). **This is the data layer** — keep it the
  single source of truth for the utilization formula.
- **`public/index.html`** — the entire frontend: HTML + CSS (`:root` design
  tokens) + vanilla JS that fetches the endpoints and renders every view. No
  framework, no bundler.

Data is **live from Jira**, not mock. Env/credentials live in `.env` /
`*.env` files (not committed).

## Run / deploy

- Local: `npm start` (Express serves `public/` and the API on port 3000).
- Deploy: `vercel --prod` (project `allocation-velocity-report`). The repo is on
  GitHub (`Ricky-Chen-App/allocation-velocity-report`); pushes can auto-deploy if
  the Vercel git integration is connected.
- Visual language is **"Momentum"** (see Design system). UI copy is **English**.

## Authentication & permissions

The app is behind a login. Sessions are a stateless signed cookie
(`rp_session`): scrypt password hashing and an HMAC signature, both from
`node:crypto` — **no new dependencies**, and it works on serverless. Users live
in Supabase `app_users` (RLS on, no policies; service-role key server-side
only). Requires `SESSION_SECRET`; without it every API route returns 503.

- Every `/api/*` route needs a valid session except `POST /api/auth/login`.
  The guard re-reads the user per request (memoised 30s), so deactivating an
  account takes effect within 30 seconds rather than at cookie expiry.
- `is_admin` is a single boolean, not a role system. Only admins reach
  `/api/users` and the User Management page; both are enforced server-side.
- An admin cannot deactivate or demote **themselves** — that's what actually
  prevents locking everyone out of the app.
- No DELETE for users (same as `wins`/`blockers`): deactivate via `is_active`.
- Default seeded account is `admin` / `admin` with `must_change_password`
  set, which drives a persistent warning banner. **Change it immediately.**

**Project scoping is display-only — not access control.** `GET /api/projects`
filters to the user's `allowed_project_keys`, which scopes every project
selector at once because `STATE.projects` feeds all of them. But the other
Jira endpoints still compute over every project, so a signed-in user can call
`/api/capacity` or `/api/drilldown?projectKey=…` directly and see everything.
Capacity aggregates are re-derived client-side in `scopeCapacity()` from
`projectAllocations`, and scoped users get a note saying the numbers cover
only their projects — without it, a reduced utilization % reads as that
developer's real workload. Treat this as tidying each person's view, not as
isolating confidential data. If real isolation is ever needed,
`/api/forecast` and `/api/timeline` already accept project filters with
per-filter cache keys — that's the place to start.

## Governance Checklist

Spec: `docs/SPEC_Governance_Checklist.md` (implementation is phased — see the
spec's §10 order; only the phases actually built are described below).
Reference UI: `docs/Governance_Upload_Mockup.html`.

**Status: all 8 phases of the Governance Checklist & MoM Upload spec are
built** — Phase 1 (migration), Phase 2 (Jira project sync + tracking),
Phase 3 (Storage + template downloads), Phase 4 (submission upload +
authorization), Phase 5 (deterministic checklist parser), Phase 6
(MoM-as-Markdown parser + checklist/MoM merge), Phase 7 (Submit page UI),
and Phase 8 (Compliance Board).

Rules that must not be violated in any future phase:
- Compliance color is computed **on read** via SQL `compliance_state()`; never
  stored, never cron'd.
- `wins.category` is a lookup table (`win_categories`) with an FK, not a CHECK
  — chosen so new categories don't need a migration.
- `blocked` is checked **before** `overdue` in `todo_state()` — a to-do
  blocked by someone else and past due is not the PIC's fault.
- `projects.key` is the primary key (not `jira_id`); every FK pointing at it
  carries `ON UPDATE CASCADE`, because Jira project keys do get renamed (see
  the sync rename-detection logic below).
- Project sync (`POST /api/governance/projects/sync`) **never touches
  `is_tracked`** — that's an admin decision. Projects missing from Jira are
  set `is_active = false`, never deleted (submissions/wins/blockers may still
  reference the key).
- Fetch the project list via `/rest/api/3/project/search` (paginated,
  `startAt`), not the plain `/rest/api/3/project` used by `ensureProjects()`
  elsewhere in this file — the old endpoint includes archived projects (174
  rows here vs. the 90 live ones `/project/search` returns) and has no
  `archived` filter.
- **This is a separate concept from `ensureProjects()`/`cache.projects`.**
  That system is a Jira-live, 8-category slice powering the Capacity/
  Timeline/Velocity selectors. Governance's `public.projects` table mirrors
  *all* Jira projects for compliance tracking. They deliberately don't share
  a cache, an endpoint, or a route prefix (`/api/governance/*` vs
  `/api/projects`) — don't merge them.
- `gov-settings` (like `usermgmt`) is admin-only regardless of a user's
  `allowed_nav_ids` — enforced in both `canSeeNav()` and server-side route
  guards, not just by hiding the sidebar button.
- Parser column definitions live in `parser_profiles.sheets` (jsonb), read at
  parse time — never hardcoded as constants. The seeded `default` profile's
  layout (Meta as a row-4–13 key/value block, sheet data starting row 2) was
  derived from the actual `Checklist_AIRPAY_W32_v2.xlsx` template, which
  differs from some of the spec's own prose examples — the template is the
  source of truth when the two disagree.
- Neither blank template ever supplied (`Checklist_Template_v1.xlsx`,
  team-based/superseded; `Checklist_Template_v1-2.xlsx`, project-based but
  missing the Todos sheet and half of Meta) matches `parser_profiles.default`
  (schema_version 2). `lib/governance/buildTemplates.js` generates the
  checklist workbook fresh per request from `parser_profiles.sheets` instead
  of cloning either stale file — a future profile version changes the
  download automatically, with no second place to edit. No
  `MoM_Template_v1.md` was ever supplied either; the MoM `.md` format
  (YAML frontmatter + one Markdown table per sheet, same columns as the
  checklist) is this app's own design, chosen to satisfy §5.5's merge rule
  (checklist wins on structured fields, MoM wins on narrative) — a
  deterministic Markdown-table parser needs the same columns on both sides.
- Checklist `Meta` sheet cell protection has **no real password** — it's a
  fat-finger guard (anyone can click "Unprotect Sheet" in Excel), not a
  security boundary. The actual boundary is server-side: `project_key` from
  an uploaded file is always re-verified against the session's
  `allowed_project_keys`, never trusted from the file or the query string.
- Storage bucket `compliance` is private, RLS-on/no-policies like every other
  table here — access is only ever a server-generated signed URL (TTL 60s,
  `getSignedStorageUrl()`) after an authz check, never a direct object URL.
  Path convention: `compliance/{project_key}/{period_type}/{period_start}/
  {submission_id}__{filename}`.
- **`POST /api/submissions` checks session authorization BEFORE touching the
  uploaded file at all** — a deliberate reordering from the spec's literal
  1-6 layer list (which checks authorization as step 5, after step 4's
  file-content match). Authorization is a near-free lookup against
  `req.user.allowed_project_keys`; doing it first means this server never
  parses a stranger's file. Every single-failure outcome is unchanged (403
  for authz, 422 for a file layer, 409 for a duplicate) — only a request that
  fails both authz and a file layer reports differently (403 instead of
  422). If you touch this route, keep authorization first.
- Row-level content (a bad `priority` value, a malformed date in a data row)
  is **never** validated at upload time — only Meta fields and sheet/column
  *structure*. A row that fails validation becomes the parser's problem
  (`unmapped_rows`, Phase 5/6), never a reason to reject the whole file.
  Structure (missing sheet, wrong header, wrong `schema_version`) still
  rejects with 422, per invariant 10's structure-vs-content split.
- `.xls` (legacy BIFF) uploads are rejected with a clear message, not
  silently accepted. The only maintained Node reader for that format, the
  `xlsx` npm package (SheetJS), currently ships with an **unpatched
  HIGH-severity** prototype-pollution/ReDoS advisory and no fix on the
  public registry — exactly the wrong library to hand attacker-controlled
  uploads to. `.xlsx` is read via `exceljs` (already a dependency). Every
  file this app's own templates produce is `.xlsx`; a real `.xls` reader can
  be revisited later (SheetJS's own CDN ships patched builds) if it's ever
  actually needed.
- No admin UI exists yet to create `compliance_policies` rows, so a
  project's first upload auto-provisions a default policy (weekly, Friday
  17:00 Asia/Jakarta, warn +1/late +3 days) via `ensureDefaultPolicy()`
  rather than requiring one to pre-exist. Revisit once a policy-editing
  endpoint exists — don't let two code paths both try to create policies.
- Re-uploading a `kind` that a period's active submission already has
  **supersedes the whole submission**, not just that one file — if the other
  kind's file was still current, it must be re-uploaded too. This is a
  simpler, more conservative reading of an edge case the spec leaves open
  (§5.4 only describes "new submission supersedes old" and "adding a second
  kind isn't a re-upload," not what happens to an unrelated file when the
  other kind is re-uploaded). Revisit if this proves annoying in practice.
- `submission_events` can only be written once a `submission` row exists
  (its FK is `NOT NULL`) — a request rejected at any of the structural gates
  (1-6, or authz, or the duplicate check) is **not persisted anywhere**,
  including to the audit log. `submission_events`' own stated purpose
  ("siapa mengubah data ini dan kapan") therefore only covers successful
  uploads, not rejected attempts. Flagged, not silently fixed — closing this
  gap means either a nullable FK or a separate attempts table, a schema
  decision beyond Phase 4's scope.
- **The checklist parser (`lib/governance/parseChecklist.js`) runs
  synchronously inside `POST /api/submissions`**, not as an async job — a
  deliberate deviation from the spec's "Edge Function ... async" framing.
  Work started after `res.json()` has no guarantee of completing on Vercel's
  serverless runtime once the invocation ends, which would leave
  `parse_status` stuck at `'pending'` forever with the failure surfaced
  nowhere. A single checklist parses in milliseconds, so blocking the
  response is not a real cost. `state` is unaffected by parse outcome either
  way (invariant 2); only the response's `parse_status` now reports the real
  `'done'`/`'failed'` result instead of always `'pending'`.
- **Row content is validated, but a bad row is never an exception** — a bad
  `priority`, an unparseable date, an unrecognized `win_category`, all
  become one `unmapped_rows[]` entry with a specific error message and the
  row is simply skipped. Only a genuine failure (can't open the workbook,
  a database write fails) sets `parse_status = 'failed'`; that distinction
  is the entire point of invariant 10's structure-vs-content split, and it's
  what makes "one bad cell doesn't kill the upload" true without the parser
  needing any special-case for it.
- **Which columns are dates lives in `parser_profiles.sheets` too** (a
  `dates: [...]` array per sheet, added in the `governance_09` migration) —
  not inferred from a `_date`-suffix naming convention in code. Same reason
  as `enums`/`columns`/`required`: a naming convention embedded in code is
  exactly the kind of structural assumption invariant 11 exists to prevent.
- **Only a native Excel date cell or an exact `YYYY-MM-DD` string is
  accepted for a date column.** A string like `05/08/2026` is genuinely
  ambiguous (5 Aug or Aug 5?) and is rejected with a message saying so, never
  guessed — guessing wrong silently corrupts a real deadline.
- **`wins.category` is validated against `win_categories` live** (`select
  code where is_active`), never against a list in the profile or in code —
  that table becoming a lookup table (see above) is what lets a new category
  get added without touching the parser at all; hardcoding the values
  anywhere in this parser would defeat that.
- **A blank row stops the scan for that sheet** — rows after it are not
  read, per the template's own README instruction
  ("baris kosong di tengah — parser berhenti di situ"). This is deliberate,
  not a bug: verified with a fixture row placed after the gap that must
  never appear in the parsed output.
- **Column order is never assumed** — Phase 4's structural check only
  requires each expected column name to be *present* in a sheet's header
  row, not in a specific position, so the parser resolves columns by name
  from wherever they actually are.
- `wins` gained an `impact` column (`governance_09` migration) — the Wins
  sheet has always had this column (both in `parser_profiles.default` and
  in the real `Checklist_AIRPAY_W32_v2.xlsx` sample), but the table never
  did. Found by cross-checking every sheet column against its target
  table's columns before writing the parser — worth repeating that check if
  a profile's column list ever changes.
- `fixtures/build-fixtures.js` regenerates the three test fixtures
  (`sample_checklist_valid.xlsx`, `_broken.xlsx`, `_old_schema.xlsx`); run
  it again if `parser_profiles.default`'s columns change, and `node
  fixtures/test-parser.js` to check the parser against them. `_old_schema`
  is tested against Phase 4's upload gate, not the parser — it must never
  reach the parser at all, which is the fixture's entire point.

**Phase 6 (MoM parser + merge) rules:**
- **`.docx`/`.pdf` MoM extraction is explicitly out of scope**, a deliberate
  user choice (not a technical limitation) made to avoid adding an LLM
  dependency and API key to this app. Only `.md`/`.txt` are parsed
  deterministically. `.docx`/`.pdf` uploads are still accepted (Phase 4's
  gate already allowed them), stored, and stay `parse_status = 'pending'`
  forever with a `submission_events` note explaining extraction isn't
  available — never silent. Revisit only on an explicit product decision to
  add LLM extraction; don't build a fake/partial `.docx` reader as a
  stopgap.
- **Row-validation logic (`validateSheetRow.js`) and cell-interpretation
  logic (`cellValue.js`) are shared between the xlsx checklist parser and
  the Markdown MoM parser**, extracted out of the original Phase 5
  `parseChecklist.js`. Both formats funnel through the same
  `getCellValue(col) -> validateRow(...)` contract, so a bad `priority` or
  an ambiguous date produces byte-identical error text regardless of which
  file format it came from. Keep it this way — don't let the two parsers'
  validation drift apart.
- **Markdown structural parsing (`markdownTable.js`: frontmatter split,
  `## Heading` section extraction, pipe-table extraction) is shared between
  `readSubmissionMeta.js` (Phase 4's structure-only gate) and `parseMom.js`
  (Phase 6's content parser)**, so the two layers can never disagree about
  where a table starts or ends.
- **Phase 4's MoM structural check was extended, not just reused**: before
  Phase 6, `readSubmissionMeta.js` only checked MoM `Meta`/frontmatter
  fields, never table structure, because the table-extraction logic didn't
  exist yet. `readMomMeta()` now also populates `sheetHeaders` per section
  and `diffStructure()` runs `diffSheetColumns` unconditionally (the
  `kind === 'checklist'` gate was removed) — MoM gets the same
  missing-sheet/missing-column 422 the checklist always had. This was my
  own design decision (not explicitly requested), made because leaving MoM
  permanently less strictly checked than the checklist would be an
  inconsistency with no justification once the capability existed.
- **Merge/dedup (`mergeSubmissionRows.js`), per spec §5.5**: runs as a
  reconciliation pass over already-inserted rows, not during parsing —
  triggered by `finalizeSubmissionParse()` in `server.js` after whichever
  file (checklist or MoM) parses *second* for a submission, once the other
  kind's file is confirmed `parse_status = 'done'` for the same
  `submission_id`. Match tiers, in order: (1) exact `jira_issue_key`
  (case-insensitive), (2) exact title after normalization (lowercase,
  collapsed whitespace, trailing punctuation stripped). On a match, the
  checklist row is always kept — its structured fields win unconditionally
  — and MoM only fills the narrative fields (`NARRATIVE_FIELDS` per table:
  wins.description/impact, blockers.bottleneck/next_action,
  dependencies.notes, todos.notes) the checklist left empty; the matched
  MoM row is then deleted and recorded in `analysis.merged[]`.
- **Similarity 0.8–1.0 (Dice's coefficient over character bigrams,
  `titleSimilarity()`) is a possible-duplicate flag, never an auto-merge** —
  recorded in `analysis.possible_duplicates[]` with both rows' id/title/key,
  and **both rows are left in place**. Silently merging two items that only
  sound alike would drop one from the report with no way for anyone to
  notice; that is the entire reason this tier is kept separate from the
  exact-title tier. Verified live: a win titled "Payment gateway v2 goes
  live" against a checklist win "Payment gateway v2 live" (no shared
  `jira_issue_key`) scored 0.9 and correctly stayed unmerged in
  `possible_duplicates`, with neither row deleted.
- **`submissions.analysis` is extended, not overwritten**, when a
  submission's second file finishes parsing —
  `finalizeSubmissionParse()` reads the prior `analysis`, replaces only
  that file's own `files[]`/`counts_by_source[kind]`/`unmapped_rows`/
  `warnings` contribution (tagged by `source_kind`/a `[kind]` prefix so the
  two files' entries never collide), and only overlays `merged[]` /
  `possible_duplicates[]` / recomputed `counts` once both kinds are
  confirmed present. `parse_method`/`source_format` become `'hybrid'` once
  a second file of the other format has contributed.
- **MoM parsing is synchronous inside `POST /api/submissions`, same
  reasoning as the Phase 5 checklist parser** (invariant above) — Vercel's
  serverless runtime gives no guarantee that work started after
  `res.json()` completes, so blocking the response is what makes
  `parse_status` ever reliably reach `'done'`/`'failed'` instead of getting
  stuck at `'pending'`.
- `fixtures/sample_mom_valid.md` and `fixtures/sample_mom_duplicate.md`
  exercise, respectively, the merge path (rows matched by
  `jira_issue_key` and by exact title, one narrative field actually
  overridden, one left alone because the checklist already had a value,
  and unmatched new rows on both sides surviving untouched) and the
  possible-duplicates path (a near-duplicate win title, no merge). `node
  fixtures/test-mom-parser.js` checks both against the parser and
  structural gate directly; the merge/possible-duplicates behavior itself
  needs live Supabase rows and was verified through a real upload against
  the running server instead (checklist+MoM uploaded together, `analysis`
  and table rows inspected via SQL, then all test rows, storage objects,
  the temporary period, and the temporary test account deleted — confirmed
  by re-querying afterward that no test data remained and that
  pre-existing `wins`/`blockers` rows were untouched).

**Phase 7 (Submit page UI, §9.1/§9.2) rules:**
- **The submissions list is the page's main view; the upload form only
  exists inside a drawer** opened via "Submit report" — per the spec's own
  reasoning, the question people open this page with is "has this week
  already been sent, and by whom," not "how do I upload." Don't move the
  form back inline onto the page.
- **Period is never manually pickable** — step 2 of the drawer only ever
  displays whatever `GET /api/governance/current-period` resolves to for
  the selected project. Letting someone pick a period opens the door to
  submitting against the wrong week with no way to detect it after the
  fact (spec's own words). If a past-period submission is ever needed,
  that's a separate, logged admin action — not a field in this form.
- **`GET /api/governance/current-period`** (new this phase) computes
  "this week" itself via `currentPeriodStart()` — weekly anchors to Monday
  (matching every period this app has ever generated), monthly to the 1st,
  using the same fixed-offset Asia/Jakarta simplification as
  `computeDueAt()` (no IANA timezone dependency). It then calls the
  existing `ensureDefaultPolicy()`/`ensurePeriod()` lazily (same as the
  upload path) and reads `state`/`days_late` from `v_compliance_status`
  rather than recomputing `compliance_state()` logic — that SQL function
  stays the one and only place on-time/late is decided.
- **The drawer's step 3 warns before superseding**, using
  `current-period`'s `existing_files[]`: if the period's active submission
  already has a file of the kind being uploaded, the drawer says so before
  the user submits — because a same-kind re-upload replaces the *whole*
  submission (invariant above), not just that file, and the other kind's
  file (if any) would need re-uploading too.
- **The drawer's step 4 (activity log) is rendered from
  `submission_events` after the upload's `POST /api/submissions` response
  returns** — not streamed progressively during validation, because parsing
  is synchronous end-to-end (Phase 5/6 invariant). At this app's real
  scale (one small file, milliseconds to parse) the entire log appears at
  once, which reads the same to a user as the spec's line-by-line
  description would.
- **Wins/Blockers/Dependencies/Todos extraction results do NOT appear
  anywhere on the Submit page** — per §9.2, that content belongs to the
  Compliance Board (next phase). The Submit page's own detail view (the
  "Detail" button on each list row, reusing the same drawer in a read-only
  mode) only ever shows the activity log, matching what a submitter
  actually needs to know: was the file accepted, and what happened.
- The searchable-combobox component (`AP_COMBO`, Phase 2's Wins/Blockers
  task picker) is reused as-is for the drawer's project select
  (`sub-project`) — no new combobox implementation. Its `onPick(id, value,
  opt)` callback signature is 3 args, not a single option object; get this
  wrong and project selection silently no-ops.
- `GET /api/governance/projects?tracked=true` (already built in Phase 2)
  is the exact source for the drawer's project list — already scoped to
  `is_tracked ∩ allowed_project_keys` server-side, so the frontend does
  no additional filtering. A project with `is_tracked = false` simply
  never appears as a submit target, by design (that's what "tracked"
  means) — this bit a live-verification pass in this phase, since AIRPAY
  itself wasn't tracked at the time.

**Phase 8 (Compliance Board, §9.3) rules:**
- **`GET /api/compliance` backfills every expected period in the requested
  range before reading `v_compliance_status`** — `periodStartsBack()`
  generates the Monday-anchored run of weeks (or month-starts) ending at
  "now", and `ensurePeriod()` runs for every (tracked project × week) pair.
  Without this, a week nobody has visited Submit or this board for yet has
  no `compliance_periods` row at all, and the grid would render that week
  as a gap instead of the red cell it actually is — the whole point of a
  compliance board is to surface exactly that kind of miss.
- **Color is never the only signal on a grid cell** — every cell carries
  an icon+text label (✓/·/!/✕) alongside its background color, per the
  spec's explicit accessibility requirement. Don't add a cell variant that
  relies on color alone.
- **Cells show each week's own state — never an averaged color.** The
  spec calls this out directly: averaging several weeks into one color
  hides exactly the problem week a PM needs to see. The per-project "on
  time" ratio (e.g. "5/6") is a separate summary column, not a replacement
  for the per-week cells.
- **The on-time ratio excludes `pending` periods from its denominator** —
  a week that isn't due yet isn't a miss, and counting it would understate
  a project's actual on-time rate for the weeks it's had a real chance to
  submit.
- **The top KPI's team green/orange/red counts are judged on the current
  week only** (the grid's last column), worst-state-wins across a team's
  projects (red beats orange beats green). `pending` is folded into
  "green" for this specific summary — not submitting yet isn't a
  compliance failure, and a separate 4th bucket would just be visual noise
  for a state that isn't actually bad. This is a judgment call I made
  explicitly rather than something the spec pins down — revisit if a
  "not yet due" bucket turns out to matter to whoever reads this board.
- **Wins/blockers/dependencies/todos content is only ever shown from the
  Compliance Board's current-week detail panel** (`boardOpenDetail()`,
  reusing `GET /api/submissions/:id`) — never on the Submit page (Phase 7
  invariant, same spec section). Keeping this in exactly one place is what
  prevents the two pages' displayed content from silently diverging.
- `GET /api/compliance`'s bulk-counts pass (wins/open-blockers/open-deps
  per submission) is a single batched query per table across every
  submission in the requested range, not N+1 per grid cell — the range is
  always small (recent weeks × tracked projects only), so this stays cheap
  without needing real SQL aggregation through PostgREST.

## Information architecture

Fifteen destinations in the sidebar, five groups. **Do not add, remove,
rename, merge, or reorder them** without an explicit product decision (the
Report AirPay group, User Management, and the Governance group were each such
a deliberate addition — see their notes). Sidebar groups hide themselves when
every button inside is hidden. Resolve nav buttons with `navBtn('<id>')`,
never by positional index into `.nav-item`.

**Dashboards**
- `executive` (home) — KPI strip, team-utilization gauge, utilization-by-group,
  action items, critical overloads, AI summary.
- `capacity` (Developer Capacity) — per-developer workload heat-bars; rows
  expand inline to a project drill-down (epics → tasks → subtasks).
- `velocity` (Velocity & Forecast) — sprint velocity (last 5), remaining
  points/hours, completion forecast by category, estimated completion date.
- `tasks` (Task Allocation) — live tasks per developer from Jira.
- `timeline` — Gantt on a **month-based** time axis (months are the columns;
  show day-level granularity within a month wherever space allows — never a
  week-based axis), grouped per developer or per project. A task that has
  subtasks keeps its own timeline bar **and** can expand inline to reveal its
  subtasks beneath it; expanding subtasks must never hide the parent's bar.
  Subtasks collapse/expand without leaving the Gantt. Rows also carry a teal
  "Plan" bar (Target start/end, falling back to Start/Due date when unset)
  above the "Actual" bar, with red delay styling past Plan end.

**Admin**
- `members` (Team Members) — members table: group, email, position, level,
  workload; inline edit + bulk save.
- `jirasync` (Jira Sync) — Jira sync status, issue table, sync-status badges.
- `usermgmt` (User Management) — **admin only.** Register users (username,
  email, password), set Active/Inactive, and pick the projects they can see,
  grouped by Jira project category with a select-all per category. Menu
  access sits in a collapsed section, defaulting to everything, so the
  common case stays short. Shows last login with the device it came from
  (parsed from User-Agent — a convenience signal, spoofable, never evidence).

**Org Design**
- `orgchart` (Structure Organization) — draw.io-style canvas mapping
  categories → projects → people.
- `projectteam` (Structure Project Team) — same canvas pattern, connects a
  person to the project(s) they work on.

**Report AirPay** — added for a Google-Sheet-backed report, deliberately
**independent of Jira** (own `AIRPAY` client state, own `/api/airpay-sheet`
route, own `lib/airpay/parseSheet.js` parser — never touches `STATE`/`TL`/
`CAP` or any Jira-derived object). Reuses the app's existing tokens/components
(`.card`, `.kpi-card`, `.btn`, `.error-banner`, `.pill`) — no separate theme.
- `airpay-summary` (Summary Report) — executive one-pager: overall-% donut,
  derived KPI cards, hand-curated Wins/Blockers/Decision-Required panels
  (Supabase; see Authentication section), and a day-based Gantt (by
  DCB/Digital Payment/Platform category) with a click-through detail drawer.
  Blockers filter by status (Active is the default; Open / In Progress /
  Resolved / All are selectable, with counts) **and** priority — Resolved
  entries are hidden from the working list but never lost. The task and PIC
  pickers use `apCombo*`, a searchable ARIA combobox: a native `<select>` is
  unusable at 140+ Jira issues. It patches only its own subtree, because
  re-rendering the page per keystroke would destroy the input's focus.
- `airpay-detail` (Detail Report) — daily-standup task board for in-progress
  items, sortable by Priority or PIC, with urgency badges, a local-only
  "discussed" checkbox (`localStorage`, no backend — there's no per-user
  preference store to sync it to), and a print stylesheet.

Both AirPay pages poll `GET /api/airpay-sheet` every `AIRPAY_POLL_MS` (45s)
while either is open, show a Live/Syncing/Failed sync dot, and keep
rendering the last-known-good data (with a dismissable error banner) if a
poll fails — the sheet is never allowed to blank the page. The sheet's own
gid (as shared) does not resolve via Google's gid-based CSV export; the
route fetches by **tab name** (`Detail Progress`) via the gviz endpoint
instead — keep that in mind if the sheet is ever restructured.

**Governance** — weekly/monthly compliance tracking, backed by its own
Supabase tables (`projects`, `teams`, `submissions`, `todos`, `dependencies`,
...; see the Governance Checklist section above). Independent of AirPay's
Supabase tables and of `ensureProjects()`'s Jira-live project cache.
- `gov-submit` (Submit) — a list of past submissions is the main view
  (project, period, kind, file, uploader, time, status), not a form; the
  4-step upload form (project → read-only period → Checklist/MoM upload →
  activity log) lives in a drawer opened via "Submit report". Never shows
  wins/blockers/dependencies content — that lives on the Compliance Board
  only (§9.2's own split). A "Detail" button reopens the drawer read-only
  to show just the activity log for a past submission.
- `gov-board` (Compliance Board) — KPI summary (green/orange/red team
  counts for the current week, total open blockers/dependencies) + a grid
  (project rows grouped by team, week columns, each cell an icon+color per
  invariant below, plus an "on time" ratio column) + a current-week detail
  panel per project with a "Detail" button that's the one place extraction
  results (wins/blockers/dependencies/todos) are actually read. Backed by
  `GET /api/compliance`, which backfills every expected period in range
  (not just ones somebody happened to visit) before reading
  `v_compliance_status`, so a project that missed 3 weeks shows 3 red
  cells, not 3 blank ones.
- `gov-settings` (Settings) — **admin only.** The 90-project mirror synced
  from Jira via "Sync from Jira"; toggle which projects are `is_tracked` (and
  their `tracked_from` start date) for compliance. Search, tracked/untracked
  filter, team filter (empty until Governance seeds/creates teams — a later
  phase), show-inactive toggle. Sync never touches `is_tracked` and detects
  Jira project-key renames via `jira_id` rather than treating a rename as a
  delete + create.

## Data model

Conceptual shapes (the **authoritative** field names live in `server.js`'s
endpoint responses — check there before relying on a key):

- **Developer** `{ id, name, init, group, role, level, email, util, sync }`
  - `util` is a percentage. `group` ∈ teams. `role` ∈ CTO/PM/BA/QA/Dev.
- **Task** `{ key, sum, pj, dev, st, pts, pri, size }`
  - `st` ∈ `todo|prog|review|done`. `pri` ∈ `High|Med|Low`.
  - `size` ∈ `Small|Standard|Large|Epic` (drives the weight below).
- **External / Unassigned** tasks are tracked separately and **do not** count
  toward utilization.
- **Sprint** `{ n, done, plan }` · **ForecastRow** `{ cat, issues, pts, hrs, days }`

### Utilization model (do not change without product sign-off)

```
weight by size:  Small ≤2d → 0.5 · Standard 3–5d → 1.0 · Large 6–10d → 2.0 · Epic >10d → 3.0
Utilization% = Σ(weight × active days) ÷ (4 tasks/day × working days) × 100
```

Surface this only via the "ⓘ How utilization is calculated" popover, never as
inline page chrome.

### Workload bands (the heat scale)

| Band | Range | Token |
|------|-------|-------|
| Overloaded | > 100% | `--w-over` |
| Healthy | 70–100% | `--w-healthy` |
| Low | 30–70% | `--w-low` |
| Idle | < 30% | `--w-idle` |

The heat-bar is the signature element. Fill is capped visually at 100% with a
fixed cap-line; rows sort overloaded-first.

## Design system — "Momentum" (single source of truth)

Colors are OKLCH, defined once in the `:root` of `public/index.html`. Reference
the variables; **don't hardcode hex/oklch in components.** The token *names* in
the code are the legacy ramps (`--ink-*`, `--blue-*`, `--green-*`, …); their
*values* carry the Momentum palette below.

```css
/* warm canvas + atmosphere (two radial glows on the app background) */
--bg:oklch(0.984 0.012 75);  --surface(--ink-0):oklch(0.995 0.004 75);
--surface-2(--ink-50):oklch(0.975 0.01 75);  --border(--ink-100):oklch(0.90 0.012 70);
--ink(--ink-800):oklch(0.26 0.03 290);  --muted(--ink-400):oklch(0.60 0.02 290);

/* deep plum-charcoal sidebar (dark surface, light text) */
--side:oklch(0.23 0.04 295); --side-2:oklch(0.28 0.045 295);
--side-ink:oklch(0.92 0.02 290); --side-muted:oklch(0.68 0.03 290);

/* primary accent — energetic indigo → violet gradient (--blue-* ramp) */
--accent:oklch(0.55 0.19 278); --accent-2:oklch(0.62 0.2 300);

/* data + workload heat scale (idle → over) */
--coral/--w-over:oklch(0.62-0.68 ~0.2 30); --amber:oklch(0.8 0.15 78);
--teal:oklch(0.72 0.12 195); --w-healthy/green:oklch(0.72 0.16 150);
--w-low:teal · --w-idle:oklch(0.72 0.045 235)

--radius-sm:9px; --radius-md:11px; --radius-lg:16px; --radius-xl:20px; --r-pill:999px;
--ease:cubic-bezier(.22,.7,.3,1);
```

- **Type:** **Bricolage Grotesque** (display: headings + big numbers, 600–800,
  `letter-spacing:-.02em`), **Hanken Grotesk** (body/UI), **JetBrains Mono**
  (IDs, metrics, tabular figures). Hierarchy via weight + the display face on
  headline numbers.
- **Motion:** 150–250ms, `--ease`. Tasteful only — hover lifts, gauge sweep,
  bar grow, one staggered rise on mount. Always honor `prefers-reduced-motion`
  (there is a global reduce block).
- **Atmosphere:** the app shell is warm canvas + two faint radial glows
  (violet top-right, coral top-left), not flat white.
- **Layout:** responsive is structural (sidebar → drawer under 840px, tables
  scroll), not fluid typography.

## Component conventions

- Every interactive component ships all states: default, hover, focus, active,
  disabled, loading, error. Don't ship half.
- **Loading = skeletons**, not center spinners. **Empty states teach** the next
  action. **Error states** name the failure, keep stale data labeled, offer
  retry (see the Sync view's "Couldn't reach Jira" pattern).
- One button vocabulary across views (`.btn`, `.btn-primary`, `.btn-ghost`).
  Same status chip, same sync badge, same select everywhere.
- Tables get tabular-nums on numeric columns and right-align them.

**Momentum component direction:**
- **Sidebar:** deep plum gradient, light text, each nav icon in a rounded-square
  tinted badge; active item = indigo→violet gradient pill with soft glow.
- **Topbar:** translucent blurred bar; gradient primary buttons (pill,
  weight 700) that lift 1px on hover.
- **Cards/KPIs:** rounded (`--radius-lg`), layered shadow, tinted icon badge,
  Bricolage value. Gauges use a gradient value arc with rounded cap.
- **Chips/badges/avatars:** pill chips by semantic colour; avatars are accent
  gradient circles.

## Hard rules / guardrails

- **English throughout.** No English/Indonesian mixing in the UI. Jira data
  values (project/group/person names) stay as-is — don't translate data.
- Button labels are verb + object ("Export CSV", "Sync now"), not "OK".
- No marketing buzzwords.
- **Momentum allows** gradients (nav pill, primary buttons, avatars, gauge
  arcs), a translucent blurred topbar, and a hero gauge for the headline
  metric — these are intentional, not banned. Keep gradients on surfaces, **not
  on body text** (no gradient text). Don't invent new shadow/gradient values
  outside the tokens.
- Accent gradient signals the primary action / current selection (active nav,
  primary button) and brand surfaces (avatars); keep it purposeful, not noise.
- Modals are a last resort; prefer inline / progressive disclosure (the
  capacity rows expand inline rather than opening a dialog).
- Don't add a charting dependency lightly — the velocity chart and Gantt are
  hand-built SVG/CSS today and stay dependency-free unless there's a real need.

## Roadmap / open work

1. **Jira API is wired** (`server.js`, live data). Remaining: harden error
   states for real API failures and surface accurate "last synced" everywhere.
2. **Deepen Forecast and Timeline** — they're the lightest views right now.
   For Timeline specifically: keep the axis month-based (add day ticks inside a
   month when there's room), and keep parent task bars visible while their
   subtasks expand/collapse inline.
3. **Team inline editing** — make role/level edits persist (currently demo).
4. Search in the top bar is a placeholder; make it filter people/tasks/keys.
5. Once the browser tooling is available, run `/impeccable critique` for the
   full 40-point score and `/impeccable audit` for a11y/perf.

## When you edit

- Touch tokens in one place; never hardcode a color that has a variable.
- Match the existing component vocabulary before inventing a new one.
- Test every change at desktop, tablet (~840px), and mobile (~640px).
- Verify body text hits ≥4.5:1 contrast; muted gray is for non-essential text
  only.
