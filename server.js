const path = require('path');
// Load .env relative to this file so it works no matter the cwd
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');

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
const TARGET_CATEGORIES = ['VAS Project', 'Product OTT', 'Project', 'Platform Internal', 'QA', 'RnD', 'Pre Sales'];

// Target user groups
const TARGET_GROUPS = [
  'PMO Team',
  'Cehat Sehat Developer',
  'Developer',
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
  cache.forecast = null;
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
    const jql = `project in (${projectKeys.slice(0, 50).map(k => `"${k}"`).join(',')}) AND assignee in (${memberIds.slice(0, 50).map(id => `"${id}"`).join(',')}) AND (status != Done OR updated >= "${startOfMonth}") ORDER BY updated DESC`;
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
        activeTaskCount: issues.filter(i => !['Done', 'Closed', 'Resolved'].includes(i.fields.status?.name)).length,
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

// ——— GET /api/capacity ———
// Calculates utilization per developer for current month
app.get('/api/capacity', async (req, res) => {
  try {
    const result = await computeCapacity();
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

    for (const board of boards.slice(0, 5)) {
      try {
        // Get last 5 sprints
        const sprintData = await jiraGet(`/rest/agile/1.0/board/${board.id}/sprint?state=closed&maxResults=5`);
        const sprints = (sprintData.values || []).slice(-5);

        const sprintVelocity = [];
        for (const sprint of sprints) {
          try {
            const issueData = await jiraGet(`/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=200&fields=story_points,customfield_10016,timeoriginalestimate,status,resolutiondate`);
            const done = (issueData.issues || []).filter(i =>
              ['Done', 'Closed', 'Resolved'].includes(i.fields.status?.name)
            );
            const points = done.reduce((sum, i) => {
              const sp = i.fields.customfield_10016 || i.fields.story_points;
              return sum + (sp || 0);
            }, 0);
            const hours = done.reduce((sum, i) => {
              return sum + ((i.fields.timeoriginalestimate || 0) / 3600);
            }, 0);

            sprintVelocity.push({
              sprintId: sprint.id,
              sprintName: sprint.name,
              startDate: sprint.startDate,
              endDate: sprint.endDate,
              completedPoints: points,
              completedHours: Math.round(hours),
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

        velocityData.push({
          boardId: board.id,
          boardName: board.name,
          sprints: sprintVelocity,
          avgVelocityPoints: avgVelocity
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
async function computeForecast() {
  if (isFresh('forecast') && cache.forecast) return cache.forecast;

  // Auto-warm cache if needed (direct loaders — serverless-safe)
  await Promise.all([ensureProjects(), ensureMembers()]);
  const projects = cache.projects?.projects || [];
  if (!projects.length) {
    return { totalBacklog: 0, totalPoints: 0, totalHours: 0, daysToComplete: 0, completionMonths: 0, completionDate: new Date().toISOString().split('T')[0], byCategory: [] };
  }

  const projectKeys = projects.map(p => p.key);
  const jql = `project in (${projectKeys.map(k => `"${k}"`).join(',')}) AND status not in (Done, Closed, Resolved) ORDER BY priority DESC`;
  const fields = 'summary,status,priority,customfield_10016,timeoriginalestimate,project,assignee,issuetype';
  // Token-based pagination (the new /search/jql ignores startAt)
  const backlog = (await jiraSearchAll(jql, fields, 5000))
    .filter(i => !isDropped(i.fields?.status?.name)); // ignore Dropped

    // Group by project category
    const projectCategoryMap = {};
    for (const p of projects) {
      projectCategoryMap[p.key] = p.category;
    }

    const byCategory = {};
    let totalPoints = 0;
    let totalHours = 0;

    for (const issue of backlog) {
      const projKey = issue.fields.project?.key;
      const category = projectCategoryMap[projKey] || 'Other';
      if (!byCategory[category]) byCategory[category] = { points: 0, hours: 0, count: 0 };
      const sp = issue.fields.customfield_10016 || 0;
      const hrs = (issue.fields.timeoriginalestimate || 0) / 3600;
      byCategory[category].points += sp;
      byCategory[category].hours += hrs;
      byCategory[category].count++;
      totalPoints += sp;
      totalHours += hrs;
    }

    // Velocity: estimate based on active developers × capacity
    // If no story points/hours: use issue count velocity
    // Assume team can close ~N issues per working day
    const activeDeveloperCount = Math.max((cache.members || []).length, 1);
    // Conservative: each dev closes ~0.5 issues/day on average across backlog types
    const issuesPerDay = Math.max(activeDeveloperCount * 0.5, 1);
    const avgVelocityPerDay = 4;

    let daysToComplete;
    if (totalPoints > 0) {
      daysToComplete = Math.ceil(totalPoints / avgVelocityPerDay);
    } else if (totalHours > 0) {
      daysToComplete = Math.ceil(totalHours / (activeDeveloperCount * 6));
    } else {
      // Fallback: issue count based
      daysToComplete = Math.ceil(backlog.length / issuesPerDay);
    }

    const completionDate = addWorkingDays(new Date(), daysToComplete);
    const completionMonths = (daysToComplete / 22).toFixed(1);
    const usedMetric = totalPoints > 0 ? 'story_points' : totalHours > 0 ? 'time_estimate' : 'issue_count';

    const result = {
      totalBacklog: backlog.length,
      totalPoints,
      totalHours: Math.round(totalHours),
      daysToComplete,
      completionMonths: parseFloat(completionMonths),
      completionDate: completionDate.toISOString().split('T')[0],
      velocityMetric: usedMetric,
      issuesPerDay: Math.round(issuesPerDay * 10) / 10,
      byCategory: Object.entries(byCategory).map(([cat, data]) => {
        const catDays = data.points > 0
          ? Math.ceil(data.points / avgVelocityPerDay)
          : data.hours > 0
            ? Math.ceil(data.hours / (activeDeveloperCount * 6))
            : Math.ceil(data.count / issuesPerDay);
        return {
          category: cat,
          count: data.count,
          points: Math.round(data.points),
          hours: Math.round(data.hours),
          estimatedDays: catDays
        };
      })
    };

    cache.forecast = result;
    cache.ts['forecast'] = Date.now();
    return result;
}

app.get('/api/forecast', async (req, res) => {
  try {
    const result = await computeForecast();
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
        const isDone = ['Done','Closed','Resolved'].includes(f.status?.name);

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
              isDone:  ['Done','Closed','Resolved'].includes(s.fields?.status?.name)
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
        isDone:  ['Done','Closed','Resolved'].includes(f.status?.name),
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
