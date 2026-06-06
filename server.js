require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Target project categories
const TARGET_CATEGORIES = ['VAS', 'Product', 'Project', 'Platform Internal', 'QA'];

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
const cache = { projects: null, members: null, capacity: null, forecast: null, ts: {} };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function isFresh(key) {
  return cache.ts[key] && Date.now() - cache.ts[key] < CACHE_TTL;
}

async function jiraGet(path) {
  const res = await fetch(`${JIRA_BASE}${path}`, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ——— Shared cache loaders (work in both server & serverless) ———
// These populate the cache directly via Jira API, replacing localhost self-fetch
// which does not work on serverless platforms.
async function ensureProjects() {
  if (isFresh('projects') && cache.projects) return cache.projects;
  const cats = await jiraGet('/rest/api/3/projectCategory');
  const targetCatIds = cats
    .filter(c => TARGET_CATEGORIES.some(t => c.name.toLowerCase().includes(t.toLowerCase())))
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

    let allIssues = [];
    let startAt = 0;
    while (true) {
      const data = await jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=assignee,summary,status,priority,customfield_10016,timeoriginalestimate,timeestimate,timespent,created,resolutiondate,updated,project,issuetype`);
      allIssues = allIssues.concat(data.issues || []);
      if (allIssues.length >= data.total || !data.issues?.length) break;
      startAt += 100;
      if (startAt > 2000) break; // safety
    }

    // Group issues by assignee
    const issuesByAssignee = {};
    for (const issue of allIssues) {
      const aid = issue.fields.assignee?.accountId;
      if (!aid) continue;
      if (!issuesByAssignee[aid]) issuesByAssignee[aid] = [];
      issuesByAssignee[aid].push(issue);
    }

    // Build developer capacity rows
    const developers = members.map(member => {
      const issues = issuesByAssignee[member.accountId] || [];

      let weightedLoad = 0;
      const projectMap = {};

      for (const issue of issues) {
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
      })).sort((a, b) => b.pct - a.pct).slice(0, 5);

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
  const jql = `project in (${projectKeys.slice(0, 50).map(k => `"${k}"`).join(',')}) AND status not in (Done, Closed, Resolved) ORDER BY priority DESC`;
  const fields = 'summary,status,priority,customfield_10016,timeoriginalestimate,project,assignee,issuetype';
  const fetchPage = (s) => jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${s}&maxResults=100&fields=${fields}`);

  // Fetch first page to learn total, then fetch remaining pages IN PARALLEL
  const first = await fetchPage(0);
  let backlog = first.issues || [];
  const total = Math.min(first.total || backlog.length, 5000);
  const pageStarts = [];
  for (let s = 100; s < total; s += 100) pageStarts.push(s);
  if (pageStarts.length) {
    const rest = await Promise.all(pageStarts.map(s => fetchPage(s).catch(() => ({ issues: [] }))));
    for (const r of rest) backlog = backlog.concat(r.issues || []);
  }

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
    const projects = cache.projects?.projects || [];
    const members = cache.members || [];

    const now = new Date();
    const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const projectKeys = projects.map(p => p.key);
    const jql = `project in (${projectKeys.slice(0, 30).map(k => `"${k}"`).join(',')}) AND updated >= "${since}" ORDER BY updated DESC`;

    const data = await jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,updated,project,priority,issuetype`);
    const issues = data.issues || [];

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

    const data = await jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=200&fields=summary,status,assignee,priority,project,issuetype,customfield_10016,timeoriginalestimate,created,updated,duedate`);

    res.json({
      total: data.total,
      issues: (data.issues || []).map(i => ({
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

// ——— TIMELINE ———
app.get('/api/timeline', async (req, res) => {
  try {
    const { assigneeId, category, projectKey, group } = req.query;
    const members = cache.members || [];
    const allProjects = cache.projects?.projects || [];

    if (!members.length || !allProjects.length) return res.json({ items: [], dateRange: {} });

    // Filter members by group if requested
    const filteredMembers = group
      ? members.filter(m => (m.groups || []).includes(group))
      : members;

    const allMemberIds = assigneeId
      ? [assigneeId]
      : filteredMembers.map(m => m.accountId);

    // Filter projects by category / specific key
    let projects = allProjects;
    if (category)    projects = projects.filter(p => p.category === category || p.projectCategory?.name === category);
    if (projectKey)  projects = projects.filter(p => p.key === projectKey);
    const projectKeys = projects.map(p => p.key);
    const profiles = readProfiles();

    // Batch members in groups of 20 to avoid JQL length limits
    const BATCH = 20;
    const memberBatches = [];
    for (let i = 0; i < allMemberIds.length; i += BATCH) {
      memberBatches.push(allMemberIds.slice(i, i + BATCH));
    }

    // Display window: 3 months back to 6 months forward
    const now = new Date();
    const startDate = new Date(now); startDate.setMonth(startDate.getMonth() - 3);
    const endDate   = new Date(now); endDate.setMonth(endDate.getMonth() + 6);
    const startStr  = startDate.toISOString().split('T')[0];
    const endStr    = endDate.toISOString().split('T')[0];

    // JQL lookback: same as startDate
    const lookbackStr = startStr;

    const byAssignee = {};

    for (const batch of memberBatches) {
      if (!batch.length || !projectKeys.length) continue;
      const jql = `project in (${projectKeys.slice(0, 30).map(k => `"${k}"`).join(',')}) AND assignee in (${batch.map(id => `"${id}"`).join(',')}) AND (status != Done OR updated >= "${lookbackStr}") ORDER BY assignee, updated DESC`;

      let batchIssues = [];
      try {
        // Include all date fields: original + new start/due
        const fields = [
          'summary','status','assignee','priority','project','issuetype',
          'customfield_10016',       // story points
          'timeoriginalestimate',
          'created','updated','resolutiondate',
          'duedate',                 // original due date
          'customfield_10015',       // start date (original)
          'customfield_10578',       // New Start Date
          'customfield_10049',       // New Due Date
          'customfield_10062',       // End date
          'customfield_10008'        // Change start date
        ].join(',');
        const data = await jiraGet(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=0&maxResults=200&fields=${fields}`);
        batchIssues = data.issues || [];
      } catch(e) {
        console.warn('Timeline batch error:', e.message);
        continue;
      }

      for (const issue of batchIssues) {
        const aid   = issue.fields.assignee?.accountId;
        const aName = issue.fields.assignee?.displayName;
        if (!aid) continue;

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

        // Limit to 25 tasks per person to keep timeline readable
        if (byAssignee[aid].tasks.length >= 25) continue;

        const f = issue.fields;
        const isDone = ['Done','Closed','Resolved'].includes(f.status?.name);

        // ——— Date resolution with priority ———
        // New Start Date (customfield_10578) → Start date (10015) → created
        const newStartDate  = f.customfield_10578 ? new Date(f.customfield_10578) : null;
        const origStartDate = f.customfield_10015 ? new Date(f.customfield_10015) : null;
        const createdDate   = new Date(f.created);

        // New Due Date (customfield_10049) → Due date → End date (10062) → resolved → estimated
        const newDueDate    = f.customfield_10049 ? new Date(f.customfield_10049) : null;
        const origDueDate   = f.duedate           ? new Date(f.duedate)           : null;
        const endDate2      = f.customfield_10062 ? new Date(f.customfield_10062) : null;
        const resolvedDate  = f.resolutiondate    ? new Date(f.resolutiondate)    : null;

        // Detect if timeline was rescheduled
        const hasNewStart = !!newStartDate;
        const hasNewDue   = !!newDueDate;
        const isRescheduled = hasNewStart || hasNewDue;

        // Effective start for bar
        const effectiveStart = newStartDate || origStartDate || createdDate;
        const clampedStart   = new Date(Math.max(effectiveStart.getTime(), startDate.getTime()));

        // Effective end for bar
        const hoursEst = (f.timeoriginalestimate || 0) / 3600;
        const daysEst  = hoursEst > 0 ? Math.ceil(hoursEst / 6) : Math.max(1, f.customfield_10016 || 3);
        const fallbackEnd = new Date(clampedStart);
        fallbackEnd.setDate(fallbackEnd.getDate() + Math.min(daysEst, 10));

        const effectiveEnd = newDueDate || origDueDate || endDate2 || resolvedDate || fallbackEnd;
        const clampedEnd   = new Date(Math.min(effectiveEnd.getTime(), endDate.getTime()));

        if (clampedEnd < startDate || clampedStart > endDate) continue;

        byAssignee[aid].tasks.push({
          key:          issue.key,
          summary:      f.summary,
          status:       f.status?.name,
          isDone,
          isRescheduled,
          hasNewStart,
          hasNewDue,
          // raw date values for tooltip
          origStart:    origStartDate?.toISOString().split('T')[0] || null,
          newStart:     newStartDate?.toISOString().split('T')[0]  || null,
          origDue:      origDueDate?.toISOString().split('T')[0]   || null,
          newDue:       newDueDate?.toISOString().split('T')[0]    || null,
          priority:   f.priority?.name,
          project:    f.project?.name,
          projectKey: f.project?.key,
          barStart:   clampedStart.toISOString().split('T')[0],
          barEnd:     clampedEnd.toISOString().split('T')[0]
        });
      }
    }

    const totalIssues = Object.values(byAssignee).reduce((s, a) => s + a.tasks.length, 0);

    res.json({
      items: Object.values(byAssignee)
        .filter(a => a.tasks.length > 0)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      dateRange: { start: startStr, end: endStr },
      totalIssues
    });
  } catch(e) {
    console.error('timeline error:', e.message);
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
