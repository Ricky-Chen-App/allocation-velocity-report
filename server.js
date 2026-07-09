const path = require('path');
// Load .env relative to this file so it works no matter the cwd
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const forecastConfig = require('./forecastConfig');
const { getEffectiveDates, classifyLoad, LOAD_STATUS_LABEL, DEFAULT_FIELD_IDS, val, PARAMS } = forecastConfig;
const { businessDaysBetween, addBusinessDays, toIso } = require('./businessDays');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Always revalidate HTML so a new deploy is picked up without a hard refresh
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// Running on Vercel (or any serverless) — read-only FS, no persistent process
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Fail fast with a clear message if Jira env vars are missing (common deploy mistake)
const MISSING_ENV = ['JIRA_DOMAIN', 'JIRA_EMAIL', 'JIRA_TOKEN'].filter(k => !process.env[k]);
if (MISSING_ENV.length) {
  console.error(`✗ Missing required environment variables: ${MISSING_ENV.join(', ')}`);
}

const JIRA_BASE = (process.env.JIRA_DOMAIN || '').replace(/\/$/, '');
const AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_TOKEN || ''}`).toString('base64');
const HEADERS = {
  'Authorization': `Basic ${AUTH}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

// Guard: every API route returns a clear 500 if env vars are missing,
// instead of crashing the whole serverless function.
app.use('/api', (req, res, next) => {
  if (MISSING_ENV.length) {
    return res.status(500).json({
      error: `Server belum dikonfigurasi: environment variable hilang (${MISSING_ENV.join(', ')}). ` +
             `Set di Vercel → Project Settings → Environment Variables.`
    });
  }
  next();
});

// Target project categories — EXACT names (case-insensitive).
// Jira renames (per 2026): "Product"→"Product OTT", "Project OTT"→"Project". + RnD.
// "Team Product" sengaja TIDAK disertakan.
const TARGET_CATEGORIES = ['VAS Project', 'Product OTT', 'Project', 'Platform Internal', 'QA', 'RnD', 'Pre Sales', 'Surat Sakit & Cepat Sehat'];

// Target user groups
const TARGET_GROUPS = [
  'PMO Team',
  'AI Specialist',
  'Cehat Sehat Developer',
  'Data Analyst',
  'Developer',
  'Lumos Developer',
  'Matainja Developer',
  'PPOB Developer',
  'Waki Developer'
];

// Simple in-memory cache
const cache = { projects: null, members: null, capacity: null, forecast: null, timeline: {}, ts: {} };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function isFresh(key) {
  return cache.ts[key] && Date.now() - cache.ts[key] < CACHE_TTL;
}

// Tasks with status "Dropped"/"Cancelled" are ignored everywhere (not fetched into any view/calc)
function isDropped(status) {
  return /drop|cancel/i.test(status || '');
}

// Single source of truth for "done" across the app. Substring match (not exact
// equality) so variant Jira status names like "Done Production" count as done —
// matches the client's displayStatus() bucketing, which already treats them as
// Done (green bar) while the old exact-match list silently left them at 0%.
function isDoneStatus(status) {
  return /done|closed|resolved|complete|production/i.test(status || '');
}

async function jiraGet(path) {
  const res = await fetch(`${JIRA_BASE}${path}`, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Paginate /rest/api/3/search/jql via TOKEN-based pagination (nextPageToken).
// The new endpoint ignores startAt and has no `total`, so we must follow tokens.
async function jiraSearchAll(jql, fields, cap = 5000) {
  let all = [], token = null, guard = 0;
  while (all.length < cap && guard++ < 100) {
    const params = new URLSearchParams({ jql, maxResults: '1000', fields });
    if (token) params.set('nextPageToken', token);
    const data = await jiraGet(`/rest/api/3/search/jql?${params.toString()}`);
    const issues = data.issues || [];
    all = all.concat(issues);
    if (data.isLast || !data.nextPageToken || !issues.length) break;
    token = data.nextPageToken;
  }
  return all;
}

// ——— Shared cache loaders (work in both server & serverless) ———
// These populate the cache directly via Jira API, replacing localhost self-fetch
// which does not work on serverless platforms.
async function ensureProjects() {
  if (isFresh('projects') && cache.projects) return cache.projects;
  const cats = await jiraGet('/rest/api/3/projectCategory');
  const targetCatIds = cats
    .filter(c => TARGET_CATEGORIES.some(t => c.name.toLowerCase().trim() === t.toLowerCase().trim()))
    .map(c => ({ id: c.id, name: c.name }));
  const allProjects = await jiraGet('/rest/api/3/project?expand=projectKeys,description&maxResults=500');
  const filtered = allProjects.filter(p => p.projectCategory && targetCatIds.some(c => c.id === p.projectCategory.id));
  cache.projects = {
    categories: targetCatIds,
    projects: filtered.map(p => ({
      id: p.id, key: p.key, name: p.name,
      category: p.projectCategory?.name || 'Uncategorized',
      avatarUrl: p.avatarUrls?.['24x24']
    }))
  };
  cache.ts['projects'] = Date.now();
  return cache.projects;
}

async function ensureMembers() {
  if (isFresh('members') && cache.members) return cache.members;
  const membersMap = {};
  for (const group of TARGET_GROUPS) {
    try {
      const encoded = encodeURIComponent(group);
      let startAt = 0;
      while (true) {
        const data = await jiraGet(`/rest/api/3/group/member?groupname=${encoded}&startAt=${startAt}&maxResults=50`);
        for (const u of data.values || []) {
          if (!membersMap[u.accountId]) {
            membersMap[u.accountId] = {
              accountId: u.accountId, displayName: u.displayName,
              emailAddress: u.emailAddress, avatarUrl: u.avatarUrls?.['24x24'], groups: []
            };
          }
          membersMap[u.accountId].groups.push(group);
        }
        if (data.isLast || !data.values?.length) break;
        startAt += 50;
      }
    } catch (e) { console.warn(`Group "${group}" error:`, e.message); }
  }
  cache.members = Object.values(membersMap);
  cache.ts['members'] = Date.now();
  return cache.members;
}

// Resolve the "Start date" / "New Start Date" / "New Due Date" custom field
// IDs by NAME against Jira's live field schema (/rest/api/3/field), instead
// of trusting hardcoded customfield_XXXXX IDs forever — Jira admins can and
// do recreate fields with new IDs. Falls back to the last-verified IDs
// (forecastConfig.DEFAULT_FIELD_IDS, checked 2026-07-09) if the lookup fails
// or a name isn't found, logging a warning so a silent drift doesn't go
// unnoticed. Resolved once per process and cached like everything else.
let dateFieldIds = null;
async function ensureDateFieldIds() {
  if (dateFieldIds) return dateFieldIds;
  const fallback = DEFAULT_FIELD_IDS;
  try {
    const allFields = await jiraGet('/rest/api/3/field');
    const byName = name => allFields.find(f => (f.name || '').toLowerCase() === name.toLowerCase());
    const startField = byName('Start date');
    const newStartField = byName('New Start Date');
    const newDueField = byName('New Due Date');
    if (!startField) console.warn(`ensureDateFieldIds: "Start date" not found by name, falling back to ${fallback.start}`);
    if (!newStartField) console.warn(`ensureDateFieldIds: "New Start Date" not found by name, falling back to ${fallback.newStart}`);
    if (!newDueField) console.warn(`ensureDateFieldIds: "New Due Date" not found by name, falling back to ${fallback.newDue}`);
    dateFieldIds = {
      start: startField?.id || fallback.start,
      newStart: newStartField?.id || fallback.newStart,
      due: fallback.due, // 'duedate' is a system field — not listed by a friendly name in /field
      newDue: newDueField?.id || fallback.newDue
    };
  } catch (e) {
    console.warn('ensureDateFieldIds: schema lookup failed, using fallback IDs:', e.message);
    dateFieldIds = { ...fallback };
  }
  return dateFieldIds;
}

// ——— GET /api/projects ———
app.get('/api/projects', async (req, res) => {
  try {
    const result = await ensureProjects();
    res.json(result);
  } catch (e) {
    console.error('projects error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— GET /api/members ———
app.get('/api/members', async (req, res) => {
  try {
    const result = await ensureMembers();
    res.json(result);
  } catch (e) {
    console.error('members error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— Force a full re-sync from Jira (clear all server caches) ———
app.get('/api/refresh', (req, res) => {
  cache.projects = null;
  cache.members  = null;
  cache.capacity = null;
  cache.capacitySprint = null;
  cache.forecast = null;
  cache.forecastByFilter = {};
  cache.timeline = {};
  cache.ts = {};
  console.log('↻ Cache cleared — next requests re-fetch fresh from Jira');
  res.json({ ok: true, clearedAt: new Date().toISOString() });
});

// ——— Capacity computation (shared by endpoint + warmup) ———
async function computeCapacity() {
  if (isFresh('capacity') && cache.capacity) return cache.capacity;

  // Ensure projects + members cache (direct loaders — serverless-safe)
  await Promise.all([ensureProjects(), ensureMembers()]);

  const members = cache.members || [];
  const projects = cache.projects?.projects || [];

  if (!members.length || !projects.length) {
    return { developers: [], period: getCurrentPeriod() };
  }

  {
    const projectKeys = projects.map(p => p.key);
    const memberIds = members.map(m => m.accountId);

    // Get current month date range
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    const workingDays = getWorkingDays(startOfMonth, endOfMonth);

    const BASE_CAPACITY = 4 * workingDays; // 4 tasks/day × working days

    // JQL: issues assigned to our members in our projects, active this month
    // No slice cap here — Jira's JQL "IN" clause has no ~50-item limit; a cap
    // silently dropped whole projects/members once counts grew past it.
    const jql = `project in (${projectKeys.map(k => `"${k}"`).join(',')}) AND assignee in (${memberIds.map(id => `"${id}"`).join(',')}) AND (status != Done OR updated >= "${startOfMonth}") ORDER BY updated DESC`;
    const allIssues = await jiraSearchAll(jql, 'assignee,summary,status,priority,customfield_10016,timeoriginalestimate,timeestimate,timespent,created,resolutiondate,updated,project,issuetype', 5000);

    // Group issues by assignee
    const issuesByAssignee = {};
    for (const issue of allIssues) {
      const aid = issue.fields.assignee?.accountId;
      if (!aid) continue;
      if (isDropped(issue.fields.status?.name)) continue; // ignore Dropped entirely
      if (!issuesByAssignee[aid]) issuesByAssignee[aid] = [];
      issuesByAssignee[aid].push(issue);
    }

    // Build developer capacity rows
    const developers = members.map(member => {
      const issues = issuesByAssignee[member.accountId] || [];

      let weightedLoad = 0;
      const projectMap = {};

      for (const issue of issues) {
        // Utilization counts only tasks ACTIVELY consuming capacity (In Progress, Delay, ...).
        // Excluded (still DISPLAYED, but not counted): Done, To Do, On Hold/Blocked, Waiting telco.
        const k = (issue.fields.status?.name || '').toLowerCase().trim();
        const isDone    = /done|closed|resolved|complete|production/.test(k);
        const isTodo    = /to ?do|todo|backlog/.test(k) || k === 'open' || k === 'new';
        const isBlocked = /on ?hold|hold|block|waiting|telco|pending/.test(k);
        if (isDone || isTodo || isBlocked) continue;

        const weight = getIssueWeight(issue);
        const activeDays = getActiveDays(issue, startOfMonth, endOfMonth, workingDays);
        const contribution = weight * activeDays;
        weightedLoad += contribution;

        const projKey = issue.fields.project?.key;
        const projName = issue.fields.project?.name;
        if (projKey) {
          if (!projectMap[projKey]) projectMap[projKey] = { key: projKey, name: projName, load: 0, count: 0 };
          projectMap[projKey].load += contribution;
          projectMap[projKey].count++;
        }
      }

      const utilization = BASE_CAPACITY > 0 ? Math.round((weightedLoad / BASE_CAPACITY) * 100) : 0;
      const available = Math.max(0, 100 - utilization);
      const overload = utilization > 100 ? utilization - 100 : 0;

      // Determine primary group (first group in target order)
      const groupOrder = TARGET_GROUPS;
      const primaryGroup = groupOrder.find(g => member.groups.includes(g)) || member.groups[0] || 'Unknown';

      const projectAllocations = Object.values(projectMap).map(p => ({
        key: p.key,
        name: p.name,
        pct: BASE_CAPACITY > 0 ? Math.round((p.load / BASE_CAPACITY) * 100) : 0,
        count: p.count
      })).sort((a, b) => b.pct - a.pct).slice(0, 20); // keep more so overflow/modal works

      return {
        accountId: member.accountId,
        displayName: member.displayName,
        emailAddress: member.emailAddress,
        avatarUrl: member.avatarUrl,
        group: primaryGroup,
        groups: member.groups,
        utilization,
        available,
        overload,
        taskCount: issues.length,
        activeTaskCount: issues.filter(i => !isDoneStatus(i.fields.status?.name)).length,
        projectAllocations,
        status: utilization > 100 ? 'overload' : utilization >= 80 ? 'high' : utilization >= 30 ? 'ok' : 'idle'
      };
    });

    const result = {
      developers: developers.sort((a, b) => b.utilization - a.utilization),
      period: { start: startOfMonth, end: endOfMonth, workingDays },
      summary: buildSummary(developers)
    };

    // Cache capacity result
    cache.capacity = result;
    cache.ts['capacity'] = Date.now();

    return result;
  }
}

// ——— Sprint Active capacity ———
// Period = active sprint window. Per-task load spreads the weight across the
// task's own span (start→due), using new start/due when the task is overdue/Delay.
// load(task) = weight ÷ span × active ;  util% = Σload ÷ sprintWorkingDays × 100
async function computeCapacitySprint() {
  if (isFresh('capacitySprint') && cache.capacitySprint) return cache.capacitySprint;
  await Promise.all([ensureProjects(), ensureMembers()]);
  const members = cache.members || [];
  const projects = cache.projects?.projects || [];
  if (!members.length || !projects.length) return { developers: [], period: getCurrentPeriod(), mode: 'sprint' };

  const projectKeys = projects.map(p => p.key);
  const memberIds = members.map(m => m.accountId);
  const today = new Date(); today.setHours(0,0,0,0);
  const isoOf = s => String(s).split('T')[0];

  // 1) active sprint windows across the projects' boards → union window
  const wins = [];
  try {
    const boardData = await jiraGet(`/rest/agile/1.0/board?maxResults=50`);
    const boards = boardData.values || [];
    // Scan ALL boards (parallel) for their active sprint(s)
    const perBoard = await Promise.all(boards.map(async b => {
      try { const s = await jiraGet(`/rest/agile/1.0/board/${b.id}/sprint?state=active&maxResults=10`); return s.values || []; }
      catch (e) { return []; }
    }));
    for (const arr of perBoard) for (const sp of arr) if (sp.startDate && sp.endDate) wins.push({ start: isoOf(sp.startDate), end: isoOf(sp.endDate) });
  } catch (e) { /* no agile */ }

  // Keep real current sprints: normal length (≤45d) and recent — includes sprints
  // that just ended but aren't closed yet. Drops stale sprints left open for years.
  const lenDays = w => (new Date(w.end) - new Date(w.start)) / 86400000;
  const recentCut = isoOf(new Date(today.getTime() - 21 * 86400000).toISOString());
  const use = wins.filter(w => lenDays(w) <= 45 && w.end >= recentCut);

  const scope = `project in (${projectKeys.map(k => `"${k}"`).join(',')}) AND assignee in (${memberIds.map(id => `"${id}"`).join(',')})`;
  const fields = 'assignee,summary,status,priority,customfield_10016,timeoriginalestimate,duedate,customfield_10015,customfield_10578,customfield_10049,customfield_10062,resolutiondate,project,issuetype';

  let winStart, winEnd, source, jql;
  if (use.length) {
    source = 'sprint';
    winStart = use.map(w => w.start).sort()[0];
    winEnd   = use.map(w => w.end).sort().slice(-1)[0];
    jql = `${scope} AND sprint in openSprints() ORDER BY updated DESC`;
  } else {
    // No active sprint at all → fall back to In Progress tasks over current month
    source = 'inprogress';
    winStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    winEnd   = new Date(today.getFullYear(), today.getMonth()+1, 0).toISOString().split('T')[0];
    jql = `${scope} AND statusCategory = "In Progress" ORDER BY updated DESC`;
  }
  const activeSprintCount = use.length;

  let issues = [];
  try { issues = await jiraSearchAll(jql, fields, 5000); }
  catch (e) { console.warn('Sprint capacity JQL error:', e.message); }

  const byA = {};
  for (const it of issues) {
    const aid = it.fields.assignee?.accountId; if (!aid) continue;
    if (isDropped(it.fields.status?.name)) continue;
    (byA[aid] = byA[aid] || []).push(it);
  }

  // Capacity denominator = ONE sprint's working days (median of current sprints,
  // clamped 5..15). Date-spread per task was unreliable: many sprint tasks have
  // no start date and/or due dates outside the union window → garbage util.
  // Robust model: each not-done sprint task contributes its SIZE weight; reschedule
  // (new due) is honoured implicitly (the task still counts while open).
  const sprintLens = (use || []).map(w => getWorkingDays(w.start, w.end)).filter(n => n > 0).sort((x,y) => x - y);
  const capDays = source === 'sprint'
    ? (sprintLens.length ? Math.min(15, Math.max(5, sprintLens[Math.floor(sprintLens.length/2)])) : 10)
    : (getWorkingDays(winStart, winEnd) || 10);

  const developers = members.map(member => {
    const its = byA[member.accountId] || [];
    let load = 0; const projMap = {};
    for (const it of its) {
      const st = (it.fields.status?.name || '').toLowerCase().trim();
      if (/done|closed|resolved|complete|production/.test(st)) continue;        // finished
      if (/to ?do|todo|backlog/.test(st) || st === 'open' || st === 'new') continue; // not started
      if (/on ?hold|hold|block|waiting|telco|pending/.test(st)) continue;       // blocked
      const w = getIssueWeight(it);
      load += w;
      const pk = it.fields.project?.key, pn = it.fields.project?.name;
      if (pk) { if (!projMap[pk]) projMap[pk] = { key: pk, name: pn, load: 0, count: 0 }; projMap[pk].load += w; projMap[pk].count++; }
    }
    const utilization = capDays > 0 ? Math.round((load / capDays) * 100) : 0;
    const available = Math.max(0, 100 - utilization);
    const overload = utilization > 100 ? utilization - 100 : 0;
    const primaryGroup = TARGET_GROUPS.find(g => member.groups.includes(g)) || member.groups[0] || 'Unknown';
    const projectAllocations = Object.values(projMap)
      .map(p => ({ key: p.key, name: p.name, pct: capDays > 0 ? Math.round((p.load / capDays) * 100) : 0, count: p.count }))
      .sort((a,b) => b.pct - a.pct).slice(0, 20);
    return {
      accountId: member.accountId, displayName: member.displayName, emailAddress: member.emailAddress,
      avatarUrl: member.avatarUrl, group: primaryGroup, groups: member.groups,
      utilization, available, overload,
      taskCount: its.length,
      activeTaskCount: its.filter(i => !/done|closed|resolved/i.test(i.fields.status?.name || '')).length,
      projectAllocations,
      status: utilization > 100 ? 'overload' : utilization >= 80 ? 'high' : utilization >= 30 ? 'ok' : 'idle'
    };
  });

  const result = {
    developers: developers.sort((a,b) => b.utilization - a.utilization),
    period: { start: winStart, end: winEnd, workingDays: capDays },
    summary: buildSummary(developers),
    mode: 'sprint',
    source,
    activeSprints: activeSprintCount
  };
  cache.capacitySprint = result;
  cache.ts['capacitySprint'] = Date.now();
  return result;
}

// ——— GET /api/capacity ———
// Calculates utilization per developer for current month
app.get('/api/capacity', async (req, res) => {
  try {
    const result = req.query.mode === 'sprint'
      ? await computeCapacitySprint()
      : await computeCapacity();
    res.json(result);
  } catch (e) {
    console.error('capacity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— GET /api/velocity ———
app.get('/api/velocity', async (req, res) => {
  try {
    const { boardId } = req.query;
    const fieldIds = await ensureDateFieldIds();

    // Get all boards if no boardId specified
    let boards = [];
    if (boardId) {
      boards = [{ id: parseInt(boardId) }];
    } else {
      const projects = cache.projects?.projects || [];
      const projectKeys = projects.map(p => p.key).join(',');
      if (!projectKeys) return res.json({ boards: [], sprints: [] });

      const boardData = await jiraGet(`/rest/agile/1.0/board?projectKeyOrId=${projectKeys.split(',')[0]}&maxResults=50`);
      boards = boardData.values || [];
    }

    const velocityData = [];
    const sprintFields = [
      'story_points', 'customfield_10016', 'timeoriginalestimate', 'status', 'resolutiondate',
      fieldIds.start, fieldIds.newStart, fieldIds.due, fieldIds.newDue
    ].filter((v, i, a) => a.indexOf(v) === i).join(',');

    for (const board of boards.slice(0, 5)) {
      try {
        // Get last 5 sprints
        const sprintData = await jiraGet(`/rest/agile/1.0/board/${board.id}/sprint?state=closed&maxResults=5`);
        const sprints = (sprintData.values || []).slice(-5);

        const sprintVelocity = [];
        for (const sprint of sprints) {
          try {
            const issueData = await jiraGet(`/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=200&fields=${sprintFields}`);
            const done = (issueData.issues || []).filter(i => isDoneStatus(i.fields.status?.name));
            // Story points/hours kept for rollback — no longer what drives the velocity math below.
            const points = done.reduce((sum, i) => {
              const sp = i.fields.customfield_10016 || i.fields.story_points;
              return sum + (sp || 0);
            }, 0);
            const hours = done.reduce((sum, i) => {
              return sum + ((i.fields.timeoriginalestimate || 0) / 3600);
            }, 0);
            // Mandays: businessDaysBetween(effective_start, effective_due) summed over Done issues in the sprint.
            const mandays = done.reduce((sum, i) => {
              const { start, due } = getEffectiveDates(i.fields, fieldIds);
              return sum + (businessDaysBetween(start, due) || 0);
            }, 0);

            sprintVelocity.push({
              sprintId: sprint.id,
              sprintName: sprint.name,
              startDate: sprint.startDate,
              endDate: sprint.endDate,
              completedPoints: points,
              completedHours: Math.round(hours),
              completedMandays: Math.round(mandays * 10) / 10,
              completedIssues: done.length,
              totalIssues: (issueData.issues || []).length
            });
          } catch (e) {
            console.warn(`Sprint ${sprint.id} error:`, e.message);
          }
        }

        const avgVelocity = sprintVelocity.length
          ? Math.round(sprintVelocity.reduce((s, v) => s + v.completedPoints, 0) / sprintVelocity.length)
          : 0;
        // avg_velocity = mean(velocity 5 sprint terakhir), unit: mandays/sprint
        const avgVelocityMandays = sprintVelocity.length
          ? Math.round((sprintVelocity.reduce((s, v) => s + v.completedMandays, 0) / sprintVelocity.length) * 10) / 10
          : 0;

        velocityData.push({
          boardId: board.id,
          boardName: board.name,
          sprints: sprintVelocity,
          avgVelocityPoints: avgVelocity,
          avgVelocityMandays
        });
      } catch (e) {
        console.warn(`Board ${board.id} error:`, e.message);
      }
    }

    res.json(velocityData);
  } catch (e) {
    console.error('velocity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— Forecast computation (shared by endpoint + warmup) ———
// ——— Timeline Health: sanity-check every backlog issue's date range ———
function computeTimelineHealth(issueRows, today) {
  const maxMandays = val('MAX_REASONABLE_MANDAYS_PER_ISSUE');
  const minSubtasks = val('ZERO_MANDAYS_MIN_SUBTASKS');
  const link = key => `${JIRA_BASE}/browse/${key}`;

  const groups = {
    reversed: [], noEstimate: [], zeroMandaysLargeIssue: [], extremeDuration: [],
    overdue: [], futureStartInProgress: [], overlappingDev: []
  };

  for (const r of issueRows) {
    const hasStart = !!r.start, hasDue = !!r.due;
    if (hasStart && hasDue && new Date(r.due) < new Date(r.start)) {
      groups.reversed.push({ key: r.key, url: link(r.key),
        message: `Timeline tidak masuk akal: due date lebih awal dari start date (${r.key})` });
      continue; // other date checks are meaningless once the range itself is inverted
    }
    if (!hasStart || !hasDue) {
      groups.noEstimate.push({ key: r.key, url: link(r.key), summary: r.summary,
        message: `${r.key} belum punya ${!hasStart && !hasDue ? 'tanggal start & due' : !hasStart ? 'tanggal start' : 'tanggal due'} — forecast untuk issue ini tidak akurat.` });
      continue;
    }
    if (r.mandays === 0 && r.subtaskCount >= minSubtasks) {
      groups.zeroMandaysLargeIssue.push({ key: r.key, url: link(r.key),
        message: `${r.key} tercatat 0 mandays tapi punya ${r.subtaskCount} subtask — kemungkinan tanggal belum di-set dengan benar.` });
    }
    if (r.mandays > maxMandays) {
      groups.extremeDuration.push({ key: r.key, url: link(r.key),
        message: `${r.key} berdurasi ${r.mandays} hari kerja (>${maxMandays}) — kemungkinan salah set tanggal, pertimbangkan pecah jadi sub-task.` });
    }
    if (new Date(r.due) < today) {
      groups.overdue.push({ key: r.key, url: link(r.key),
        message: `${r.key} sudah melewati due date (${r.due}) tapi status masih "${r.status}".` });
    }
    if (new Date(r.start) > today && r.inProgress) {
      groups.futureStartInProgress.push({ key: r.key, url: link(r.key),
        message: `${r.key} berstatus In Progress tapi start date-nya (${r.start}) masih di masa depan.` });
    }
  }

  // Overlapping-dev-tasks: per assignee, sweep-line over validly-dated issues to find
  // any point in time where ≥2 of their issues are simultaneously active. Reported ONCE
  // per affected developer (not per pair) — a real backlog has many long-range issues
  // per person, so pairwise reporting explodes combinatorially and drowns out signal.
  const byDev = {};
  for (const r of issueRows) {
    if (!r.assigneeId || !r.start || !r.due) continue;
    (byDev[r.assigneeId] = byDev[r.assigneeId] || []).push(r);
  }
  for (const rows of Object.values(byDev)) {
    if (rows.length < 2) continue;
    const events = [];
    for (const r of rows) {
      events.push({ t: new Date(r.start).getTime(), delta: 1, key: r.key });
      const after = new Date(r.due);
      after.setDate(after.getDate() + 1);
      events.push({ t: after.getTime(), delta: -1, key: r.key });
    }
    events.sort((a, b) => a.t - b.t);

    const activeSet = new Set();
    const overlappingKeys = new Set();
    let maxConcurrent = 0;
    for (const e of events) {
      if (e.delta === 1) {
        activeSet.add(e.key);
        if (activeSet.size > 1) for (const k of activeSet) overlappingKeys.add(k);
        maxConcurrent = Math.max(maxConcurrent, activeSet.size);
      } else {
        activeSet.delete(e.key);
      }
    }

    if (maxConcurrent > 1) {
      const devName = rows[0].assigneeName || 'Dev';
      const keys = [...overlappingKeys];
      groups.overlappingDev.push({
        key: rows[0].assigneeId, url: null,
        message: `${devName} punya ${keys.length} task dengan tanggal tumpang tindih (maks ${maxConcurrent} paralel dalam satu waktu): ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''} — beban paralel melebihi kapasitas 1 dev.`
      });
    }
  }

  const typeLabels = {
    reversed: 'Tanggal terbalik (due < start)',
    noEstimate: 'Belum ada estimasi tanggal',
    zeroMandaysLargeIssue: '0 mandays pada issue besar',
    extremeDuration: 'Durasi tidak wajar',
    overdue: 'Overdue (belum Done)',
    futureStartInProgress: 'Start di masa depan tapi In Progress',
    overlappingDev: 'Beban tumpang tindih per developer'
  };

  const groupsOut = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([type, items]) => ({ type, label: typeLabels[type], count: items.length, items: items.slice(0, 50) }));

  return { totalWarnings: groupsOut.reduce((s, g) => s + g.count, 0), groups: groupsOut };
}

// ——— Bagian 6: developer load, current-calendar-month period ———
function computeDeveloperLoad(issueRows, members, today) {
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const remainingWorkDaysInPeriod = businessDaysBetween(toIso(today), toIso(monthEnd)) || 0;
  const capacityDev = remainingWorkDaysInPeriod * val('FOCUS_FACTOR');

  // load_dev = Σ (portion of mandays_per_issue that falls inside the current month) for
  // the dev's not-done issues. Clipped to the period overlap (not the full issue mandays)
  // — many backlog issues span several months, and counting their full mandays against a
  // single month's capacity produced meaningless 1000%+ ratios. This mirrors the existing
  // getActiveDays() precedent on the Capacity page, which clips the same way.
  const byDev = {};
  for (const r of issueRows) {
    if (!r.assigneeId || !r.start || !r.due) continue;
    const rStart = new Date(r.start), rDue = new Date(r.due);
    if (rStart > monthEnd || rDue < monthStart) continue; // no overlap at all
    const clippedStart = rStart > monthStart ? rStart : monthStart;
    const clippedEnd = rDue < monthEnd ? rDue : monthEnd;
    const clippedMandays = businessDaysBetween(toIso(clippedStart), toIso(clippedEnd)) || 0;
    if (!byDev[r.assigneeId]) byDev[r.assigneeId] = { load: 0, issueCount: 0 };
    byDev[r.assigneeId].load += clippedMandays;
    byDev[r.assigneeId].issueCount++;
  }

  const rows = members.map(m => {
    const d = byDev[m.accountId];
    const load = d ? d.load : 0;
    const issueCount = d ? d.issueCount : 0;
    const ratio = capacityDev > 0 ? load / capacityDev : null;
    const status = classifyLoad(ratio);
    return {
      accountId: m.accountId,
      name: m.displayName,
      load: Math.round(load * 10) / 10,
      capacity: Math.round(capacityDev * 10) / 10,
      ratio: ratio != null ? Math.round(ratio * 100) / 100 : null,
      issueCount,
      status,
      statusLabel: LOAD_STATUS_LABEL[status]
    };
  }).sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));

  return { period: { start: toIso(monthStart), end: toIso(monthEnd), remainingWorkDays: remainingWorkDaysInPeriod }, rows };
}

// ——— Bagian 5: actionable recommendations, sorted by impact ———
function computeRecommendations(ctx) {
  const { byCategory, devLoad, issueRows, remainingMandays, dailyCapacity, activeDevCount, estCompletionDate, overallTargetDate, today } = ctx;
  const recs = [];

  const top = byCategory[0];
  if (top && top.mandays > 0) {
    recs.push({ type: 'bottleneck-category', impact: top.mandays,
      message: `Kategori "${top.category}" adalah bottleneck utama — ${top.mandays} mandays tersisa dari ${top.count} issue. Pertimbangkan tambah developer atau pecah task jadi lebih kecil.` });
  }

  const overloaded = devLoad.rows.filter(d => d.status === 'overload').sort((a, b) => b.ratio - a.ratio);
  const idle = devLoad.rows.filter(d => d.status === 'idle').sort((a, b) => a.ratio - b.ratio);
  const pairs = Math.min(overloaded.length, idle.length);
  for (let i = 0; i < pairs; i++) {
    const over = overloaded[i], free = idle[i];
    recs.push({ type: 'redistribute', impact: over.load - over.capacity,
      message: `${over.name} overload (${Math.round(over.ratio * 100)}% kapasitas) — pertimbangkan redistribusi task ke ${free.name} yang idle (${Math.round((free.ratio || 0) * 100)}% kapasitas).` });
  }
  for (let i = pairs; i < overloaded.length; i++) {
    const over = overloaded[i];
    recs.push({ type: 'overload-no-target', impact: over.load - over.capacity,
      message: `${over.name} overload (${Math.round(over.ratio * 100)}% kapasitas) — tidak ada developer idle untuk redistribusi, pertimbangkan tambah anggota tim.` });
  }
  for (let i = pairs; i < idle.length; i++) {
    const free = idle[i];
    recs.push({ type: 'idle', impact: free.capacity - free.load,
      message: `${free.name} idle (${Math.round((free.ratio || 0) * 100)}% kapasitas) — kapasitas nganggur, bisa ambil task dari backlog.` });
  }

  const noEstimateCount = issueRows.filter(r => !r.start || !r.due).length;
  if (noEstimateCount > 0) {
    recs.push({ type: 'no-estimate', impact: noEstimateCount * 5,
      message: `${noEstimateCount} issue belum ada tanggal start/due — forecast belum akurat untuk issue-issue ini, lengkapi dulu di Jira.` });
  }

  // Target = max(effective_due) yang sudah di-set di Jira (bukan field Target End —
  // lihat catatan di forecastConfig / plan). dev_dibutuhkan = remaining / (target_hari_kerja × FOCUS_FACTOR).
  if (overallTargetDate && estCompletionDate && dailyCapacity > 0) {
    const targetWorkDays = businessDaysBetween(toIso(today), toIso(overallTargetDate));
    if (targetWorkDays !== null && targetWorkDays > 0) {
      const focusFactor = val('FOCUS_FACTOR');
      const devNeeded = remainingMandays / (targetWorkDays * focusFactor);
      const devGap = Math.ceil(devNeeded) - activeDevCount;
      if (new Date(estCompletionDate) > new Date(overallTargetDate) && devGap > 0) {
        const mandaysToCut = Math.round(remainingMandays - (targetWorkDays * activeDevCount * focusFactor));
        recs.push({ type: 'target-miss', impact: remainingMandays,
          message: `Estimasi selesai (${toIso(estCompletionDate)}) melewati target (${toIso(overallTargetDate)}, dari due date terjauh yang sudah di-set). Butuh ~${Math.ceil(devNeeded)} dev aktif (saat ini ${activeDevCount}), atau pangkas ~${mandaysToCut} mandays agar sesuai target.` });
      } else if (new Date(estCompletionDate) <= new Date(overallTargetDate)) {
        recs.push({ type: 'target-ok', impact: 1,
          message: `Estimasi selesai (${toIso(estCompletionDate)}) masih dalam target (${toIso(overallTargetDate)}).` });
      }
    } else if (targetWorkDays !== null && targetWorkDays <= 0) {
      recs.push({ type: 'target-passed', impact: remainingMandays,
        message: `Target (due date terjauh yang di-set, ${toIso(overallTargetDate)}) sudah lewat — backlog ini perlu direview ulang.` });
    }
  }

  return recs.sort((a, b) => b.impact - a.impact);
}

// ——— Burndown/burnup series: reconstruct recent "remaining mandays" history ———
// Simplification (documented, no persisted daily snapshots exist): every
// currently-open issue is treated as if it had been open for the whole
// lookback window; only issues resolved within the window are "subtracted
// back in" for the days before their resolution date.
async function computeBurndownSeries(projectKeys, issueRows, fieldIds, today, assigneeIds = null) {
  const lookbackDays = val('BURNDOWN_LOOKBACK_DAYS');
  const startWindow = new Date(today);
  startWindow.setDate(startWindow.getDate() - lookbackDays);

  let resolvedRows = [];
  try {
    const assigneeClause = assigneeIds && assigneeIds.length ? ` AND assignee in (${assigneeIds.map(id => `"${id}"`).join(',')})` : '';
    const jql = `project in (${projectKeys.map(k => `"${k}"`).join(',')}) AND status in (Done, Closed, Resolved) AND resolutiondate >= -${lookbackDays}d${assigneeClause} ORDER BY resolutiondate DESC`;
    const fields = ['status', 'resolutiondate', fieldIds.start, fieldIds.newStart, fieldIds.due, fieldIds.newDue]
      .filter((v, i, a) => a.indexOf(v) === i).join(',');
    const resolved = await jiraSearchAll(jql, fields, 2000);
    resolvedRows = resolved.map(issue => {
      const { start, due } = getEffectiveDates(issue.fields, fieldIds);
      return { mandays: businessDaysBetween(start, due) || 0, resolutiondate: issue.fields.resolutiondate ? issue.fields.resolutiondate.slice(0, 10) : null };
    }).filter(r => r.resolutiondate);
  } catch (e) {
    console.warn('computeBurndownSeries: resolved-issue fetch failed:', e.message);
  }

  const openMandaysTotal = issueRows.reduce((s, r) => s + (r.mandays || 0), 0);

  const actual = [];
  const cur = new Date(startWindow);
  while (cur <= today) {
    const dayStr = toIso(cur);
    const stillOpenFromResolved = resolvedRows.filter(r => r.resolutiondate > dayStr).reduce((s, r) => s + r.mandays, 0);
    actual.push({ date: dayStr, remaining: Math.round((openMandaysTotal + stillOpenFromResolved) * 10) / 10 });
    cur.setDate(cur.getDate() + 1);
  }
  return actual;
}

// Ideal reference line: straight decline from the burndown window's first
// actual point down to 0 at the estimated (or optimistic) completion date.
function computeIdealLine(actualSeries, estCompletionDate) {
  if (!actualSeries.length) return [];
  const startValue = actualSeries[0].remaining;
  const startDate = new Date(actualSeries[0].date);
  const endDate = estCompletionDate ? new Date(estCompletionDate) : new Date(actualSeries[actualSeries.length - 1].date);
  const totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000));

  const points = [];
  const cur = new Date(startDate);
  let i = 0;
  while (cur <= endDate) {
    const frac = i / totalDays;
    points.push({ date: toIso(cur), value: Math.round(startValue * (1 - frac) * 10) / 10 });
    cur.setDate(cur.getDate() + 1);
    i++;
  }
  return points;
}

async function computeForecast(filters = {}) {
  const projectKeysFilter = filters.projectKeys || [];
  const categoriesFilter = filters.categories || [];
  const groupsFilter = filters.groups || [];
  const cacheKey = `${projectKeysFilter.slice().sort().join(',')}|${categoriesFilter.slice().sort().join(',')}|${groupsFilter.slice().sort().join(',')}`;
  cache.forecastByFilter = cache.forecastByFilter || {};
  if (isFresh('forecast:' + cacheKey) && cache.forecastByFilter[cacheKey]) return cache.forecastByFilter[cacheKey];

  // Auto-warm cache if needed (direct loaders — serverless-safe)
  await Promise.all([ensureProjects(), ensureMembers()]);
  const allProjects = cache.projects?.projects || [];
  let projects = allProjects;
  if (categoriesFilter.length) projects = projects.filter(p => categoriesFilter.includes(p.category));
  if (projectKeysFilter.length) projects = projects.filter(p => projectKeysFilter.includes(p.key));
  if (!projects.length) {
    return {
      totalBacklog: 0, remainingMandays: 0, remainingHours: 0, activeDevCount: 0,
      dailyCapacity: 0, capacityStatus: 'no-capacity-data',
      estHariKerja: null, estKalender: null, completionDate: null,
      completionDateOptimistic: null, completionDatePessimistic: null, overallTargetDate: null,
      byCategory: [], totalPoints: 0, totalHours: 0,
      timelineHealth: { totalWarnings: 0, groups: [] },
      developerLoad: { period: {}, rows: [] },
      recommendations: [], burndown: { actual: [], ideal: [] },
      config: PARAMS, example: { text: 'Belum ada project — tidak ada yang bisa dihitung.' },
      computedAt: new Date().toISOString()
    };
  }

  const fieldIds = await ensureDateFieldIds();
  const projectKeys = projects.map(p => p.key);
  const jql = `project in (${projectKeys.map(k => `"${k}"`).join(',')}) AND status not in (Done, Closed, Resolved) ORDER BY priority DESC`;
  const fields = [
    'summary', 'status', 'priority', 'project', 'assignee', 'issuetype', 'subtasks',
    'customfield_10016', 'timeoriginalestimate',
    fieldIds.start, fieldIds.newStart, fieldIds.due, fieldIds.newDue
  ].filter((v, i, a) => a.indexOf(v) === i).join(',');

  // Token-based pagination (the new /search/jql ignores startAt)
  const backlog = (await jiraSearchAll(jql, fields, 5000))
    .filter(i => !isDropped(i.fields?.status?.name)); // ignore Dropped

  const projectCategoryMap = {};
  for (const p of projects) projectCategoryMap[p.key] = p.category;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Group filter: scope both the member roster (for developer-load rows/activeDevCount)
  // and the issue set (drop issues assigned outside the selected group(s), and unassigned
  // ones — group filter means "only this team's work").
  const allMembers = cache.members || [];
  const scopedMembers = groupsFilter.length ? allMembers.filter(m => (m.groups || []).some(g => groupsFilter.includes(g))) : allMembers;
  const scopedMemberIds = groupsFilter.length ? new Set(scopedMembers.map(m => m.accountId)) : null;

  // Single pass: derive effective dates + mandays per issue (mandays_per_issue = businessDays(effective_start, effective_due))
  let totalPoints = 0, totalHours = 0;
  const issueRows = backlog
    .map(issue => {
      const f = issue.fields;
      const { start, due } = getEffectiveDates(f, fieldIds);
      const mandays = businessDaysBetween(start, due); // null = no estimate / reversed range
      const sp = f.customfield_10016 || 0;
      const hrs = (f.timeoriginalestimate || 0) / 3600;
      totalPoints += sp; totalHours += hrs;
      return {
        key: issue.key, summary: f.summary, status: f.status?.name,
        projectKey: f.project?.key, category: projectCategoryMap[f.project?.key] || 'Other',
        assigneeId: f.assignee?.accountId || null, assigneeName: f.assignee?.displayName || null,
        subtaskCount: (f.subtasks || []).length,
        start, due, mandays: mandays || 0, hasEstimate: mandays !== null,
        inProgress: /progress|develop|coding|review/i.test(f.status?.name || '')
      };
    })
    .filter(r => !scopedMemberIds || (r.assigneeId && scopedMemberIds.has(r.assigneeId)));

  // remaining_mandays = Σ mandays_per_issue (status != Done) — overall + by category
  let remainingMandays = 0;
  const byCategoryMap = {};
  for (const r of issueRows) {
    remainingMandays += r.mandays;
    if (!byCategoryMap[r.category]) byCategoryMap[r.category] = { mandays: 0, count: 0 };
    byCategoryMap[r.category].mandays += r.mandays;
    byCategoryMap[r.category].count++;
  }

  // jumlah_dev_aktif = distinct assignees currently carrying ≥1 non-Done issue in scope
  const activeDevCount = new Set(issueRows.filter(r => r.assigneeId).map(r => r.assigneeId)).size;
  const focusFactor = val('FOCUS_FACTOR');
  const dailyCapacity = activeDevCount * focusFactor;
  const capacityStatus = dailyCapacity > 0 ? 'ok' : 'no-capacity-data';

  let estHariKerja = null, estKalender = null, completionDate = null, completionDateOptimistic = null, completionDatePessimistic = null;
  if (dailyCapacity > 0) {
    estHariKerja = remainingMandays / dailyCapacity;
    estKalender = estHariKerja * val('CALENDAR_CONVERSION');
    completionDate = addBusinessDays(today, estHariKerja);

    const optCapacity = activeDevCount * focusFactor * (1 + val('OPTIMISTIC_ADJUST'));
    const pessCapacity = activeDevCount * focusFactor * (1 - val('PESSIMISTIC_ADJUST'));
    completionDateOptimistic = addBusinessDays(today, remainingMandays / optCapacity);
    completionDatePessimistic = pessCapacity > 0 ? addBusinessDays(today, remainingMandays / pessCapacity) : null;
  }

  const byCategory = Object.entries(byCategoryMap).map(([cat, data]) => ({
    category: cat,
    count: data.count,
    mandays: Math.round(data.mandays * 10) / 10,
    hours: Math.round(data.mandays * val('WORK_HOURS_PER_DAY')),
    estimatedDays: dailyCapacity > 0 ? Math.ceil(data.mandays / dailyCapacity) : null
  })).sort((a, b) => b.mandays - a.mandays);

  // Target/deadline = furthest effective_due already set on the remaining issues themselves
  // (not Jira's "Target End" field — see plan notes: rarely populated, stale).
  const dueDates = issueRows.filter(r => r.due).map(r => new Date(r.due));
  const overallTargetDate = dueDates.length ? new Date(Math.max(...dueDates.map(d => d.getTime()))) : null;

  const timelineHealth = computeTimelineHealth(issueRows, today);
  const developerLoad = computeDeveloperLoad(issueRows, scopedMembers, today);
  const recommendations = computeRecommendations({
    byCategory, devLoad: developerLoad, issueRows, remainingMandays, dailyCapacity,
    activeDevCount, estCompletionDate: completionDate, overallTargetDate, today
  });

  const burndownActual = await computeBurndownSeries(projectKeys, issueRows, fieldIds, today, scopedMemberIds ? [...scopedMemberIds] : null);
  const burndownIdeal = computeIdealLine(burndownActual, completionDate);

  const example = {
    remainingMandays: Math.round(remainingMandays * 10) / 10,
    activeDevCount, focusFactor,
    text: dailyCapacity > 0
      ? `remaining ${Math.round(remainingMandays)} mandays ÷ (${activeDevCount} dev × ${focusFactor}) = ${estHariKerja.toFixed(1)} hari kerja ≈ ${estKalender.toFixed(0)} hari kalender`
      : `Tidak ada data kapasitas developer (${activeDevCount} dev aktif) — forecast tidak bisa dihitung.`
  };

  const result = {
    totalBacklog: issueRows.length,
    remainingMandays: Math.round(remainingMandays * 10) / 10,
    remainingHours: Math.round(remainingMandays * val('WORK_HOURS_PER_DAY')),
    activeDevCount,
    dailyCapacity: Math.round(dailyCapacity * 100) / 100,
    capacityStatus,
    estHariKerja: estHariKerja != null ? Math.round(estHariKerja * 10) / 10 : null,
    estKalender: estKalender != null ? Math.round(estKalender * 10) / 10 : null,
    completionDate: completionDate ? toIso(completionDate) : null,
    completionDateOptimistic: completionDateOptimistic ? toIso(completionDateOptimistic) : null,
    completionDatePessimistic: completionDatePessimistic ? toIso(completionDatePessimistic) : null,
    overallTargetDate: overallTargetDate ? toIso(overallTargetDate) : null,
    byCategory,
    // Legacy story-point fields — kept for rollback / other consumers, no longer drive this page's UI.
    totalPoints, totalHours: Math.round(totalHours),
    timelineHealth,
    developerLoad,
    recommendations,
    burndown: { actual: burndownActual, ideal: burndownIdeal },
    config: PARAMS,
    example,
    computedAt: new Date().toISOString()
  };

  cache.forecastByFilter[cacheKey] = result;
  cache.ts['forecast:' + cacheKey] = Date.now();
  return result;
}

app.get('/api/forecast', async (req, res) => {
  try {
    const toList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
    const filters = {
      projectKeys: toList(req.query.projectKey),
      categories: toList(req.query.category),
      groups: toList(req.query.group)
    };
    const result = await computeForecast(filters);
    res.json(result);
  } catch (e) {
    console.error('forecast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— GET /api/sync-status ———
app.get('/api/sync-status', async (req, res) => {
  try {
    await Promise.all([ensureProjects(), ensureMembers()]);
    const projects = cache.projects?.projects || [];
    const members = cache.members || [];

    const now = new Date();
    const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const projectKeys = projects.map(p => p.key);
    const jql = `project in (${projectKeys.slice(0, 30).map(k => `"${k}"`).join(',')}) AND updated >= "${since}" ORDER BY updated DESC`;

    const data = await jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,reporter,updated,project,priority,issuetype`);
    const issues = (data.issues || []).filter(i => !isDropped(i.fields.status?.name)); // ignore Dropped

    const memberSet = new Set(members.map(m => m.accountId));
    const synced = issues.filter(i => i.fields.assignee && memberSet.has(i.fields.assignee.accountId));
    const unassigned = issues.filter(i => !i.fields.assignee);
    const external = issues.filter(i => i.fields.assignee && !memberSet.has(i.fields.assignee.accountId));

    res.json({
      total: issues.length,
      synced: synced.length,
      unassigned: unassigned.length,
      external: external.length,
      lastSync: new Date().toISOString(),
      issues: issues.slice(0, 50).map(i => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status?.name,
        assignee: i.fields.assignee?.displayName || '—',
        assigneeId: i.fields.assignee?.accountId,
        reporter: i.fields.reporter?.displayName || null,
        project: i.fields.project?.name,
        priority: i.fields.priority?.name,
        updated: i.fields.updated,
        syncStatus: !i.fields.assignee ? 'unassigned' :
          memberSet.has(i.fields.assignee.accountId) ? 'synced' : 'external'
      }))
    });
  } catch (e) {
    console.error('sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— GET /api/tasks ———
app.get('/api/tasks', async (req, res) => {
  try {
    const { assigneeId, projectKey, status } = req.query;
    await Promise.all([ensureProjects(), ensureMembers()]);
    const projects = cache.projects?.projects || [];
    const members = cache.members || [];

    let jql = '';
    if (assigneeId) {
      jql = `assignee = "${assigneeId}"`;
    } else if (members.length) {
      jql = `assignee in (${members.slice(0, 50).map(m => `"${m.accountId}"`).join(',')})`;
    }

    if (projectKey) {
      jql += jql ? ` AND project = "${projectKey}"` : `project = "${projectKey}"`;
    } else if (projects.length) {
      const keys = projects.slice(0, 50).map(p => `"${p.key}"`).join(',');
      jql += jql ? ` AND project in (${keys})` : `project in (${keys})`;
    }

    if (status) jql += ` AND status = "${status}"`;
    jql += ' ORDER BY updated DESC';

    const issues = (await jiraSearchAll(jql, 'summary,status,assignee,priority,project,issuetype,customfield_10016,timeoriginalestimate,created,updated,duedate', 3000))
      .filter(i => !isDropped(i.fields.status?.name)); // ignore Dropped

    res.json({
      total: issues.length,
      issues: issues.map(i => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status?.name,
        statusCategory: i.fields.status?.statusCategory?.key,
        assignee: i.fields.assignee?.displayName,
        assigneeId: i.fields.assignee?.accountId,
        priority: i.fields.priority?.name,
        project: i.fields.project?.name,
        projectKey: i.fields.project?.key,
        issueType: i.fields.issuetype?.name,
        storyPoints: i.fields.customfield_10016,
        timeEstimate: i.fields.timeoriginalestimate,
        created: i.fields.created,
        updated: i.fields.updated,
        dueDate: i.fields.duedate
      }))
    });
  } catch (e) {
    console.error('tasks error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— GET /api/boards ———
app.get('/api/boards', async (req, res) => {
  try {
    const projects = cache.projects?.projects || [];
    if (!projects.length) return res.json([]);

    const allBoards = [];
    for (const p of projects.slice(0, 10)) {
      try {
        const data = await jiraGet(`/rest/agile/1.0/board?projectKeyOrId=${p.key}&maxResults=10`);
        for (const b of data.values || []) {
          allBoards.push({ id: b.id, name: b.name, type: b.type, projectKey: p.key });
        }
      } catch (e) { /* project may not have board */ }
    }
    res.json(allBoards);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— MEMBER PROFILES (jabatan + level) ———
// On serverless the project FS is read-only; use /tmp (ephemeral — resets on
// cold start). The repo's data/ copy is used as a read-only seed if present.
const SEED_PROFILES_PATH = path.join(__dirname, 'data', 'member-profiles.json');
const PROFILES_PATH = IS_SERVERLESS
  ? path.join('/tmp', 'member-profiles.json')
  : SEED_PROFILES_PATH;

// In-memory copy so writes survive within a warm serverless instance
let profilesMem = null;

function readProfiles() {
  if (profilesMem) return profilesMem;
  for (const p of [PROFILES_PATH, SEED_PROFILES_PATH]) {
    try { profilesMem = JSON.parse(fs.readFileSync(p, 'utf8')); return profilesMem; }
    catch { /* try next */ }
  }
  profilesMem = {};
  return profilesMem;
}

function writeProfiles(data) {
  profilesMem = data;
  try {
    fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    // Read-only FS on serverless — kept in memory only; logged, not fatal
    console.warn('writeProfiles: could not persist to disk:', e.message);
  }
}

const JABATAN_LEVELS = {
  CTO:   ['CTO'],
  PM:    ['Project Manager', 'Senior PM', 'PM Lead'],
  BA:    ['Junior BA', 'Business Analyst', 'Senior BA', 'BA Lead'],
  QA:    ['Junior QA', 'QA Engineer', 'Senior QA', 'QA Lead'],
  Dev:   ['Junior Developer', 'Developer', 'Mid Developer', 'Senior Developer', 'Lead Developer', 'Staff Engineer']
};

app.get('/api/member-profiles', (req, res) => {
  res.json({ profiles: readProfiles(), jabatanLevels: JABATAN_LEVELS });
});

app.put('/api/member-profiles/:accountId', (req, res) => {
  const { accountId } = req.params;
  const { jabatan, level, displayName } = req.body;
  if (!jabatan || !JABATAN_LEVELS[jabatan]) return res.status(400).json({ error: 'Invalid jabatan' });
  const profiles = readProfiles();
  profiles[accountId] = { accountId, displayName, jabatan, level: level || JABATAN_LEVELS[jabatan][0], updatedAt: new Date().toISOString() };
  writeProfiles(profiles);
  res.json(profiles[accountId]);
});

app.post('/api/member-profiles/bulk', (req, res) => {
  const { updates } = req.body; // [{ accountId, displayName, jabatan, level }]
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates must be array' });
  const profiles = readProfiles();
  for (const u of updates) {
    if (!u.accountId || !JABATAN_LEVELS[u.jabatan]) continue;
    profiles[u.accountId] = { accountId: u.accountId, displayName: u.displayName, jabatan: u.jabatan, level: u.level || JABATAN_LEVELS[u.jabatan][0], updatedAt: new Date().toISOString() };
  }
  writeProfiles(profiles);
  res.json({ updated: Object.keys(profiles).length });
});

// ——— Generic node/edge canvas store (Structure Organization + Structure Project Team) ———
// Same serverless-safe pattern as member-profiles: seed from data/, write to /tmp on Vercel.
function makeCanvasStore(name) {
  const seedPath = path.join(__dirname, 'data', `${name}.json`);
  const writePath = IS_SERVERLESS ? path.join('/tmp', `${name}.json`) : seedPath;
  let mem = null;
  return {
    read() {
      if (mem) return mem;
      for (const p of [writePath, seedPath]) {
        try { mem = JSON.parse(fs.readFileSync(p, 'utf8')); return mem; }
        catch { /* try next */ }
      }
      mem = { nodes: [], edges: [] };
      return mem;
    },
    write(data) {
      mem = data;
      try {
        fs.mkdirSync(path.dirname(writePath), { recursive: true });
        fs.writeFileSync(writePath, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.warn(`${name} store: could not persist to disk:`, e.message);
      }
    }
  };
}
const orgChartStore = makeCanvasStore('org-chart');
const projectTeamStore = makeCanvasStore('project-team');

app.get('/api/org-chart', (req, res) => res.json(orgChartStore.read()));
app.put('/api/org-chart', (req, res) => {
  // Multi-canvas shape: { canvases:[{id,name,nodes,edges}], activeCanvasId }.
  // Server stays a dumb store — no shape opinions beyond "canvases is an array".
  const { canvases, activeCanvasId } = req.body || {};
  if (!Array.isArray(canvases)) return res.status(400).json({ error: 'canvases must be an array' });
  orgChartStore.write({ canvases, activeCanvasId, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/api/project-team', (req, res) => res.json(projectTeamStore.read()));
app.put('/api/project-team', (req, res) => {
  // Multi-canvas shape: { canvases:[{id,name,nodes,edges}], activeCanvasId }.
  // Server stays a dumb store — no shape opinions beyond "canvases is an array".
  const { canvases, activeCanvasId } = req.body || {};
  if (!Array.isArray(canvases)) return res.status(400).json({ error: 'canvases must be an array' });
  projectTeamStore.write({ canvases, activeCanvasId, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// ——— GET /api/drilldown?assigneeId=&projectKey= ———
// Epics → tasks → subtasks for one developer in one project (Developer Capacity drill-down)
app.get('/api/drilldown', async (req, res) => {
  try {
    const { assigneeId, projectKey } = req.query;
    if (!assigneeId || !projectKey) return res.status(400).json({ error: 'assigneeId & projectKey wajib' });
    await ensureProjects();
    const proj = (cache.projects?.projects || []).find(p => p.key === projectKey);

    const jql = `assignee = "${assigneeId}" AND project = "${projectKey}" ORDER BY created DESC`;
    const issues = await jiraSearchAll(jql, 'summary,status,customfield_10016,parent,subtasks,issuetype', 800);

    const isDone = s => /done|closed|resolved|complete|production/i.test(s || '');
    // Ignore Dropped entirely; then display only NON-DONE tasks
    const kept = issues.filter(i => !isDropped(i.fields?.status?.name));
    const doneCount = kept.filter(i => isDone(i.fields?.status?.name)).length;
    const active = kept.filter(i => !isDone(i.fields?.status?.name));

    const epicMap = {};
    for (const it of active) {
      const f = it.fields || {};
      const epicKey   = f.parent?.key || 'NO_EPIC';
      const epicTitle = f.parent?.fields?.summary || 'Tanpa Epic';
      if (!epicMap[epicKey]) epicMap[epicKey] = { key: epicKey, title: epicTitle, taskCount: 0, tasks: [] };
      const e = epicMap[epicKey];
      e.taskCount++;
      e.tasks.push({
        key: it.key,
        title: f.summary,
        status: f.status?.name,
        storyPoints: f.customfield_10016 ?? null,
        // also hide done subtasks
        subtasks: (f.subtasks || [])
          .filter(s => !isDone(s.fields?.status?.name) && !isDropped(s.fields?.status?.name))
          .map(s => ({ key: s.key, title: s.fields?.summary, status: s.fields?.status?.name }))
      });
    }

    res.json({
      projectKey,
      projectName: proj?.name || projectKey,
      totalTasks: active.length,          // displayed (non-done)
      doneTasks: doneCount,               // hidden — shown as context only
      inProgressTasks: active.filter(i => /progress|develop|coding|review/i.test(i.fields?.status?.name || '')).length,
      delayTasks: active.filter(i => /delay/i.test(i.fields?.status?.name || '')).length,
      epics: Object.values(epicMap).sort((a, b) => b.taskCount - a.taskCount)
    });
  } catch (e) {
    console.error('drilldown error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— TIMELINE ———

// Jira fields needed to place a bar on the timeline (shared by timeline + subtask endpoints)
const TL_FIELDS = [
  'summary','status','assignee','priority','project','issuetype',
  'customfield_10016',       // story points
  'timeoriginalestimate',
  'created','updated','resolutiondate',
  'duedate',                 // original due date
  'customfield_10015',       // start date (original)
  'customfield_10578',       // New Start Date
  'customfield_10049',       // New Due Date
  'customfield_10062',       // End date
  'customfield_10008',       // Change start date
  'customfield_10045',       // Country (option field)
  'parent',                  // epic (for "Per Epic" grouping)
  'subtasks'
].join(',');

// Resolve a Jira issue's bar coordinates within [startDate, endDate].
// Returns null when the issue falls entirely outside the display window.
function computeTaskBars(f, startDate, endDate) {
  const newStartDate  = f.customfield_10578 ? new Date(f.customfield_10578) : null;
  const origStartDate = f.customfield_10015 ? new Date(f.customfield_10015) : null;
  const createdDate   = new Date(f.created);
  const newDueDate    = f.customfield_10049 ? new Date(f.customfield_10049) : null;
  const origDueDate   = f.duedate           ? new Date(f.duedate)           : null;
  const endDate2      = f.customfield_10062 ? new Date(f.customfield_10062) : null;
  const resolvedDate  = f.resolutiondate    ? new Date(f.resolutiondate)    : null;

  const hasNewStart = !!newStartDate;
  const hasNewDue   = !!newDueDate;
  const isRescheduled = hasNewStart || hasNewDue;

  const effectiveStart = newStartDate || origStartDate || createdDate;
  const clampedStart   = new Date(Math.max(effectiveStart.getTime(), startDate.getTime()));

  const hoursEst = (f.timeoriginalestimate || 0) / 3600;
  const daysEst  = hoursEst > 0 ? Math.ceil(hoursEst / 6) : Math.max(1, f.customfield_10016 || 3);
  const fallbackEnd = new Date(clampedStart);
  fallbackEnd.setDate(fallbackEnd.getDate() + Math.min(daysEst, 10));

  const effectiveEnd = newDueDate || origDueDate || endDate2 || resolvedDate || fallbackEnd;
  const clampedEnd   = new Date(Math.min(effectiveEnd.getTime(), endDate.getTime()));

  if (clampedEnd < startDate || clampedStart > endDate) return null;

  const clamp = d => new Date(Math.max(startDate.getTime(), Math.min(d.getTime(), endDate.getTime())));
  const iso   = d => d.toISOString().split('T')[0];
  const origStartEff = origStartDate || createdDate;
  const origEndEff   = origDueDate || endDate2 || resolvedDate || (() => { const x = new Date(origStartEff); x.setDate(x.getDate() + Math.min(daysEst, 10)); return x; })();
  const origBarStart = iso(clamp(origStartEff));
  const origBarEnd   = iso(clamp(origEndEff));
  let newBarStart = null, newBarEnd = null;
  if (isRescheduled) {
    const ns = newStartDate || origStartEff;
    const ne = newDueDate   || origEndEff;
    newBarStart = iso(clamp(ns));
    newBarEnd   = iso(clamp(ne));
  }

  return {
    isRescheduled, hasNewStart, hasNewDue,
    created:    f.created ? iso(new Date(f.created)) : null,
    origStart:  origStartDate ? iso(origStartDate) : null,
    newStart:   newStartDate  ? iso(newStartDate)  : null,
    origDue:    origDueDate   ? iso(origDueDate)   : null,
    newDue:     newDueDate    ? iso(newDueDate)    : null,
    barStart:   iso(clampedStart),
    barEnd:     iso(clampedEnd),
    origBarStart, origBarEnd, newBarStart, newBarEnd
  };
}

app.get('/api/timeline', async (req, res) => {
  try {
    const { assigneeId, category, projectKey, group } = req.query;
    // Multi-select filters: each param may be a comma-separated list of values
    // (an empty list = no filter on that field). Single values stay compatible.
    const toList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
    const categories   = toList(category);
    const reqProjKeys  = toList(projectKey);
    const groups       = toList(group);
    const assigneeIds  = toList(assigneeId);

    // Ensure base cache (serverless instances start empty — no warmup)
    await Promise.all([ensureProjects(), ensureMembers()]);
    const members = cache.members || [];
    const allProjects = cache.projects?.projects || [];

    if (!members.length || !allProjects.length) return res.json({ items: [], dateRange: {} });

    // Cache per filter combo (timeline fetch is heavy: thousands of issues)
    const cacheKey = `${categories.join(',')}|${reqProjKeys.join(',')}|${groups.join(',')}|${assigneeIds.join(',')}`;
    if (cache.timeline[cacheKey] && (Date.now() - (cache.ts['tl:'+cacheKey]||0) < CACHE_TTL)) {
      return res.json(cache.timeline[cacheKey]);
    }

    // Filter members by group(s) if requested (OR / IN match)
    const filteredMembers = groups.length
      ? members.filter(m => (m.groups || []).some(g => groups.includes(g)))
      : members;

    const allMemberIds = assigneeIds.length
      ? assigneeIds
      : filteredMembers.map(m => m.accountId);

    // Filter projects by category / specific key (OR / IN match)
    let projects = allProjects;
    if (categories.length)  projects = projects.filter(p => categories.includes(p.category) || categories.includes(p.projectCategory?.name));
    if (reqProjKeys.length) projects = projects.filter(p => reqProjKeys.includes(p.key));
    const projectKeys = projects.map(p => p.key);
    const profiles = readProfiles();

    // Batch members into small groups so the batches can run IN PARALLEL
    // (smaller batches → each fits in one 1000-row page → faster fan-out)
    const BATCH = 10;
    const memberBatches = [];
    for (let i = 0; i < allMemberIds.length; i += BATCH) {
      memberBatches.push(allMemberIds.slice(i, i + BATCH));
    }

    // Display window = TAHUN BERJALAN (1 Jan – 31 Des). Data = task yang DIBUAT tahun ini.
    const now = new Date();
    const yr = now.getFullYear();
    const startDate = new Date(yr, 0, 1);
    const endDate   = new Date(yr, 11, 31);
    // Local date strings (toISOString would shift to UTC and roll back a day in
    // +TZ offsets, producing a spurious extra month at the start of the axis).
    const startStr  = `${yr}-01-01`;
    const endStr    = `${yr}-12-31`;

    const byAssignee = {};

    const tlFields = TL_FIELDS;

    // Run all member-batches in parallel (each token-paginated internally)
    const projJql = `project in (${projectKeys.map(k => `"${k}"`).join(',')})`;
    const batchResults = await Promise.all(memberBatches.map(async batch => {
      if (!batch.length || !projectKeys.length) return [];
      const jql = `${projJql} AND assignee in (${batch.map(id => `"${id}"`).join(',')}) AND created >= "${startStr}" ORDER BY assignee, created DESC`;
      try { return await jiraSearchAll(jql, tlFields, 8000); }
      catch (e) { console.warn('Timeline batch error:', e.message); return []; }
    }));

    {
      for (const issue of batchResults.flat()) {
        const aid   = issue.fields.assignee?.accountId;
        const aName = issue.fields.assignee?.displayName;
        if (!aid) continue;
        if (isDropped(issue.fields.status?.name)) continue; // ignore Dropped entirely

        if (!byAssignee[aid]) {
          const member  = members.find(m => m.accountId === aid) || {};
          const profile = profiles[aid] || {};
          byAssignee[aid] = {
            accountId: aid,
            displayName: aName,
            group:   member.groups?.[0] || '',
            jabatan: profile.jabatan || '',
            level:   profile.level   || '',
            tasks: []
          };
        }

        // Safety cap per person (groups are collapsible + subtasks lazy, so DOM
        // stays light). Raised from 300 because real members exceed it (e.g. 384),
        // which silently dropped their oldest tasks.
        if (byAssignee[aid].tasks.length >= 1500) continue;

        const f = issue.fields;
        const isDone = isDoneStatus(f.status?.name);

        const bars = computeTaskBars(f, startDate, endDate);
        if (!bars) continue; // outside display window

        byAssignee[aid].tasks.push({
          key:        issue.key,
          summary:    f.summary,
          status:     f.status?.name,
          isDone,
          priority:   f.priority?.name,
          project:    f.project?.name,
          projectKey: f.project?.key,
          country:    f.customfield_10045?.value || null,
          epicKey:    f.parent?.key || null,
          epicTitle:  f.parent?.fields?.summary || null,
          ...bars,
          // lightweight subtask list; their bar coords are fetched lazily on expand
          subtasks: (f.subtasks || [])
            .filter(s => !isDropped(s.fields?.status?.name))
            .map(s => ({
              key:     s.key,
              summary: s.fields?.summary,
              status:  s.fields?.status?.name,
              isDone:  isDoneStatus(s.fields?.status?.name)
            }))
        });
      }
    }

    const totalIssues = Object.values(byAssignee).reduce((s, a) => s + a.tasks.length, 0);

    const result = {
      items: Object.values(byAssignee)
        .filter(a => a.tasks.length > 0)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      dateRange: { start: startStr, end: endStr },
      totalIssues
    };
    cache.timeline[cacheKey] = result;
    cache.ts['tl:'+cacheKey] = Date.now();
    res.json(result);
  } catch(e) {
    console.error('timeline error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bar coordinates for specific subtask keys (fetched lazily when a task is expanded).
app.get('/api/timeline-subtasks', async (req, res) => {
  try {
    const keys = String(req.query.keys || '')
      .split(',').map(k => k.trim()).filter(Boolean)
      .slice(0, 100); // safety cap per request
    if (!keys.length) return res.json({ bars: {} });

    const now = new Date(), yr = now.getFullYear();
    const startDate = new Date(yr, 0, 1), endDate = new Date(yr, 11, 31);

    const jql = `key in (${keys.map(k => `"${k}"`).join(',')})`;
    const issues = await jiraSearchAll(jql, TL_FIELDS, 200);

    const out = {};
    for (const issue of issues) {
      const f = issue.fields;
      if (isDropped(f.status?.name)) continue;
      const bars = computeTaskBars(f, startDate, endDate);
      if (!bars) continue; // outside display window
      out[issue.key] = {
        summary: f.summary,
        status:  f.status?.name,
        isDone:  isDoneStatus(f.status?.name),
        ...bars
      };
    }
    res.json({ bars: out });
  } catch(e) {
    console.error('timeline-subtasks error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ——— Helpers ———

function getIssueWeight(issue) {
  const sp = issue.fields?.customfield_10016;
  if (sp) {
    if (sp <= 2) return 0.5;
    if (sp <= 5) return 1.0;
    if (sp <= 10) return 2.0;
    return 3.0;
  }
  const hrs = (issue.fields?.timeoriginalestimate || 0) / 3600;
  if (hrs <= 16) return 0.5;
  if (hrs <= 40) return 1.0;
  if (hrs <= 80) return 2.0;
  return 3.0;
}

function getActiveDays(issue, periodStart, periodEnd, workingDays) {
  const created = new Date(issue.fields?.created || periodStart);
  const resolved = issue.fields?.resolutiondate ? new Date(issue.fields.resolutiondate) : new Date(periodEnd);
  const start = new Date(Math.max(created.getTime(), new Date(periodStart).getTime()));
  const end = new Date(Math.min(resolved.getTime(), new Date(periodEnd).getTime()));
  if (end < start) return 0;
  const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  return Math.min(days, workingDays);
}

function getWorkingDays(startStr, endStr) {
  let count = 0;
  const cur = new Date(startStr);
  const end = new Date(endStr);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function addWorkingDays(date, days) {
  const d = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) remaining--;
  }
  return d;
}

function getCurrentPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  return { start, end };
}

function buildSummary(developers) {
  const overloaded = developers.filter(d => d.utilization > 100);
  const healthy = developers.filter(d => d.utilization >= 70 && d.utilization <= 100);
  const high = developers.filter(d => d.utilization >= 80 && d.utilization <= 100);
  const idle = developers.filter(d => d.utilization < 30);
  const total = developers.length;
  const avgUtil = total ? Math.round(developers.reduce((s, d) => s + d.utilization, 0) / total) : 0;

  return { total, overloaded: overloaded.length, healthy: healthy.length, high: high.length, idle: idle.length, avgUtilization: avgUtil };
}

// ——— Startup cache warmup (only for persistent server, not serverless) ———
async function warmupCache() {
  try {
    console.log('   Warming up cache: projects…');
    await ensureProjects();
    console.log(`   ✓ ${cache.projects.projects.length} projects loaded`);

    console.log('   Warming up cache: members…');
    await ensureMembers();
    console.log(`   ✓ ${cache.members.length} members loaded`);

    // Pre-warm capacity + forecast directly (no self-fetch)
    console.log('   Warming up cache: capacity + forecast… (background)');
    computeCapacity().then(() => console.log('   ✓ Capacity cache ready'))
      .catch(e => console.warn('   ! Capacity warmup failed:', e.message));
    computeForecast().then(() => console.log('   ✓ Forecast cache ready'))
      .catch(e => console.warn('   ! Forecast warmup failed:', e.message));

  } catch(e) {
    console.error('   ✗ Cache warmup failed:', e.message);
  }
}

// On serverless (Vercel) we export the app as the request handler.
// Locally we start a persistent server and warm the cache.
if (IS_SERVERLESS) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`\n🚀 Resource Allocation & Velocity Dashboard`);
    console.log(`   Running at: http://localhost:${PORT}`);
    console.log(`   Jira: ${JIRA_BASE}`);
    console.log(`   Email: ${process.env.JIRA_EMAIL}`);
    if (MISSING_ENV.length) {
      console.error(`   ⚠ Tidak bisa warmup — env hilang: ${MISSING_ENV.join(', ')}`);
    } else {
      await warmupCache();
    }
  });
}
