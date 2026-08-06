const path = require('path');
// Load .env relative to this file so it works no matter the cwd
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');
const forecastConfig = require('./forecastConfig');
const { getEffectiveDates, classifyLoad, LOAD_STATUS_LABEL, DEFAULT_FIELD_IDS, val, PARAMS } = forecastConfig;
const { businessDaysBetween, addBusinessDays, toIso } = require('./businessDays');
const { parseAirpayCsv } = require('./lib/airpay/parseSheet');
const {
  buildChecklistWorkbook, buildMomMarkdown, computePeriodEnd, checklistFileName, momFileName, isoWeek
} = require('./lib/governance/buildTemplates');
const { readSubmissionMeta, diffStructure } = require('./lib/governance/readSubmissionMeta');
const { parseChecklistWorkbook } = require('./lib/governance/parseChecklist');
const { parseMomWorkbook } = require('./lib/governance/parseMom');
const { mergeSubmission } = require('./lib/governance/mergeSubmissionRows');
const multer = require('multer');

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

// ——— Authentication ———
// Deliberately dependency-free: scrypt + HMAC from node:crypto, and a stateless
// signed cookie. No passport/jwt/bcrypt/cookie-parser — this repo runs on three
// dependencies and a stateless cookie is what works on serverless anyway.
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = 'rp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function verifyPassword(password, salt, expectedHex) {
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  // timingSafeEqual throws on length mismatch, so check first.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function signSession(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(token) {
  if (!token || !SESSION_SECRET) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (IS_SERVERLESS) parts.push('Secure'); // production is HTTPS; localhost isn't
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (IS_SERVERLESS) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Readable device summary for the "last login" column. User-Agent is supplied
// by the client and trivially spoofed — this is a convenience signal, never
// evidence. Modern Chrome also freezes UA details, so it stays approximate.
function parseUserAgent(ua) {
  const s = String(ua || '');
  if (!s.trim()) return 'Unknown device';

  let browser = null;
  if (/EdgA?\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';

  let os = null;
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let type = 'Desktop';
  if (/iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) type = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android/i.test(s)) type = 'Mobile';

  const parts = [browser, os, type].filter(Boolean);
  // Only a bare type isn't worth showing — say so rather than guessing.
  return parts.length > 1 ? parts.join(' · ') : 'Unknown device';
}

const USER_PUBLIC_COLS = 'id,username,email,display_name,must_change_password,is_admin,is_active,' +
                         'allowed_project_keys,allowed_nav_ids,last_login_at,last_login_device,created_at,updated_at';

// The guard re-reads the user on every API call so deactivating someone takes
// effect without waiting for their cookie to expire. A short in-process memo
// keeps that from becoming one extra Supabase round-trip per dashboard request;
// the trade-off is that a deactivation lands within SESSION_USER_TTL_MS.
const SESSION_USER_TTL_MS = 30 * 1000;
const sessionUserCache = new Map(); // uid -> { user, ts }

async function loadSessionUser(uid) {
  const hit = sessionUserCache.get(uid);
  if (hit && Date.now() - hit.ts < SESSION_USER_TTL_MS) return hit.user;
  const rows = await supabaseRequest('GET', `app_users?id=eq.${uid}&select=*`);
  const user = rows && rows.length ? rows[0] : null;
  sessionUserCache.set(uid, { user, ts: Date.now() });
  return user;
}
function invalidateSessionUser(uid) {
  sessionUserCache.delete(uid);
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, last_login_user_agent, ...rest } = u;
  return rest;
}

// Only the login call is reachable without a session.
const AUTH_PUBLIC_PATHS = new Set(['/auth/login']);

// Guard: every API route returns a clear 500 if env vars are missing (instead
// of crashing the serverless function), and 401 without a valid session.
app.use('/api', async (req, res, next) => {
  if (MISSING_ENV.length) {
    return res.status(500).json({
      error: `Server belum dikonfigurasi: environment variable hilang (${MISSING_ENV.join(', ')}). ` +
             `Set di Vercel → Project Settings → Environment Variables.`
    });
  }
  if (AUTH_PUBLIC_PATHS.has(req.path)) return next();

  if (!SESSION_SECRET) {
    return res.status(503).json({
      error: 'Server belum dikonfigurasi: SESSION_SECRET belum di-set ' +
             '(lokal di .env, production di Vercel → Project Settings → Environment Variables).'
    });
  }

  const session = readSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'Not signed in' });

  try {
    const user = await loadSessionUser(session.uid);
    if (!user || !user.is_active) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Your session is no longer valid' });
    }
    req.user = user;
    next();
  } catch (e) {
    console.error('session lookup failed:', e.message);
    res.status(502).json({ error: 'Could not verify your session' });
  }
});

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Target project categories — EXACT names (case-insensitive).
// Jira renames (per 2026): "Product"→"Product OTT", "Project OTT"→"Project". + RnD.
// "Team Product" sengaja TIDAK disertakan.
const TARGET_CATEGORIES = ['VAS Project', 'Product OTT', 'Project', 'Platform Internal', 'QA', 'RnD', 'Pre Sales', 'Surat Sakit & Cepat Sehat', 'SaaS Project'];

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

// Narrows the project list to what a user is allowed to see. This is the one
// place scoping is applied: STATE.projects on the client feeds every project
// selector (Velocity/Forecast combos, Timeline combos, the Capacity dropdown
// and the Project Team canvas), so filtering here scopes all of them at once.
//
// Note this is a DISPLAY scope, not access control — the other Jira endpoints
// still compute over every project, and a signed-in user can call them
// directly. See the auth notes in CLAUDE.md.
function scopeProjectsForUser(result, user) {
  if (!user || user.is_admin) return result;
  const allowed = new Set(user.allowed_project_keys || []);
  const projects = (result.projects || []).filter(p => allowed.has(p.key));
  const stillPresent = new Set(projects.map(p => p.category));
  return {
    ...result,
    projects,
    categories: (result.categories || []).filter(c => stillPresent.has(c.name))
  };
}

// ——— GET /api/projects ———
app.get('/api/projects', async (req, res) => {
  try {
    const result = scopeProjectsForUser(await ensureProjects(), req.user);
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
  cache.airpayIssues = null;
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
      byCategory: [], byTeam: [], totalPoints: 0, totalHours: 0,
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

  // Mandays per Team — breaks the same remaining_mandays total down by the Jira group
  // (team) of each issue's assignee, so "out of all mandays, how many per person in
  // that team" is explicit. Informational only — does NOT feed daily_capacity/
  // est_completion above (those stay a single cross-team pool, per product decision).
  const memberGroupMap = {};
  for (const m of allMembers) memberGroupMap[m.accountId] = (m.groups || [])[0] || 'No Group';
  const byTeamMap = {};
  for (const r of issueRows) {
    const team = r.assigneeId ? (memberGroupMap[r.assigneeId] || 'No Group') : 'Unassigned';
    if (!byTeamMap[team]) byTeamMap[team] = { mandays: 0, count: 0, devIds: new Set() };
    byTeamMap[team].mandays += r.mandays;
    byTeamMap[team].count++;
    if (r.assigneeId) byTeamMap[team].devIds.add(r.assigneeId);
  }
  const byTeam = Object.entries(byTeamMap).map(([team, data]) => {
    const devCount = data.devIds.size;
    return {
      team, count: data.count,
      mandays: Math.round(data.mandays * 10) / 10,
      devCount,
      mandaysPerDev: devCount > 0 ? Math.round((data.mandays / devCount) * 10) / 10 : null
    };
  }).sort((a, b) => b.mandays - a.mandays);

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
    byTeam,
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
// Backed by Supabase's member_profiles table, keyed by Jira accountId. This
// used to be a JSON file (data/ locally, /tmp on Vercel) — on serverless
// /tmp is per-instance and ephemeral, so edits silently vanished on the next
// cold start. Moving it into Supabase is what actually makes "Save" durable.
const JABATAN_LEVELS = {
  CTO:        ['CTO'],
  PM:         ['Project Manager', 'Senior PM', 'PM Lead'],
  BA:         ['Junior BA', 'Business Analyst', 'Senior BA', 'BA Lead'],
  QA:         ['Junior QA', 'QA Engineer', 'Senior QA', 'QA Lead'],
  Dev:        ['Junior Developer', 'Developer', 'Mid Developer', 'Senior Developer', 'Lead Developer', 'Staff Engineer'],
  Specialist: ['AI Specialist', 'Data Analyst', 'Data Engineering', 'Other Specialist'],
  // No preset list — the level is a free-text field the admin fills in by hand.
  Other:      []
};

function profileFromRow(row) {
  return { accountId: row.account_id, displayName: row.display_name, jabatan: row.jabatan, level: row.level, updatedAt: row.updated_at };
}

app.get('/api/member-profiles', requireSupabase, async (req, res) => {
  try {
    const rows = await supabaseRequest('GET', 'member_profiles?select=*');
    const profiles = {};
    (rows || []).forEach(r => { profiles[r.account_id] = profileFromRow(r); });
    res.json({ profiles, jabatanLevels: JABATAN_LEVELS });
  } catch (e) {
    sendSupabaseError(res, e, 'member-profiles');
  }
});

app.put('/api/member-profiles/:accountId', requireSupabase, async (req, res) => {
  const { accountId } = req.params;
  const { jabatan, level, displayName } = req.body;
  if (!jabatan || !JABATAN_LEVELS[jabatan]) return res.status(400).json({ error: 'Invalid jabatan' });
  try {
    const updated = await supabaseRequest(
      'POST',
      'member_profiles?on_conflict=account_id&select=*',
      [{
        account_id: accountId, display_name: displayName, jabatan,
        level: level || JABATAN_LEVELS[jabatan][0] || null, updated_at: new Date().toISOString(), updated_by: req.user.id
      }],
      'resolution=merge-duplicates,return=representation'
    );
    res.json(profileFromRow(updated[0]));
  } catch (e) {
    sendSupabaseError(res, e, 'member-profiles');
  }
});

app.post('/api/member-profiles/bulk', requireSupabase, async (req, res) => {
  const { updates } = req.body; // [{ accountId, displayName, jabatan, level }]
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates must be array' });
  const rows = updates
    .filter(u => u.accountId && JABATAN_LEVELS[u.jabatan])
    .map(u => ({
      account_id: u.accountId, display_name: u.displayName, jabatan: u.jabatan,
      level: u.level || JABATAN_LEVELS[u.jabatan][0] || null, updated_at: new Date().toISOString(), updated_by: req.user.id
    }));
  if (!rows.length) return res.json({ updated: 0 });
  try {
    await supabaseRequest('POST', 'member_profiles?on_conflict=account_id', rows, 'resolution=merge-duplicates,return=minimal');
    res.json({ updated: rows.length });
  } catch (e) {
    sendSupabaseError(res, e, 'member-profiles/bulk');
  }
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
  'customfield_10028',       // Target start (roadmap) — resolved by name 2026-07-15
  'customfield_10029',       // Target end   (roadmap) — resolved by name 2026-07-15
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
          // Roadmap Target start/end — drive the teal target line (separate from
          // the Start date/Due date that position the progress bar). May be null.
          targetStart: f.customfield_10028 || null,
          targetEnd:   f.customfield_10029 || null,
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

    // Epics only ever reach the timeline as a `parent` reference on their child
    // tasks (Jira's default parent embed carries summary/status, not custom
    // fields), so an epic's OWN Target start/end was never fetched — editing it
    // in Jira had no effect on the Gantt. Batch-fetch those two fields directly
    // for every distinct epic key seen above; the frontend prefers this over
    // aggregating child-task dates when both target fields are set.
    const epicKeys = [...new Set(
      Object.values(byAssignee).flatMap(a => a.tasks.map(t => t.epicKey).filter(Boolean))
    )];
    const epicTargets = {};
    if (epicKeys.length) {
      const EBATCH = 80;
      const epicChunks = [];
      for (let i = 0; i < epicKeys.length; i += EBATCH) epicChunks.push(epicKeys.slice(i, i + EBATCH));
      const epicResults = await Promise.all(epicChunks.map(async chunk => {
        const jql = `key in (${chunk.map(k => `"${k}"`).join(',')})`;
        try { return await jiraSearchAll(jql, 'customfield_10028,customfield_10029', 500); }
        catch (e) { console.warn('Epic target fetch error:', e.message); return []; }
      }));
      for (const issue of epicResults.flat()) {
        if (!issue?.key) continue; // defensive: skip malformed/partial entries
        epicTargets[issue.key] = {
          targetStart: issue.fields?.customfield_10028 || null,
          targetEnd:   issue.fields?.customfield_10029 || null
        };
      }
    }

    const result = {
      items: Object.values(byAssignee)
        .filter(a => a.tasks.length > 0)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      dateRange: { start: startStr, end: endStr },
      totalIssues,
      epicTargets
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

// ——— AirPay Report — live from Google Sheets, independent of Jira ———
// The gid originally shared for this sheet (88918681) doesn't resolve via
// the gid-based export endpoint (Google returns its "file not found" page
// for it) — gviz's `sheet=` name parameter is used instead, which reliably
// targets the "Detail Progress" tab regardless of its internal gid. No
// caching here by design: every call refetches the sheet fresh (node-fetch
// has no built-in cache), per the "must stay live" requirement — the client
// is what polls on an interval, not this endpoint.
const AIRPAY_SHEET_ID = '1Eb4th4hPd0BFKi9faz6RkjyvbfrhQTrqjZ8_R0Xpwmw';
const AIRPAY_SHEET_TAB = 'Detail Progress';

async function fetchAirpayCsv() {
  const url = `https://docs.google.com/spreadsheets/d/${AIRPAY_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(AIRPAY_SHEET_TAB)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Google Sheets responded ${r.status}`);
  const text = await r.text();
  // A dead/renamed sheet or tab still returns HTTP 200 with an HTML error
  // page — detect that instead of trying to CSV-parse markup.
  if (text.trim().startsWith('<')) throw new Error('Sheet returned HTML instead of CSV (bad sheet ID or tab name)');
  return text;
}

app.get('/api/airpay-sheet', async (req, res) => {
  try {
    const csv = await fetchAirpayCsv();
    const { tasks, summary, error } = parseAirpayCsv(csv);
    if (error) return res.status(502).json({ error });
    res.json({ tasks, summary, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('airpay-sheet error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ——— AirPay Wins & Blockers — manually curated, stored in Supabase ———
// Deliberately NOT derived from the sheet or Jira: every row is typed by a
// human through the Summary Report UI. Jira is only consulted for a list of
// issue key+summary to populate the "pick a task" dropdown.
//
// All access goes through this server, never straight from the browser. The
// app has no authentication of any kind, so an anon key + permissive RLS
// would leave the tables writable (and deletable) by anyone who loads the
// page. RLS is enabled on both tables with NO policies; the service role key
// bypasses it and stays server-side.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_READY = !!(SUPABASE_URL && SUPABASE_KEY);

// `prefer` overrides the default 'return=representation' — governance's bulk
// upsert needs 'resolution=merge-duplicates,...' instead, which the default
// omits (without it, on_conflict in the URL alone does not trigger upsert
// behavior and duplicate keys 409 as a plain insert).
async function supabaseRequest(method, pathQuery, body, prefer) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathQuery}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer || 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!r.ok) {
    const msg = (data && data.message) || (typeof data === 'string' && data) || `Supabase responded ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

// Every Supabase-backed route returns a clear 503 rather than crashing when
// the env vars aren't set — same spirit as the Jira env guard above.
function requireSupabase(req, res, next) {
  if (!SUPABASE_READY) {
    return res.status(503).json({
      error: 'Supabase belum dikonfigurasi: set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY ' +
             '(lokal di .env, production di Vercel → Project Settings → Environment Variables).'
    });
  }
  next();
}

const WIN_CATEGORIES = ['Platform', 'DCB', 'Digital Payment'];
const BLOCKER_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];
const BLOCKER_STATUSES = ['Open', 'In Progress', 'Resolved'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const trimmed = v => (typeof v === 'string' ? v.trim() : '');

// Validate server-side rather than leaning on the table CHECK constraints:
// a 400 naming the bad field is far more useful to the form than a raw
// Postgres constraint-violation string surfaced from Supabase.
function validateWin(body) {
  const errors = [];
  const b = body || {};
  const title = trimmed(b.title);
  const category = trimmed(b.category);
  const winDate = trimmed(b.win_date);

  if (!title) errors.push('title is required');
  if (!WIN_CATEGORIES.includes(category)) errors.push(`category must be one of: ${WIN_CATEGORIES.join(', ')}`);
  if (!winDate) errors.push('win_date is required');
  else if (!ISO_DATE_RE.test(winDate)) errors.push('win_date must be YYYY-MM-DD');

  return {
    errors,
    row: {
      win_date: winDate,
      category,
      title,
      description: trimmed(b.description) || null,
      jira_issue_key: trimmed(b.jira_issue_key) || null
    }
  };
}

function validateBlocker(body) {
  const errors = [];
  const b = body || {};
  const title = trimmed(b.title);
  const pic = trimmed(b.pic);
  const priority = trimmed(b.priority);
  const status = trimmed(b.status) || 'Open';
  const bottleneck = trimmed(b.bottleneck);
  const nextAction = trimmed(b.next_action);
  const targetDate = trimmed(b.target_date);

  if (!title) errors.push('title is required');
  if (!pic) errors.push('pic is required');
  if (!bottleneck) errors.push('bottleneck is required');
  if (!nextAction) errors.push('next_action is required');
  if (!BLOCKER_PRIORITIES.includes(priority)) errors.push(`priority must be one of: ${BLOCKER_PRIORITIES.join(', ')}`);
  if (!BLOCKER_STATUSES.includes(status)) errors.push(`status must be one of: ${BLOCKER_STATUSES.join(', ')}`);
  if (targetDate && !ISO_DATE_RE.test(targetDate)) errors.push('target_date must be YYYY-MM-DD');

  return {
    errors,
    row: {
      title,
      jira_issue_key: trimmed(b.jira_issue_key) || null,
      pic,
      priority,
      status,
      bottleneck,
      next_action: nextAction,
      target_date: targetDate || null
    }
  };
}

function sendSupabaseError(res, e, label) {
  console.error(`${label} error:`, e.message);
  res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message });
}

// Generates GET/POST/PUT for one table — wins and blockers differ only by
// table name, validator and sort order, so the routes are built from one
// definition instead of six near-identical handlers.
function registerCrudRoutes(routeName, table, validate, order) {
  app.get(`/api/${routeName}`, requireSupabase, async (req, res) => {
    try {
      res.json(await supabaseRequest('GET', `${table}?select=*&order=${order}`));
    } catch (e) { sendSupabaseError(res, e, routeName); }
  });

  app.post(`/api/${routeName}`, requireSupabase, async (req, res) => {
    const { errors, row } = validate(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    try {
      const created = await supabaseRequest('POST', table, row);
      res.status(201).json(Array.isArray(created) ? created[0] : created);
    } catch (e) { sendSupabaseError(res, e, routeName); }
  });

  app.put(`/api/${routeName}/:id`, requireSupabase, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { errors, row } = validate(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    row.updated_at = new Date().toISOString();
    try {
      const updated = await supabaseRequest('PATCH', `${table}?id=eq.${req.params.id}`, row);
      if (!updated || !updated.length) return res.status(404).json({ error: 'Not found' });
      res.json(updated[0]);
    } catch (e) { sendSupabaseError(res, e, routeName); }
  });

  // No DELETE route by design: entries are corrected by editing, never
  // removed. A blocker that no longer applies is set to Resolved, which
  // hides it from the panel while keeping the record.
}

registerCrudRoutes('airpay-wins', 'wins', validateWin, 'win_date.desc,created_at.desc');
registerCrudRoutes('airpay-blockers', 'blockers', validateBlocker, 'priority.asc,created_at.desc');

// ——— Auth + User Management ———
// Nav ids a user can be granted. Kept in step with NAV_ITEMS in index.html —
// validating against this list stops a typo'd id from being stored as a
// permission that silently matches nothing.
const NAV_IDS = [
  'executive', 'capacity', 'velocity', 'tasks', 'timeline',
  'members', 'jirasync', 'usermgmt',
  'orgchart', 'projectteam',
  'airpay-summary', 'airpay-detail',
  'gov-settings'
];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) {
    return `password must be at least ${MIN_PASSWORD_LEN} characters`;
  }
  return null;
}

// Validates the editable profile fields shared by create and update.
async function validateUserFields(body, { requirePassword }) {
  const errors = [];
  const b = body || {};
  const username = trimmed(b.username).toLowerCase();
  const email = trimmed(b.email).toLowerCase();

  if (!USERNAME_RE.test(username)) {
    errors.push('username must be 3-32 characters, lowercase letters/numbers/._- and start with a letter or number');
  }
  if (!EMAIL_RE.test(email)) errors.push('a valid email is required');

  if (requirePassword) {
    const pwErr = validatePassword(b.password);
    if (pwErr) errors.push(pwErr);
  }

  // Reject project keys that don't exist, so a permission can never point at
  // nothing and look like it was granted.
  let projectKeys = Array.isArray(b.allowed_project_keys) ? b.allowed_project_keys.map(trimmed).filter(Boolean) : [];
  if (projectKeys.length) {
    try {
      const known = new Set(((await ensureProjects()).projects || []).map(p => p.key));
      const unknown = projectKeys.filter(k => !known.has(k));
      if (unknown.length) errors.push(`unknown project keys: ${unknown.join(', ')}`);
    } catch (e) {
      errors.push('could not verify project keys against Jira right now');
    }
  }

  const navIds = Array.isArray(b.allowed_nav_ids) ? b.allowed_nav_ids.map(trimmed).filter(Boolean) : [];
  const unknownNav = navIds.filter(id => !NAV_IDS.includes(id));
  if (unknownNav.length) errors.push(`unknown menu ids: ${unknownNav.join(', ')}`);

  return {
    errors,
    row: {
      username,
      email,
      display_name: trimmed(b.display_name) || null,
      is_admin: b.is_admin === true,
      is_active: b.is_active !== false,
      allowed_project_keys: projectKeys,
      allowed_nav_ids: navIds
    }
  };
}

async function countActiveAdmins() {
  const rows = await supabaseRequest('GET', 'app_users?select=id&is_admin=eq.true&is_active=eq.true');
  return Array.isArray(rows) ? rows.length : 0;
}

app.post('/api/auth/login', requireSupabase, async (req, res) => {
  if (!SESSION_SECRET) {
    return res.status(503).json({ error: 'Server belum dikonfigurasi: SESSION_SECRET belum di-set.' });
  }
  const username = trimmed(req.body?.username).toLowerCase();
  const password = req.body?.password;
  // One generic message for every failure mode — a distinct "no such user"
  // would let anyone enumerate valid usernames.
  const deny = () => res.status(401).json({ error: 'Invalid username or password' });
  if (!username || !password) return deny();

  try {
    const rows = await supabaseRequest('GET', `app_users?username=eq.${encodeURIComponent(username)}&select=*`);
    const user = rows && rows.length ? rows[0] : null;
    if (!user || !user.is_active) return deny();
    if (!verifyPassword(password, user.password_salt, user.password_hash)) return deny();

    const device = parseUserAgent(req.headers['user-agent']);
    await supabaseRequest('PATCH', `app_users?id=eq.${user.id}`, {
      last_login_at: new Date().toISOString(),
      last_login_device: device,
      last_login_user_agent: String(req.headers['user-agent'] || '').slice(0, 500)
    });
    invalidateSessionUser(user.id);

    setSessionCookie(res, signSession(user.id));
    res.json({ user: publicUser({ ...user, last_login_at: new Date().toISOString(), last_login_device: device }) });
  } catch (e) {
    sendSupabaseError(res, e, 'auth/login');
  }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.user) invalidateSessionUser(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/auth/change-password', requireSupabase, async (req, res) => {
  const current = req.body?.current_password;
  const next = req.body?.new_password;
  const pwErr = validatePassword(next);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!verifyPassword(current, req.user.password_salt, req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  try {
    const salt = makeSalt();
    await supabaseRequest('PATCH', `app_users?id=eq.${req.user.id}`, {
      password_salt: salt,
      password_hash: hashPassword(next, salt),
      must_change_password: false,
      updated_at: new Date().toISOString()
    });
    invalidateSessionUser(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    sendSupabaseError(res, e, 'auth/change-password');
  }
});

app.get('/api/users', requireSupabase, requireAdmin, async (req, res) => {
  try {
    res.json(await supabaseRequest('GET', `app_users?select=${USER_PUBLIC_COLS}&order=username.asc`));
  } catch (e) {
    sendSupabaseError(res, e, 'users');
  }
});

app.post('/api/users', requireSupabase, requireAdmin, async (req, res) => {
  const { errors, row } = await validateUserFields(req.body, { requirePassword: true });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const salt = makeSalt();
    const created = await supabaseRequest('POST', `app_users?select=${USER_PUBLIC_COLS}`, {
      ...row,
      password_salt: salt,
      password_hash: hashPassword(req.body.password, salt),
      must_change_password: false
    });
    res.status(201).json(Array.isArray(created) ? created[0] : created);
  } catch (e) {
    // 23505 = unique violation on the username index
    if (e.status === 409 || /duplicate key|23505/i.test(e.message)) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    sendSupabaseError(res, e, 'users');
  }
});

app.put('/api/users/:id', requireSupabase, requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const { errors, row } = await validateUserFields(req.body, { requirePassword: false });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  // Locking yourself out of the app is only recoverable via raw SQL, so the
  // two ways to do it are refused outright.
  if (id === req.user.id && (!row.is_active || !row.is_admin)) {
    return res.status(400).json({ error: 'You cannot deactivate your own account or remove your own admin access' });
  }
  try {
    if (!row.is_active || !row.is_admin) {
      const existing = await supabaseRequest('GET', `app_users?id=eq.${id}&select=is_admin,is_active`);
      const before = existing && existing[0];
      const wasActiveAdmin = before && before.is_admin && before.is_active;
      if (wasActiveAdmin && (await countActiveAdmins()) <= 1) {
        return res.status(400).json({ error: 'This is the last active admin — promote someone else first' });
      }
    }
    row.updated_at = new Date().toISOString();
    const updated = await supabaseRequest('PATCH', `app_users?id=eq.${id}&select=${USER_PUBLIC_COLS}`, row);
    if (!updated || !updated.length) return res.status(404).json({ error: 'Not found' });
    invalidateSessionUser(id);
    res.json(updated[0]);
  } catch (e) {
    if (e.status === 409 || /duplicate key|23505/i.test(e.message)) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    sendSupabaseError(res, e, 'users');
  }
});

// Admin resets someone else's password without knowing the old one, then that
// user is prompted to set their own on next sign-in.
app.put('/api/users/:id/password', requireSupabase, requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const pwErr = validatePassword(req.body?.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const salt = makeSalt();
    const updated = await supabaseRequest('PATCH', `app_users?id=eq.${id}&select=id`, {
      password_salt: salt,
      password_hash: hashPassword(req.body.password, salt),
      must_change_password: true,
      updated_at: new Date().toISOString()
    });
    if (!updated || !updated.length) return res.status(404).json({ error: 'Not found' });
    invalidateSessionUser(id);
    res.json({ ok: true });
  } catch (e) {
    sendSupabaseError(res, e, 'users/password');
  }
});

// Reference list for the "pick a task" dropdown in both forms. /api/sync-status
// can't serve this: its JQL is capped at `updated >= 7 days`, maxResults=100,
// then sliced to 50 across up to 30 projects. /api/tasks can't either — it
// always ANDs an assignee filter, so unassigned AIRPAY issues would vanish.
const AIRPAY_JIRA_PROJECT = 'AIRPAY';

app.get('/api/airpay-issues', async (req, res) => {
  try {
    if (isFresh('airpayIssues') && cache.airpayIssues) return res.json(cache.airpayIssues);
    const issues = await jiraSearchAll(`project = ${AIRPAY_JIRA_PROJECT} ORDER BY updated DESC`, 'summary');
    const list = issues.map(i => ({ key: i.key, summary: i.fields?.summary || '' }));
    cache.airpayIssues = list;
    cache.ts.airpayIssues = Date.now();
    res.json(list);
  } catch (e) {
    console.error('airpay-issues error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ——— Governance — Phase 2: Jira project sync + admin tracking ———
// projects/teams/etc. live in Supabase (see governance migration). This is a
// separate concept from ensureProjects()/cache.projects above: that mirrors a
// filtered, 8-category slice of Jira for the Capacity/Timeline/Velocity
// selectors; this mirrors ALL 90 Jira projects for compliance tracking. They
// intentionally do not share a cache or an endpoint.
const GOV_KEY_RE = /^[A-Z][A-Z0-9_]{1,15}$/;

// /rest/api/3/project (used by ensureProjects) returns 174 rows on this site,
// 84 of them archived — it has no `archived` filter. /rest/api/3/project/search
// excludes archived projects and returns exactly the 90 live ones the spec
// describes, via classic startAt/total pagination (not the token pagination
// jiraSearchAll uses for issue search).
async function jiraFetchAllProjects() {
  const all = [];
  let startAt = 0;
  const pageSize = 100;
  while (true) {
    const data = await jiraGet(`/rest/api/3/project/search?maxResults=${pageSize}&startAt=${startAt}`);
    const values = data.values || [];
    all.push(...values);
    if (data.isLast || !values.length || all.length >= data.total) break;
    startAt += pageSize;
  }
  return all.map(p => ({
    jira_id: p.id,
    key: p.key,
    name: p.name,
    category: p.projectCategory?.name || null
  }));
}

// Upserts by key (never touching is_tracked — invariant 6), detects renames by
// jira_id so history/FKs migrate via ON UPDATE CASCADE instead of orphaning,
// and marks projects absent from Jira inactive rather than deleting them
// (invariant 7 — submissions/wins/blockers may still point at the key).
async function syncProjectsFromJira() {
  const [live, existingRows] = await Promise.all([
    jiraFetchAllProjects(),
    supabaseRequest('GET', 'projects?select=key,jira_id,is_active')
  ]);

  const existingByJiraId = new Map((existingRows || []).filter(r => r.jira_id).map(r => [r.jira_id, r]));
  const existingKeys = new Set((existingRows || []).map(r => r.key));
  const activeKeysBefore = new Set((existingRows || []).filter(r => r.is_active).map(r => r.key));

  const now = new Date().toISOString();
  const renames = [];
  const upsertRows = [];
  const seenKeys = new Set();

  for (const p of live) {
    seenKeys.add(p.key);
    const existing = p.jira_id ? existingByJiraId.get(p.jira_id) : null;
    if (existing && existing.key !== p.key) {
      // Same Jira project, different key — a rename, not a new project.
      // UPDATE the primary key directly so every FK (compliance_policies,
      // submissions, wins, blockers, ...) cascades via ON UPDATE CASCADE.
      renames.push({ from: existing.key, to: p.key });
      await supabaseRequest('PATCH', `projects?key=eq.${encodeURIComponent(existing.key)}`, {
        key: p.key, name: p.name, jira_id: p.jira_id, category: p.category,
        is_active: true, last_synced_at: now, updated_at: now
      });
      activeKeysBefore.delete(existing.key); // handled — exclude from the deactivate pass below
    } else {
      upsertRows.push({
        key: p.key, name: p.name, jira_id: p.jira_id, category: p.category,
        is_active: true, last_synced_at: now
      });
    }
  }

  const created = upsertRows.filter(r => !existingKeys.has(r.key)).length;
  const updated = upsertRows.length - created;
  if (upsertRows.length) {
    // merge-duplicates only overwrites the columns present in this payload —
    // is_tracked, tracked_from, team_id, parser_profile are never sent here,
    // so an upsert can never touch an admin's tracking decision.
    await supabaseRequest('POST', 'projects?on_conflict=key', upsertRows, 'resolution=merge-duplicates,return=minimal');
  }

  const toDeactivate = [...activeKeysBefore].filter(k => !seenKeys.has(k));
  if (toDeactivate.length) {
    const inList = toDeactivate.map(k => `"${k}"`).join(',');
    await supabaseRequest('PATCH', `projects?key=in.(${inList})`, { is_active: false, updated_at: now });
  }

  return { total: live.length, created, updated, renamed: renames, deactivated: toDeactivate };
}

app.post('/api/governance/projects/sync', requireSupabase, requireAdmin, async (req, res) => {
  try {
    const result = await syncProjectsFromJira();
    console.log('governance project sync:', JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('governance/projects/sync error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// List for both the Settings page (admin) and, later, the Submit page's
// project dropdown. Non-admins only ever see their allowed_project_keys
// (invariant 8's dropdown scoping) — enforced here, not just in the UI.
app.get('/api/governance/projects', requireSupabase, async (req, res) => {
  try {
    const params = [`select=*&order=key.asc`];
    if (req.query.tracked === 'true') params.push('is_tracked=eq.true');
    if (req.query.tracked === 'false') params.push('is_tracked=eq.false');
    if (req.query.active !== 'all') params.push('is_active=eq.true'); // default: hide inactive
    if (req.query.team_id) params.push(`team_id=eq.${encodeURIComponent(req.query.team_id)}`);
    // Governance Settings scopes its list to the same 9 categories the
    // Dashboard menus use (TARGET_CATEGORIES), rather than every category
    // Jira happens to have — a deliberate product decision (2026-08-05) to
    // keep the compliance-tracking list focused on categories the rest of
    // the app already treats as "real" projects. Governance's own
    // `projects` table still mirrors ALL of Jira underneath; this only
    // narrows what this particular list endpoint call returns.
    if (req.query.categories === 'dashboard') {
      // The whole in.(...) value must be URL-encoded as one unit — several
      // category names contain "&" (e.g. "Surat Sakit & Cepat Sehat"),
      // which otherwise gets read as a query-string separator and corrupts
      // the filter before PostgREST ever sees it.
      const catList = TARGET_CATEGORIES.map(c => `"${c}"`).join(',');
      params.push(`category=${encodeURIComponent(`in.(${catList})`)}`);
    }
    if (req.query.q) {
      // Strip characters PostgREST's or() filter treats as syntax (commas,
      // parens) so a stray character in a search box can't produce a
      // confusing 400 from a malformed filter expression.
      const safe = String(req.query.q).replace(/[(),]/g, '').trim();
      if (safe) {
        const q = encodeURIComponent(`*${safe}*`);
        params.push(`or=(key.ilike.${q},name.ilike.${q})`);
      }
    }
    let rows = await supabaseRequest('GET', `projects?${params.join('&')}`);
    if (!req.user.is_admin) {
      const allowed = new Set(req.user.allowed_project_keys || []);
      rows = (rows || []).filter(p => allowed.has(p.key));
    }
    res.json(rows);
  } catch (e) {
    sendSupabaseError(res, e, 'governance/projects');
  }
});

app.get('/api/governance/teams', requireSupabase, async (req, res) => {
  try {
    res.json(await supabaseRequest('GET', 'teams?select=*&order=name.asc'));
  } catch (e) {
    sendSupabaseError(res, e, 'governance/teams');
  }
});

// Whether/when a project counts toward compliance is an admin decision made
// here — sync() above never touches it (invariant 6).
app.put('/api/governance/projects/:key/tracking', requireSupabase, requireAdmin, async (req, res) => {
  const key = req.params.key;
  if (!GOV_KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid project key' });
  const isTracked = req.body?.is_tracked === true;
  let trackedFrom = trimmed(req.body?.tracked_from) || null;
  if (trackedFrom && !ISO_DATE_RE.test(trackedFrom)) {
    return res.status(400).json({ error: 'tracked_from must be YYYY-MM-DD' });
  }
  // Turning tracking on with no start date would leave ensure_periods() (Phase
  // 6/§4) with nothing to anchor to — default it to today rather than 400ing
  // on the single most common path through this form.
  if (isTracked && !trackedFrom) trackedFrom = new Date().toISOString().slice(0, 10);
  try {
    const updated = await supabaseRequest(
      'PATCH',
      `projects?key=eq.${encodeURIComponent(key)}&select=*`,
      { is_tracked: isTracked, tracked_from: trackedFrom, updated_at: new Date().toISOString() }
    );
    if (!updated || !updated.length) return res.status(404).json({ error: 'Project not found' });
    res.json(updated[0]);
  } catch (e) {
    sendSupabaseError(res, e, 'governance/projects/tracking');
  }
});

// ——— Governance — per-project team members (Settings "Edit" button) ———
// Membership lives in its own table rather than reusing allowed_project_keys
// on app_users: that column gates dashboard/submit *access*, while this is
// just "who's on this project" metadata for the Settings page — someone can
// be listed here without ever being granted app access, and vice versa.
// Members here are the Jira roster (STATE.members / GET /api/members — the
// same "Team Members" page uses), identified by Jira accountId, NOT
// app_users login accounts. Jira members aren't mirrored into a Supabase
// table, so there's nothing to embed here — the client cross-references
// member_account_id against its already-loaded members list for display.
const TEAM_MEMBER_SELECT = 'id,member_account_id,is_active,added_at,added_by';
// Jira accountIds look like "712020:<uuid>" or occasionally a bare token
// (e.g. seed/test data) — loose but still injection-safe for use in a
// PostgREST eq. filter and a URL path segment.
const MEMBER_ACCOUNT_ID_RE = /^[A-Za-z0-9:_-]{1,100}$/;

app.get('/api/governance/projects/:key/team', requireSupabase, requireAdmin, async (req, res) => {
  const key = req.params.key;
  if (!GOV_KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid project key' });
  try {
    const rows = await supabaseRequest('GET',
      `project_team_members?project_key=eq.${encodeURIComponent(key)}&select=${TEAM_MEMBER_SELECT}&order=added_at.asc`);
    res.json(rows);
  } catch (e) {
    sendSupabaseError(res, e, 'governance/projects/team');
  }
});

// Adds one or more Jira members to a project's team. Already-assigned
// members are silently skipped (idempotent) — the modal re-submits its
// whole current selection on every save, so a repeat isn't an error. A
// member who has already submitted for this project can still be
// added/removed here; this table doesn't gate submission history, it's
// purely a roster.
app.post('/api/governance/projects/:key/team', requireSupabase, requireAdmin, async (req, res) => {
  const key = req.params.key;
  if (!GOV_KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid project key' });
  const memberIds = [...new Set(Array.isArray(req.body?.member_account_ids) ? req.body.member_account_ids : [])]
    .filter(id => MEMBER_ACCOUNT_ID_RE.test(id));
  if (!memberIds.length) return res.status(400).json({ error: 'member_account_ids must be a non-empty array of Jira account ids' });
  try {
    const rows = memberIds.map(member_account_id => ({ project_key: key, member_account_id, added_by: req.user.id }));
    const created = await supabaseRequest(
      'POST',
      `project_team_members?on_conflict=project_key,member_account_id&select=${TEAM_MEMBER_SELECT}`,
      rows,
      'resolution=ignore-duplicates,return=representation'
    );
    res.status(201).json(created);
  } catch (e) {
    sendSupabaseError(res, e, 'governance/projects/team');
  }
});

// Toggles one member's active flag. Rows are never deleted from here —
// deactivating keeps added_at/added_by history intact instead of losing who
// was on a project and when.
app.put('/api/governance/projects/:key/team/:accountId', requireSupabase, requireAdmin, async (req, res) => {
  const key = req.params.key;
  const accountId = req.params.accountId;
  if (!GOV_KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid project key' });
  if (!MEMBER_ACCOUNT_ID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid member account id' });
  try {
    const updated = await supabaseRequest(
      'PATCH',
      `project_team_members?project_key=eq.${encodeURIComponent(key)}&member_account_id=eq.${encodeURIComponent(accountId)}&select=${TEAM_MEMBER_SELECT}`,
      { is_active: req.body?.is_active === true }
    );
    if (!updated || !updated.length) return res.status(404).json({ error: 'Not a team member of this project' });
    res.json(updated[0]);
  } catch (e) {
    sendSupabaseError(res, e, 'governance/projects/team');
  }
});

// ——— Governance — Phase 3: personalized templates + Storage ———
const GOV_BUCKET = 'compliance';
const GOV_PERIOD_TYPES = ['weekly', 'monthly'];

// Signed URL for a private-bucket object, generated server-side after an
// authz check — the object path is never handed to the client directly
// (invariant 21). Not exercised yet (no submission files exist until
// Phase 4), but established now so the storage path convention is fixed
// from day one: compliance/{project_key}/{period_type}/{period_start}/...
async function getSignedStorageUrl(objectPath, ttlSeconds = 60) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${GOV_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: ttlSeconds })
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.message || `Storage responded ${r.status}`);
  return `${SUPABASE_URL}/storage/v1${json.signedURL}`;
}

// Shared by both template endpoints: resolve + authorize the project, load
// its parser profile, and compute the period. Throws { status, message } so
// callers can respond uniformly.
async function resolveTemplateContext(req) {
  const projectKey = trimmed(req.query.project_key).toUpperCase();
  const periodStart = trimmed(req.query.period_start);
  const periodType = trimmed(req.query.period_type) || 'weekly';

  if (!GOV_KEY_RE.test(projectKey)) throw { status: 400, message: 'project_key is required and must look like a Jira key' };
  if (!ISO_DATE_RE.test(periodStart)) throw { status: 400, message: 'period_start is required as YYYY-MM-DD' };
  if (!GOV_PERIOD_TYPES.includes(periodType)) throw { status: 400, message: `period_type must be one of: ${GOV_PERIOD_TYPES.join(', ')}` };

  // Re-verify against the session, not the query string (invariant 19) — the
  // dropdown that will eventually drive this is a convenience, not a boundary.
  if (!req.user.is_admin && !(req.user.allowed_project_keys || []).includes(projectKey)) {
    throw { status: 403, message: `You do not have access to project ${projectKey}` };
  }

  const projects = await supabaseRequest('GET', `projects?key=eq.${encodeURIComponent(projectKey)}&select=*`);
  const project = projects && projects[0];
  if (!project) throw { status: 404, message: `Project ${projectKey} not found. Try syncing from Jira first.` };

  const profiles = await supabaseRequest('GET', `parser_profiles?code=eq.${encodeURIComponent(project.parser_profile)}&select=*`);
  const parserProfile = profiles && profiles[0];
  if (!parserProfile) throw { status: 500, message: `Parser profile "${project.parser_profile}" is not configured` };

  let teamSlug = '';
  if (project.team_id) {
    const teams = await supabaseRequest('GET', `teams?id=eq.${project.team_id}&select=slug`);
    teamSlug = teams && teams[0] ? teams[0].slug : '';
  }

  const periodEnd = computePeriodEnd(periodType, periodStart);
  return { project, parserProfile, periodType, periodStart, periodEnd, teamSlug };
}

app.get('/api/templates/checklist', requireSupabase, async (req, res) => {
  try {
    const ctx = await resolveTemplateContext(req);
    const wb = await buildChecklistWorkbook({
      project: ctx.project, periodType: ctx.periodType, periodStart: ctx.periodStart,
      periodEnd: ctx.periodEnd, parserProfile: ctx.parserProfile,
      submittedByEmail: req.user.email, teamSlug: ctx.teamSlug
    });
    const buffer = await wb.xlsx.writeBuffer();
    const filename = checklistFileName(ctx.project.key, ctx.periodType, ctx.periodStart, ctx.parserProfile.schema_version);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('templates/checklist error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/templates/mom', requireSupabase, async (req, res) => {
  try {
    const ctx = await resolveTemplateContext(req);
    const md = buildMomMarkdown({
      project: ctx.project, periodType: ctx.periodType, periodStart: ctx.periodStart,
      periodEnd: ctx.periodEnd, submittedByEmail: req.user.email, teamSlug: ctx.teamSlug,
      schemaVersion: ctx.parserProfile.schema_version
    });
    const filename = momFileName(ctx.project.key, ctx.periodType, ctx.periodStart);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(md);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('templates/mom error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ——— Governance — Phase 4: submission upload + layered validation ———
//
// Deviation from the spec's literal 1-6 ordering, flagged deliberately:
// the spec lists "5. project_key ada di allowed_project_keys milik SESSION"
// AFTER "4. project_key di file == project_key yang dipilih" — i.e. after
// the file has already been parsed. This implementation checks session
// authorization FIRST, before touching the file at all: it's a near-free
// Set lookup, and doing it first means an unauthorized request never causes
// this server to parse a stranger's file. Every USER-VISIBLE outcome for a
// single-failure request is unchanged (403 for authz, 422 for the file
// layers, 409 for a duplicate) — the only case that differs is a request
// that fails BOTH authz and a file layer, which now reports 403 first
// instead of 422 first. See CLAUDE.md.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const GOV_KINDS = ['checklist', 'mom'];
const GOV_EXT_BY_KIND = { checklist: ['xlsx', 'xls'], mom: ['docx', 'pdf', 'md', 'txt'] };
const GOV_MAGIC_BYTES = {
  xlsx: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04 (zip/OOXML)
  docx: [0x50, 0x4b, 0x03, 0x04],
  xls: [0xd0, 0xcf, 0x11, 0xe0],  // OLE2 compound file (legacy BIFF)
  pdf: [0x25, 0x50, 0x44, 0x46]   // %PDF
};

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
function magicBytesMatch(buffer, ext) {
  const sig = GOV_MAGIC_BYTES[ext];
  if (!sig) return true; // md/txt: no reliable magic number, checked as plain text below instead
  if (buffer.length < sig.length) return false;
  return sig.every((b, i) => buffer[i] === b);
}
// .md/.txt have no magic number — the closest thing to a signature check is
// confirming it isn't binary garbage wearing a text extension.
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 1024);
  return !sample.includes(0x00);
}

async function uploadToStorage(objectPath, buffer, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${GOV_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false'
    },
    body: buffer
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.message || `Storage upload responded ${r.status}`);
  return json;
}
async function deleteFromStorage(objectPaths) {
  if (!objectPaths.length) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${GOV_BUCKET}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: objectPaths })
  }).catch(e => console.warn('deleteFromStorage: cleanup failed (orphaned object, harmless):', e.message));
}

function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150);
}

// No admin UI for compliance_policies exists yet, so a project's first
// upload provisions a sensible default policy rather than requiring one to
// already exist — otherwise Phase 4 would be untestable end to end until a
// policies-management phase is built. Friday 17:00 Asia/Jakarta, 1/3-day
// warn/late thresholds.
const DEFAULT_POLICY = { due_dow: 5, due_dom: 5, due_time: '17:00:00', timezone: 'Asia/Jakarta', warn_after_days: 1, late_after_days: 3 };
// Asia/Jakarta has no DST, so a fixed offset is correct (not a general IANA
// tz solution — fine while every policy uses this one zone).
const TZ_OFFSET_HOURS = { 'Asia/Jakarta': 7 };

async function ensureDefaultPolicy(projectKey, periodType) {
  const existing = await supabaseRequest('GET', `compliance_policies?project_key=eq.${encodeURIComponent(projectKey)}&period_type=eq.${periodType}&select=*`);
  if (existing && existing.length) return existing[0];
  const created = await supabaseRequest('POST', 'compliance_policies', {
    project_key: projectKey, period_type: periodType,
    due_dow: periodType === 'weekly' ? DEFAULT_POLICY.due_dow : null,
    due_dom: periodType === 'monthly' ? DEFAULT_POLICY.due_dom : null,
    due_time: DEFAULT_POLICY.due_time, timezone: DEFAULT_POLICY.timezone,
    warn_after_days: DEFAULT_POLICY.warn_after_days, late_after_days: DEFAULT_POLICY.late_after_days
  });
  return Array.isArray(created) ? created[0] : created;
}

function computeDueAt(periodType, periodStart, policy) {
  const offsetHours = TZ_OFFSET_HOURS[policy.timezone] ?? 0;
  const [hh, mm] = String(policy.due_time || '17:00:00').split(':').map(Number);
  let due;
  if (periodType === 'monthly') {
    const start = new Date(`${periodStart}T00:00:00Z`);
    const lastDom = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const dom = Math.min(policy.due_dom || 5, lastDom);
    due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), dom, hh, mm));
  } else {
    const start = new Date(`${periodStart}T00:00:00Z`);
    const dueDow = policy.due_dow || 5;
    const startDow = start.getUTCDay() || 7; // Mon=1..Sun=7
    due = new Date(start);
    due.setUTCDate(due.getUTCDate() + ((dueDow - startDow + 7) % 7));
    due.setUTCHours(hh, mm, 0, 0);
  }
  due.setUTCHours(due.getUTCHours() - offsetHours); // local wall-clock -> UTC instant
  return due.toISOString();
}

// Which period is "current" depends on the policy's calendar, not the
// server's raw UTC clock — reuses computeDueAt's same fixed-offset
// simplification (Asia/Jakarta only, no DST) rather than a full IANA
// timezone dependency. Weekly periods anchor to Monday (matches every
// period this app has ever generated); monthly anchors to the 1st.
function currentPeriodStart(periodType, timezone) {
  const offsetHours = TZ_OFFSET_HOURS[timezone] ?? 0;
  const local = new Date(Date.now() + offsetHours * 3600000);
  if (periodType === 'monthly') {
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }
  const dow = local.getUTCDay() || 7; // Mon=1..Sun=7
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (dow - 1)));
  return monday.toISOString().slice(0, 10);
}

// The Compliance Board (§9.3) needs a fixed run of period_starts (oldest
// first) ending at the current one, regardless of whether anyone has
// visited/uploaded for those weeks yet — a project that missed 3 weeks
// must show 3 red cells, not 3 blank ones.
function periodStartsBack(periodType, timezone, count) {
  const starts = [];
  let cur = currentPeriodStart(periodType, timezone);
  for (let i = 0; i < count; i++) {
    starts.unshift(cur);
    const d = new Date(`${cur}T00:00:00Z`);
    if (periodType === 'monthly') d.setUTCMonth(d.getUTCMonth() - 1);
    else d.setUTCDate(d.getUTCDate() - 7);
    cur = d.toISOString().slice(0, 10);
  }
  return starts;
}

// Periods are generated lazily (§4) — created on first use, idempotent via
// the (project_key, period_type, period_start) unique constraint.
async function ensurePeriod(projectKey, periodType, periodStart) {
  const existing = await supabaseRequest('GET',
    `compliance_periods?project_key=eq.${encodeURIComponent(projectKey)}&period_type=eq.${periodType}&period_start=eq.${periodStart}&select=*`);
  if (existing && existing.length) return existing[0];
  const policy = await ensureDefaultPolicy(projectKey, periodType);
  const created = await supabaseRequest('POST', 'compliance_periods', {
    project_key: projectKey, policy_id: policy.id, period_type: periodType,
    period_start: periodStart, period_end: computePeriodEnd(periodType, periodStart),
    due_at: computeDueAt(periodType, periodStart, policy)
  });
  return Array.isArray(created) ? created[0] : created;
}

// Drives the Submit page drawer's step 2 (§9.1: period is read-only, derived
// from policy — never manually pickable). Ensures the policy and the current
// period both exist (same lazy-generation the upload path already relies on)
// and reads state from v_compliance_status rather than recomputing
// compliance_state() logic here — that function is the one and only place
// on/late/orange/red is decided (invariant).
app.get('/api/governance/current-period', requireSupabase, async (req, res) => {
  try {
    const projectKey = trimmed(req.query.project_key).toUpperCase();
    const periodType = trimmed(req.query.period_type) || 'weekly';
    if (!GOV_KEY_RE.test(projectKey)) return res.status(400).json({ error: 'project_key is required and must look like a Jira key' });
    if (!GOV_PERIOD_TYPES.includes(periodType)) return res.status(400).json({ error: `period_type must be one of: ${GOV_PERIOD_TYPES.join(', ')}` });
    if (!req.user.is_admin && !(req.user.allowed_project_keys || []).includes(projectKey)) {
      return res.status(403).json({ error: `You do not have access to project ${projectKey}` });
    }

    const policy = await ensureDefaultPolicy(projectKey, periodType);
    const periodStart = currentPeriodStart(periodType, policy.timezone);
    const period = await ensurePeriod(projectKey, periodType, periodStart);

    const statusRows = await supabaseRequest('GET', `v_compliance_status?period_id=eq.${period.id}&select=*`);
    const status = statusRows && statusRows[0];

    // Which kinds the period's active submission already has — the drawer's
    // upload step (step 3) uses this to warn "this replaces your existing
    // file" instead of silently superseding it (§5.4).
    let existingFiles = [];
    if (status && status.submission_id) {
      existingFiles = await supabaseRequest('GET',
        `submission_files?submission_id=eq.${status.submission_id}&select=kind,file_name,parse_status`);
    }

    res.json({
      project_key: projectKey,
      period_type: periodType,
      period_start: periodStart,
      period_end: period.period_end,
      due_at: period.due_at,
      week_label: weekLabel(periodType, periodStart),
      // No compliance_periods row can exist without also having gone through
      // ensureDefaultPolicy/ensurePeriod above, so status is only ever
      // missing here if v_compliance_status's own is_tracked/is_active
      // filter excludes this project — treat that the same as "nothing
      // submitted yet" rather than erroring the drawer over it.
      state: status ? status.state : 'pending',
      days_late: status ? status.days_late : 0,
      submission_id: status ? status.submission_id : null,
      existing_files: existingFiles
    });
  } catch (e) {
    sendSupabaseError(res, e, 'governance/current-period');
  }
});

// The Compliance Board (§9.3) — grid of project × week state, plus the
// current week's per-project wins/blockers/dependencies counts. Ensures
// every expected period in the requested range exists (same lazy
// generation the upload path uses) BEFORE reading v_compliance_status —
// without this, weeks nobody has visited yet would show as gaps instead
// of the red/orange cells they actually are.
app.get('/api/compliance', requireSupabase, async (req, res) => {
  try {
    const periodType = trimmed(req.query.period_type) || 'weekly';
    if (!GOV_PERIOD_TYPES.includes(periodType)) return res.status(400).json({ error: `period_type must be one of: ${GOV_PERIOD_TYPES.join(', ')}` });
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 26);
    const projectKeyFilter = trimmed(req.query.project_key).toUpperCase();
    const teamIdFilter = trimmed(req.query.team_id);

    let projects = await supabaseRequest('GET', 'projects?is_tracked=eq.true&is_active=eq.true&select=key,name,category,team_id&order=key.asc');
    if (!req.user.is_admin) {
      const allowed = new Set(req.user.allowed_project_keys || []);
      projects = (projects || []).filter(p => allowed.has(p.key));
    }
    if (projectKeyFilter) projects = projects.filter(p => p.key === projectKeyFilter);
    if (teamIdFilter) projects = projects.filter(p => p.team_id === teamIdFilter);
    if (!projects.length) return res.json({ period_type: periodType, period_starts: [], projects: [], rows: [] });

    // All policies share DEFAULT_POLICY's timezone today (no per-project
    // timezone override exists yet), so the period-start run is the same
    // for every project — compute it once rather than per project.
    const periodStarts = periodStartsBack(periodType, DEFAULT_POLICY.timezone, weeks);
    for (const p of projects) {
      for (const ps of periodStarts) {
        await ensurePeriod(p.key, periodType, ps); // idempotent; cheap once the row already exists
      }
    }

    const keysParam = projects.map(p => encodeURIComponent(p.key)).join(',');
    const rows = await supabaseRequest('GET',
      `v_compliance_status?project_key=in.(${keysParam})&period_type=eq.${periodType}` +
      `&period_start=gte.${periodStarts[0]}&period_start=lte.${periodStarts[periodStarts.length - 1]}` +
      `&select=*&order=period_start.asc`);

    // Bulk-computed, not per-row: only the (small) set of submissions in
    // this window matters, so one fetch per table beats N+1 per cell.
    const subIds = [...new Set((rows || []).filter(r => r.submission_id).map(r => r.submission_id))];
    const winCounts = {}, blockerOpen = {}, depOpen = {};
    if (subIds.length) {
      const idsParam = subIds.join(',');
      const [winsRows, blkRows, depRows] = await Promise.all([
        supabaseRequest('GET', `wins?submission_id=in.(${idsParam})&select=submission_id`),
        supabaseRequest('GET', `blockers?submission_id=in.(${idsParam})&select=submission_id,status`),
        supabaseRequest('GET', `dependencies?submission_id=in.(${idsParam})&select=submission_id,status`)
      ]);
      (winsRows || []).forEach(w => { winCounts[w.submission_id] = (winCounts[w.submission_id] || 0) + 1; });
      (blkRows || []).forEach(b => { if (b.status !== 'Resolved') blockerOpen[b.submission_id] = (blockerOpen[b.submission_id] || 0) + 1; });
      (depRows || []).forEach(d => { if (d.status !== 'Resolved') depOpen[d.submission_id] = (depOpen[d.submission_id] || 0) + 1; });
    }

    const out = (rows || []).map(r => ({
      period_id: r.period_id, project_key: r.project_key, project_name: r.project_name,
      category: r.category, team_id: r.team_id, team_name: r.team_name,
      period_type: r.period_type, period_start: r.period_start, period_end: r.period_end,
      due_at: r.due_at, submission_id: r.submission_id, uploaded_at: r.uploaded_at,
      parse_status: r.parse_status, state: r.state, days_late: r.days_late,
      counts: r.submission_id
        ? { wins: winCounts[r.submission_id] || 0, blockers_open: blockerOpen[r.submission_id] || 0, dependencies_open: depOpen[r.submission_id] || 0 }
        : null
    }));

    res.json({
      period_type: periodType,
      period_starts: periodStarts,
      projects: projects.map(p => ({ key: p.key, name: p.name, category: p.category, team_id: p.team_id })),
      rows: out
    });
  } catch (e) {
    sendSupabaseError(res, e, 'compliance');
  }
});

// 'new': no active submission exists for this period yet.
// 'add': one exists but doesn't have this file's kind yet (§5.4 — checklist
//        now, MoM later, is not a re-upload).
// 'supersede': one exists and already has this kind — a genuine re-upload.
//        The OTHER kind's file, if any, is NOT carried over to the new
//        submission (a simpler, more conservative reading of an edge case
//        the spec leaves open — see CLAUDE.md); the filler would need to
//        re-upload it too if it's still current.
async function resolveSubmissionForUpload(periodId, kind) {
  const subs = await supabaseRequest('GET',
    `submissions?period_id=eq.${periodId}&superseded_by=is.null&select=*,submission_files(kind)`);
  const active = subs && subs[0];
  if (!active) return { mode: 'new', existingSubmission: null };
  const hasKind = (active.submission_files || []).some(f => f.kind === kind);
  return hasKind ? { mode: 'supersede', existingSubmission: active } : { mode: 'add', existingSubmission: active };
}

function templateMismatchBody(parserProfile, differences, metaFields, project, periodType, periodStart, kind) {
  return {
    error: 'template_mismatch',
    expected: { schema_version: parserProfile.schema_version, parser_profile: parserProfile.code },
    found: { schema_version: metaFields?.schema_version || null, parser_profile: metaFields?.parser_profile || null },
    differences,
    download_url: kind === 'mom'
      ? `/api/templates/mom?project_key=${project.key}&period_start=${periodStart}&period_type=${periodType}`
      : `/api/templates/checklist?project_key=${project.key}&period_start=${periodStart}&period_type=${periodType}`
  };
}

async function writeSubmissionEvents(submissionId, actorId, events) {
  const rows = events.map(([event, level, detail]) => ({
    submission_id: submissionId, actor_id: actorId, event, level: level || 'ok', detail: detail || null
  }));
  await supabaseRequest('POST', 'submission_events', rows, 'return=minimal');
}

// wins.category is a lookup table specifically so new codes don't require a
// parser/profile change (see CLAUDE.md) — the checklist parser must ask this
// table live, never validate against a list baked into the profile or code.
async function getActiveWinCategories() {
  const rows = await supabaseRequest('GET', 'win_categories?is_active=eq.true&select=code');
  return new Set((rows || []).map(r => r.code));
}

// Phase 5: deterministic checklist parsing, run synchronously as part of the
// upload request rather than fired-and-forgotten afterward. The spec frames
// this as an async Edge Function ("status UI langsung green, tidak menunggu
// parsing selesai") — deliberately not followed here: on Vercel's serverless
// runtime, work started after res.json() has no guarantee of running to
// completion once the function's invocation ends, which would leave
// parse_status stuck at 'pending' forever with no error surfaced anywhere.
// A single small checklist parses in milliseconds, so blocking the response
// is not a real UX cost. `state` is unaffected either way (invariant 2) —
// only `parse_status` in the response reflects the real, synchronous result
// instead of always reporting 'pending'.
async function insertTableRows(tableRows, submission, projectKey, sourceKind) {
  const stamp = row => ({ ...row, submission_id: submission.id, project_key: projectKey, source: 'upload', source_kind: sourceKind });
  await Promise.all([
    tableRows.wins.length ? supabaseRequest('POST', 'wins', tableRows.wins.map(stamp), 'return=minimal') : null,
    tableRows.blockers.length ? supabaseRequest('POST', 'blockers', tableRows.blockers.map(stamp), 'return=minimal') : null,
    tableRows.dependencies.length ? supabaseRequest('POST', 'dependencies', tableRows.dependencies.map(stamp), 'return=minimal') : null,
    tableRows.todos.length ? supabaseRequest('POST', 'todos', tableRows.todos.map(stamp), 'return=minimal') : null
  ].filter(Boolean));
}

// Shared by both parsers (§6): folds this file's own contribution into
// submissions.analysis, then — if the submission's OTHER kind is already
// parsed too — runs the checklist/MoM merge (§5.5) and records its result
// in the same analysis object. Whichever file parses SECOND is what
// actually triggers a merge; the first one just contributes its own counts.
async function finalizeSubmissionParse(submission, fileRow, kind, contribution) {
  const { unmappedRows, warnings, counts } = contribution;
  const sourceFormat = kind === 'checklist' ? 'xlsx' : 'md';
  const parseMethod = kind === 'checklist' ? 'column' : 'markdown';

  const existingRows = await supabaseRequest('GET', `submissions?id=eq.${submission.id}&select=analysis`);
  const prior = (existingRows && existingRows[0] && existingRows[0].analysis) || {};

  const analysis = {
    schema_version: 1,
    parse_method: prior.files && prior.files.length ? 'hybrid' : parseMethod,
    parsed_at: new Date().toISOString(),
    source_format: prior.source_format && prior.source_format !== sourceFormat ? 'hybrid' : sourceFormat,
    files: [...(prior.files || []).filter(f => f.kind !== kind), { kind, name: fileRow.file_name, method: parseMethod }],
    counts_by_source: { ...(prior.counts_by_source || {}), [kind]: counts },
    unmapped_rows: [...(prior.unmapped_rows || []).filter(u => u.source_kind !== kind), ...unmappedRows.map(u => ({ ...u, source_kind: kind }))],
    warnings: [...(prior.warnings || []).filter(w => !w.startsWith(`[${kind}]`)), ...warnings.map(w => `[${kind}] ${w}`)],
    counts, // provisional — replaced below if a merge runs
    merged: prior.merged || [],
    possible_duplicates: prior.possible_duplicates || []
  };

  const otherKind = kind === 'checklist' ? 'mom' : 'checklist';
  const otherFiles = await supabaseRequest('GET',
    `submission_files?submission_id=eq.${submission.id}&kind=eq.${otherKind}&parse_status=eq.done&select=id`);
  if (otherFiles && otherFiles.length) {
    const { merged, possibleDuplicates, counts: mergedCounts } = await mergeSubmission(supabaseRequest, submission.id);
    analysis.merged = merged;
    analysis.possible_duplicates = possibleDuplicates;
    analysis.counts = mergedCounts;
  }

  await supabaseRequest('PATCH', `submissions?id=eq.${submission.id}`, { parse_status: 'done', analysis, parse_error: null }, 'return=minimal');
  return analysis;
}

async function runChecklistParse(submission, projectKey, fileRow, buffer, parserProfile) {
  try {
    const winCategories = await getActiveWinCategories();
    const contribution = await parseChecklistWorkbook(buffer, parserProfile, winCategories);
    await insertTableRows(contribution.tableRows, submission, projectKey, 'checklist');
    await supabaseRequest('PATCH', `submission_files?id=eq.${fileRow.id}`, { parse_status: 'done', parse_method: 'column' }, 'return=minimal');
    const analysis = await finalizeSubmissionParse(submission, fileRow, 'checklist', contribution);
    return { parse_status: 'done', counts: analysis.counts, unmapped_rows: contribution.unmappedRows.length, warnings: contribution.warnings, merged: analysis.merged, possible_duplicates: analysis.possible_duplicates };
  } catch (e) {
    // A genuine failure here (not a bad cell — those are unmapped_rows, not
    // exceptions) must never surface as a 5xx on the upload itself: the file
    // is already stored and the submission already exists. Record the
    // failure and let the caller still return 201 (green stays green).
    console.error('checklist parse error:', e.message);
    await Promise.all([
      supabaseRequest('PATCH', `submission_files?id=eq.${fileRow.id}`, { parse_status: 'failed', parse_error: e.message }, 'return=minimal').catch(() => {}),
      supabaseRequest('PATCH', `submissions?id=eq.${submission.id}`, { parse_status: 'failed', parse_error: e.message }, 'return=minimal').catch(() => {})
    ]);
    return { parse_status: 'failed', error: e.message };
  }
}

async function runMomParse(submission, projectKey, fileRow, buffer, parserProfile) {
  try {
    const winCategories = await getActiveWinCategories();
    const contribution = await parseMomWorkbook(buffer, parserProfile, winCategories);
    await insertTableRows(contribution.tableRows, submission, projectKey, 'mom');
    await supabaseRequest('PATCH', `submission_files?id=eq.${fileRow.id}`, { parse_status: 'done', parse_method: 'markdown' }, 'return=minimal');
    const analysis = await finalizeSubmissionParse(submission, fileRow, 'mom', contribution);
    return { parse_status: 'done', counts: analysis.counts, unmapped_rows: contribution.unmappedRows.length, warnings: contribution.warnings, merged: analysis.merged, possible_duplicates: analysis.possible_duplicates };
  } catch (e) {
    console.error('mom parse error:', e.message);
    await Promise.all([
      supabaseRequest('PATCH', `submission_files?id=eq.${fileRow.id}`, { parse_status: 'failed', parse_error: e.message }, 'return=minimal').catch(() => {}),
      supabaseRequest('PATCH', `submissions?id=eq.${submission.id}`, { parse_status: 'failed', parse_error: e.message }, 'return=minimal').catch(() => {})
    ]);
    return { parse_status: 'failed', error: e.message };
  }
}

app.post('/api/submissions', requireSupabase, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(422).json({ error: 'file_too_large', message: 'File exceeds the 20MB limit.' });
    next();
  });
}, async (req, res) => {
  try {
    const projectKey = trimmed(req.body.project_key).toUpperCase();
    const periodType = trimmed(req.body.period_type) || 'weekly';
    const periodStart = trimmed(req.body.period_start);
    const kind = trimmed(req.body.kind);
    const file = req.file;

    if (!GOV_KEY_RE.test(projectKey)) return res.status(400).json({ error: 'project_key is required and must look like a Jira key' });
    if (!GOV_PERIOD_TYPES.includes(periodType)) return res.status(400).json({ error: `period_type must be one of: ${GOV_PERIOD_TYPES.join(', ')}` });
    if (!ISO_DATE_RE.test(periodStart)) return res.status(400).json({ error: 'period_start is required as YYYY-MM-DD' });
    if (!GOV_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${GOV_KINDS.join(', ')}` });
    if (!file) return res.status(400).json({ error: 'file is required' });

    const ext = fileExt(file.originalname);
    if (!GOV_EXT_BY_KIND[kind].includes(ext)) {
      return res.status(422).json({ error: 'invalid_extension', message: `A ${kind} file must be one of: ${GOV_EXT_BY_KIND[kind].join(', ')}`, found: ext });
    }

    // Layer: authorization (moved ahead of the file-content layers — see the
    // comment above this route).
    if (!req.user.is_admin && !(req.user.allowed_project_keys || []).includes(projectKey)) {
      return res.status(403).json({ error: `You do not have access to project ${projectKey}` });
    }

    const projects = await supabaseRequest('GET', `projects?key=eq.${encodeURIComponent(projectKey)}&select=*`);
    const project = projects && projects[0];
    if (!project) return res.status(404).json({ error: `Project ${projectKey} not found. Try syncing from Jira first.` });

    // Layer 1: magic bytes.
    if (ext === 'md' || ext === 'txt') {
      if (!looksLikeText(file.buffer)) return res.status(422).json({ error: 'invalid_file_signature', message: `${file.originalname} does not look like a text file.` });
    } else if (!magicBytesMatch(file.buffer, ext)) {
      return res.status(422).json({ error: 'invalid_file_signature', message: `${file.originalname} does not match the expected .${ext} format.` });
    }
    // Layer 2: size (multer's own limit is the hard backstop above; this is
    // the precise, spec-shaped message).
    if (file.size > 20 * 1024 * 1024) {
      return res.status(422).json({ error: 'file_too_large', message: 'File exceeds the 20MB limit.' });
    }

    const period = await ensurePeriod(projectKey, periodType, periodStart);

    // Duplicate check (409) — cheap enough to run before the more expensive
    // Meta-parsing layers, and a byte-identical re-upload doesn't need a more
    // specific structural error.
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const periodSubs = await supabaseRequest('GET', `submissions?period_id=eq.${period.id}&select=id`);
    if (periodSubs && periodSubs.length) {
      const subIds = periodSubs.map(s => `"${s.id}"`).join(',');
      const dupe = await supabaseRequest('GET', `submission_files?submission_id=in.(${subIds})&file_sha256=eq.${sha256}&select=id`);
      if (dupe && dupe.length) {
        return res.status(409).json({ error: 'duplicate_file', message: 'This exact file has already been uploaded for this period.' });
      }
    }

    const profiles = await supabaseRequest('GET', `parser_profiles?code=eq.${encodeURIComponent(project.parser_profile)}&select=*`);
    const parserProfile = profiles && profiles[0];
    if (!parserProfile) return res.status(500).json({ error: `Parser profile "${project.parser_profile}" is not configured` });

    // Layer 3/4/6: Meta structure, project_key match, period match. Only
    // possible for checklist .xlsx and MoM .md — .docx/.pdf have no
    // accessible Meta without full text extraction (Phase 6), so those two
    // formats skip straight to storage, trusting the (already-authorized)
    // body-supplied project_key/period.
    const read = await readSubmissionMeta(file.buffer, ext, kind);
    if (read && read.error === 'unsupported_format') {
      return res.status(422).json({ error: 'unsupported_format', message: read.message });
    }
    if (read && read.error) {
      const differences = read.error === 'missing_sheet'
        ? [{ type: 'missing_sheet', sheet: read.sheet }]
        : [{ type: read.error }];
      return res.status(422).json(templateMismatchBody(parserProfile, differences, {}, project, periodType, periodStart, kind));
    }
    if (read) {
      const differences = diffStructure(read, parserProfile, kind);
      if (differences.length) {
        return res.status(422).json(templateMismatchBody(parserProfile, differences, read.metaFields, project, periodType, periodStart, kind));
      }
      const foundKey = (read.metaFields.project_key || '').toUpperCase();
      if (foundKey !== projectKey) {
        return res.status(422).json({ error: 'project_mismatch', selected: projectKey, in_file: foundKey });
      }
      const foundPeriodType = read.metaFields.period_type;
      const foundPeriodStart = read.metaFields.period_start;
      if (foundPeriodType !== periodType || foundPeriodStart !== periodStart) {
        return res.status(422).json({
          error: 'period_mismatch',
          selected: { period_type: periodType, period_start: periodStart },
          in_file: { period_type: foundPeriodType, period_start: foundPeriodStart }
        });
      }
    }

    // All gates passed — resolve which submission this file belongs to,
    // store it, and record what happened.
    const { mode, existingSubmission } = await resolveSubmissionForUpload(period.id, kind);
    let submissionId;
    if (mode === 'add') {
      submissionId = existingSubmission.id;
    } else {
      const created = await supabaseRequest('POST', 'submissions', {
        period_id: period.id, project_key: projectKey, uploaded_by: req.user.id, parse_status: 'pending'
      });
      submissionId = (Array.isArray(created) ? created[0] : created).id;
      if (mode === 'supersede') {
        await supabaseRequest('PATCH', `submissions?id=eq.${existingSubmission.id}`, { superseded_by: submissionId });
      }
    }

    const safeName = sanitizeFilename(file.originalname);
    const objectPath = `${projectKey}/${periodType}/${periodStart}/${submissionId}__${safeName}`;
    await uploadToStorage(objectPath, file.buffer, file.mimetype);
    const createdFile = await supabaseRequest('POST', 'submission_files', {
      submission_id: submissionId, kind, file_path: objectPath, file_name: file.originalname,
      file_mime: file.mimetype, file_size: file.size, file_sha256: sha256,
      parse_method: null, parse_status: 'pending'
    });
    const fileRow = Array.isArray(createdFile) ? createdFile[0] : createdFile;

    const events = [
      ['file_uploaded', 'ok', { file_name: file.originalname, size: file.size, kind }],
      ['permission_verified', 'ok', { project_key: projectKey }],
      ['format_verified', 'ok', { ext, magic_bytes_ok: true }]
    ];
    if (read) {
      events.push(['project_key_matched', 'ok', { project_key: projectKey }]);
      events.push(['period_validated', 'ok', { period_type: periodType, period_start: periodStart }]);
    } else {
      events.push(['project_key_matched', 'info', { note: 'Not verifiable for .docx/.pdf — trusted from the authorized request.' }]);
    }
    if (mode === 'supersede') events.push(['superseded', 'warn', { previous_submission_id: existingSubmission.id }]);

    // Checklist (Phase 5) and MoM-as-Markdown (Phase 6) both parse
    // synchronously, right here — see the comment on runChecklistParse for
    // why. .docx/.pdf MoM extraction is explicitly out of scope for Phase 6
    // (no LLM integration) — those uploads stay 'pending' with an event
    // noting extraction isn't available yet, rather than silently doing
    // nothing.
    let parseResult = { parse_status: 'pending' };
    if (kind === 'checklist') {
      parseResult = await runChecklistParse({ id: submissionId }, projectKey, fileRow, file.buffer, parserProfile);
      events.push(parseResult.parse_status === 'done'
        ? ['parse_finished', 'ok', { counts: parseResult.counts, unmapped_rows: parseResult.unmapped_rows, merged: parseResult.merged, possible_duplicates: parseResult.possible_duplicates }]
        : ['parse_finished', 'error', { error: parseResult.error }]);
    } else if (kind === 'mom' && (ext === 'md' || ext === 'txt')) {
      parseResult = await runMomParse({ id: submissionId }, projectKey, fileRow, file.buffer, parserProfile);
      events.push(parseResult.parse_status === 'done'
        ? ['parse_finished', 'ok', { counts: parseResult.counts, unmapped_rows: parseResult.unmapped_rows, merged: parseResult.merged, possible_duplicates: parseResult.possible_duplicates }]
        : ['parse_finished', 'error', { error: parseResult.error }]);
    } else if (kind === 'mom') {
      events.push(['parse_finished', 'info', { note: `Automatic extraction for .${ext} MoM files is not available yet — only .md/.txt are parsed. This file is stored and visible, but its content was not extracted into Wins/Blockers/Dependencies/Todos.` }]);
    }
    await writeSubmissionEvents(submissionId, req.user.id, events);

    res.status(201).json({ submission_id: submissionId, state: 'green', parse_status: parseResult.parse_status, mode });
  } catch (e) {
    console.error('submissions upload error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

function weekLabel(periodType, periodStart) {
  if (periodType === 'monthly') {
    const d = new Date(`${periodStart}T00:00:00Z`);
    return `M${String(d.getUTCMonth() + 1).padStart(2, '0')} ${d.getUTCFullYear()}`;
  }
  const d = new Date(`${periodStart}T00:00:00Z`);
  return `W${String(isoWeek(d)).padStart(2, '0')} ${d.getUTCFullYear()}`;
}

// The Submit page's table — one row per file, scoped to the caller's
// allowed_project_keys (invariant 8's second half: this list is NOT
// restricted to is_tracked, unlike the Compliance Board, because a
// submission for an untracked project still legitimately happened).
app.get('/api/submissions', requireSupabase, async (req, res) => {
  try {
    const params = ['select=*&order=uploaded_at.desc'];
    if (req.query.project_key) params.push(`project_key=eq.${encodeURIComponent(trimmed(req.query.project_key).toUpperCase())}`);
    if (req.query.from) params.push(`period_start=gte.${encodeURIComponent(req.query.from)}`);
    if (req.query.to) params.push(`period_start=lte.${encodeURIComponent(req.query.to)}`);
    if (req.query.status === 'on_time') params.push('late_by_days=eq.0');
    if (req.query.status === 'late') params.push('late_by_days=gt.0');
    if (req.query.status === 'needs_review') params.push('needs_review=eq.true');

    let rows = await supabaseRequest('GET', `v_submission_list?${params.join('&')}`);
    if (!req.user.is_admin) {
      const allowed = new Set(req.user.allowed_project_keys || []);
      rows = (rows || []).filter(r => allowed.has(r.project_key));
    }
    res.json((rows || []).map(r => ({
      id: r.submission_id,
      file_id: r.file_id,
      project_key: r.project_key,
      project_name: r.project_name,
      period_start: r.period_start,
      period_end: r.period_end,
      week_label: weekLabel(r.period_type, r.period_start),
      kind: r.kind,
      file_name: r.file_name,
      uploaded_by_name: r.uploaded_by_name || r.uploaded_by_username || 'Unknown',
      uploaded_at: r.uploaded_at,
      state: r.state,
      parse_status: r.submission_parse_status,
      needs_review: r.needs_review,
      superseded: !!r.superseded_by
    })));
  } catch (e) {
    sendSupabaseError(res, e, 'submissions');
  }
});

// Shared by the :id endpoints below — loads the submission and checks the
// caller is authorized for its project (invariant 19: re-verified server
// side on every access, not just at upload time).
async function loadAuthorizedSubmission(req, id) {
  if (!UUID_RE.test(id)) { const e = new Error('Invalid id'); e.status = 400; throw e; }
  const rows = await supabaseRequest('GET', `submissions?id=eq.${id}&select=*`);
  const submission = rows && rows[0];
  if (!submission) { const e = new Error('Submission not found'); e.status = 404; throw e; }
  if (!req.user.is_admin && !(req.user.allowed_project_keys || []).includes(submission.project_key)) {
    const e = new Error('You do not have access to this submission'); e.status = 403; throw e;
  }
  return submission;
}

app.get('/api/submissions/:id', requireSupabase, async (req, res) => {
  try {
    const submission = await loadAuthorizedSubmission(req, req.params.id);
    const [files, wins, blockers, dependencies, todos] = await Promise.all([
      supabaseRequest('GET', `submission_files?submission_id=eq.${submission.id}&select=*`),
      supabaseRequest('GET', `wins?submission_id=eq.${submission.id}&select=*`),
      supabaseRequest('GET', `blockers?submission_id=eq.${submission.id}&select=*`),
      supabaseRequest('GET', `dependencies?submission_id=eq.${submission.id}&select=*`),
      supabaseRequest('GET', `todos?submission_id=eq.${submission.id}&select=*`)
    ]);
    // wins/blockers/dependencies/todos are always empty until the Phase 5/6
    // parser exists to write them — that's expected, not a bug in this route.
    res.json({ ...submission, files, wins, blockers, dependencies, todos });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    sendSupabaseError(res, e, 'submissions/:id');
  }
});

app.get('/api/submissions/:id/events', requireSupabase, async (req, res) => {
  try {
    const submission = await loadAuthorizedSubmission(req, req.params.id);
    const events = await supabaseRequest('GET',
      `submission_events?submission_id=eq.${submission.id}&select=*,app_users(display_name,username)&order=at.asc`);
    res.json((events || []).map(ev => ({
      at: ev.at, event: ev.event, level: ev.level, detail: ev.detail,
      actor_name: ev.app_users ? (ev.app_users.display_name || ev.app_users.username) : 'System'
    })));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    sendSupabaseError(res, e, 'submissions/:id/events');
  }
});

// Redirects to a freshly-generated signed URL (TTL 60s) rather than ever
// exposing the object path or a long-lived link — invariant 21.
app.get('/api/submissions/:id/file', requireSupabase, async (req, res) => {
  try {
    const submission = await loadAuthorizedSubmission(req, req.params.id);
    const files = await supabaseRequest('GET', `submission_files?submission_id=eq.${submission.id}&select=*`);
    let file;
    if (req.query.file_id) file = (files || []).find(f => f.id === req.query.file_id);
    else if (req.query.kind) file = (files || []).find(f => f.kind === req.query.kind);
    else if (files && files.length === 1) file = files[0];
    if (!file) {
      return res.status(files && files.length > 1 ? 400 : 404).json({
        error: files && files.length > 1
          ? 'This submission has more than one file — pass ?kind=checklist|mom or ?file_id='
          : 'File not found'
      });
    }
    const signedUrl = await getSignedStorageUrl(file.file_path, 60);
    res.redirect(302, signedUrl);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('submissions/:id/file error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Admin-only, and a real DELETE (unlike wins/blockers/users) — submissions
// are file uploads a person may need to retract entirely (wrong project,
// wrong file), not records where "corrected" makes sense. Cascades via the
// FKs already in place (submission_files, wins, blockers, dependencies,
// todos, submission_events all reference submission_id ON DELETE CASCADE);
// Storage objects are cleaned up best-effort after the DB delete succeeds.
app.delete('/api/submissions/:id', requireSupabase, requireAdmin, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const files = await supabaseRequest('GET', `submission_files?submission_id=eq.${req.params.id}&select=file_path`);
    const deleted = await supabaseRequest('DELETE', `submissions?id=eq.${req.params.id}&select=id`);
    if (!deleted || !deleted.length) return res.status(404).json({ error: 'Submission not found' });
    await deleteFromStorage((files || []).map(f => f.file_path));
    res.json({ ok: true });
  } catch (e) {
    // A submission that another submission's superseded_by still points at
    // can't be deleted first — Postgres (correctly) rejects it as a foreign
    // key violation. Give the admin something actionable instead of a raw
    // constraint string: delete the newer (superseding) submission first.
    if (e.status === 409 || /foreign key|violates/i.test(e.message)) {
      return res.status(409).json({ error: 'This submission was superseded by a newer one — delete the newer submission first.' });
    }
    sendSupabaseError(res, e, 'submissions delete');
  }
});

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
