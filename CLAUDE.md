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

The working reference is a **single self-contained file**, `index.html`:
HTML + CSS + vanilla JS, no build step, deployable to Vercel as-is. Data is a
mock object (`DEVS`, `TASKS`, etc.) standing in for the Jira API.

This is intentional for the prototype phase. When migrating to a real app,
preferred structure:

```
src/
  lib/jira.ts        # Jira REST client + the weight/utilization model
  data/types.ts      # Developer, Task, Sprint, ForecastRow
  styles/tokens.css  # the design tokens below (single source of truth)
  views/             # allocation, board, forecast, timeline, team, sync
  components/        # HeatBar, KpiStrip, StatusChip, SyncBadge, States
```

Keep the single-file version working until the migration reaches parity.

## Run / deploy

- Local: open `index.html` directly, or `npx serve .`
- Deploy: drop on Vercel (static). No env vars needed for the mock build.
- Error-state preview: append `?state=error` to the URL.

## Information architecture

Six destinations, two groups. Do not reintroduce a standalone "Executive" page —
its KPIs live as the strip on top of Allocation.

**Plan**
- `allocation` (home) — KPI strip + capacity board with workload heat-bars,
  rows expand to show each developer's active tasks. Merges the old Executive +
  Developer Capacity + Task Allocation.
- `board` — kanban: To Do / In Progress / In Review / Done, filter by assignee
  and project.
- `forecast` — sprint velocity (last 5), remaining points/hours, completion
  forecast by category, estimated completion date.
- `timeline` — Gantt on a **month-based** time axis (months are the columns;
  show day-level granularity within a month wherever space allows — never a
  week-based axis), grouped per developer or per project. A task that has
  subtasks keeps its own timeline bar **and** can expand inline to reveal its
  subtasks beneath it; expanding subtasks must never hide the parent's bar.
  Subtasks collapse/expand without leaving the Gantt.

**Manage**
- `team` — members table: group, role, level, workload, inline edit.
- `sync` — Jira sync status, issue table, sync-status badges.

## Data model

The shapes the UI expects (mirror these when wiring the real API):

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

## Design system (single source of truth)

Colors are OKLCH. Keep these as CSS variables; don't hardcode hex elsewhere.

```css
/* neutrals — cool, true (never cream/sand/beige) */
--bg:oklch(0.986 0.003 255);  --surface:oklch(1 0 0);
--panel:oklch(0.968 0.005 255); --panel-2:oklch(0.955 0.006 255);
--border:oklch(0.912 0.006 255); --border-strong:oklch(0.852 0.008 255);
--ink:oklch(0.24 0.02 262);   --ink-2:oklch(0.46 0.016 262); --muted:oklch(0.575 0.012 262);

/* committed accent — cobalt; actions, selection, state only. never decoration */
--accent:oklch(0.55 0.17 256); --accent-strong:oklch(0.48 0.18 256);
--accent-weak:oklch(0.95 0.03 256); --accent-ink:oklch(0.42 0.18 256);

/* workload heat scale — semantic, kept distinct from the brand accent */
--w-idle:oklch(0.68 0.018 262); --w-low:oklch(0.62 0.11 245);
--w-healthy:oklch(0.63 0.14 158); --w-over:oklch(0.585 0.2 24);

/* task status */
--st-todo:slate · --st-prog:accent · --st-review:oklch(0.7 0.14 78) · --st-done:oklch(0.62 0.14 158)

--r-card:10px; --r-ctrl:7px; --r-pill:999px;
--ease:cubic-bezier(.22,.61,.36,1);
```

- **Type:** IBM Plex Sans (UI) + IBM Plex Mono (IDs, numbers — tabular figures).
  Base 15px. Fixed rem scale, ratio ~1.125–1.2. Hierarchy via weight, not just
  size. No display fonts in labels/data.
- **Motion:** 140–250ms, ease-out, conveys state only (no decorative motion, no
  page-load choreography). Always honor `prefers-reduced-motion`.
- **Layout:** responsive is structural (sidebar collapses to a drawer under
  840px, tables scroll, board stacks), not fluid typography.

## Component conventions

- Every interactive component ships all states: default, hover, focus, active,
  disabled, loading, error. Don't ship half.
- **Loading = skeletons**, not center spinners. **Empty states teach** the next
  action. **Error states** name the failure, keep stale data labeled, offer
  retry (see the Sync view's "Couldn't reach Jira" pattern).
- One button vocabulary across views (`.btn`, `.btn.primary`, `.btn.ghost`).
  Same status chip, same sync badge, same select everywhere.
- Tables get tabular-nums on numeric columns and right-align them.

## Hard rules / guardrails

- **English throughout.** No English/Indonesian mixing in the UI (this was the
  top consistency bug in the original). Indonesian is fine only in help/tooltip
  prose if ever needed.
- Button labels are verb + object ("Export CSV", "Sync now"), not "OK".
- No em dashes in UI copy. No marketing buzzwords.
- **Banned visual patterns:** side-stripe borders, gradient text, decorative
  glassmorphism, the big-number hero-metric template, identical card grids,
  tiny uppercase tracked eyebrows, numbered section markers as scaffolding.
- Accent color is for action/selection/state — not for filling space.
- Modals are a last resort; prefer inline / progressive disclosure (the
  capacity rows expand inline rather than opening a dialog).
- Don't add a charting dependency lightly — the velocity chart and Gantt are
  hand-built SVG/CSS today and stay dependency-free unless there's a real need.

## Roadmap / open work

1. **Wire the real Jira API** in `lib/jira.ts`; map responses to the data model
   above. Show real "last synced" time; wire the error state to actual failures.
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
