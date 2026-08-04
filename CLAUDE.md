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

**Status: Phase 1 (migration), Phase 2 (Jira project sync + tracking), and
Phase 3 (Storage + template downloads) are built.** Upload, parsing, Submit
UI, and Compliance Board are not — those are later phases.

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
  {filename}` (established in Phase 3; not yet exercised — Phase 4 is what
  actually writes submission files there).

## Information architecture

Fourteen destinations in the sidebar, five groups. **Do not add, remove,
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
- `gov-settings` (Settings) — **admin only.** The 90-project mirror synced
  from Jira via "Sync from Jira"; toggle which projects are `is_tracked` (and
  their `tracked_from` start date) for compliance. Search, tracked/untracked
  filter, team filter (empty until Governance seeds/creates teams — a later
  phase), show-inactive toggle. Sync never touches `is_tracked` and detects
  Jira project-key renames via `jira_id` rather than treating a rename as a
  delete + create.
- `Submit` and `Compliance Board` are specced but not yet built.

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
