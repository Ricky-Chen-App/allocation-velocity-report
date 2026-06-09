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

## Information architecture

Seven destinations in the sidebar, two groups. **Do not add, remove, rename,
merge, or reorder them.**

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
  Subtasks collapse/expand without leaving the Gantt.

**Admin**
- `members` (Team Members) — members table: group, email, position, level,
  workload; inline edit + bulk save.
- `jirasync` (Jira Sync) — Jira sync status, issue table, sync-status badges.

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
