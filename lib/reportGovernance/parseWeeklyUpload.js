// Parses the real "LINKIT360 PMO · WEEKLY DELIVERY TRACKER" spreadsheet
// format (both the Weekly Delivery Tracker and the Dev Team Daily Progress
// tables that live in the same sheet, one below the other) from an
// already-loaded ExcelJS worksheet. Deliberately tolerant of the sheet's
// real-world messiness — extra "next week" placeholder day columns, mixed
// capitalization, blank spacer rows — since it mirrors a hand-maintained
// PMO tracker, not a clean machine format. Row/column POSITION is never
// assumed; everything is located by matching header cell text, so the
// parser survives columns being reordered or extra ones being inserted.

// Accepts either a raw cell value (for recursive calls, e.g. a formula's
// .result) or a real ExcelJS cell. Cells matter because Excel stores a
// percent-formatted cell's value as the raw fraction (0.93), not the "93%"
// text it displays — typing "93%" into a cell the template already
// formatted as a percentage silently becomes 0.93 with no way to recover
// "93%" from .value alone, so numFmt has to be checked to convert it back.
function norm(cellOrValue) {
  if (cellOrValue == null) return '';
  const isCell = typeof cellOrValue === 'object' && 'value' in cellOrValue && 'numFmt' in cellOrValue;
  const v = isCell ? cellOrValue.value : cellOrValue;
  if (v == null) return '';
  if (isCell && typeof v === 'number' && /%/.test(cellOrValue.numFmt || '')) {
    return `${Math.round(v * 10000) / 100}%`;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return norm(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
}

function rowTexts(row) {
  const out = [];
  const last = Math.max(row.cellCount || 0, row.actualCellCount || 0, 30);
  for (let i = 1; i <= last; i++) out[i] = norm(row.getCell(i));
  return out;
}

const SECTION_PATTERNS = [
  { test: /^MOVING\b/i, movement: 'Moving' },
  { test: /^(DEMO DONE|ON HOLD)/i, movement: 'On Hold' },
  { test: /^NOT\s*(YET\s*A\s*)?DEV\s*ITEM/i, movement: 'Not Dev Item' }
];

const WEEKLY_HEADER_FIELD = {
  'score': 'score', 'capacity gate': 'gate', 'product': 'name', 'movement': 'movementCell',
  'mvp %': 'mvp', 'mvp': 'mvp',
  'blocker / next milestone': 'blocker', 'blocker': 'blocker', 'blocker / notes': 'blocker',
  'demo link': 'demoLink', 'credential account': 'credentials', 'credentials': 'credentials',
  'link repo': 'linkRepo', 'repo': 'linkRepo'
};

function isWeekdayHeader(text) {
  return /^(mon|tue|wed|thu|fri)\b/i.test(text || '');
}

// The real sheet crams both links into one free-text cell, e.g.
// "CMS : https://... Public Portal : https://...". Extracts each by the
// label that precedes it; falls back to a single bare URL, and otherwise
// reports the text as unparsed rather than guessing.
function splitDemoLink(text) {
  if (!text) return { portal: null, cms: null, unparsed: null };
  const portalM = text.match(/portal\s*:?\s*(https?:\/\/\S+)/i);
  const cmsM = text.match(/cms\s*:?\s*(https?:\/\/\S+)/i);
  if (portalM || cmsM) return { portal: portalM ? portalM[1] : null, cms: cmsM ? cmsM[1] : null, unparsed: null };
  const bare = text.match(/https?:\/\/\S+/);
  if (bare) return { portal: bare[0], cms: null, unparsed: null };
  return { portal: null, cms: null, unparsed: text };
}

const DAY_STATUS_CANON = {
  '': '', 'backlog': 'Backlog', 'to do': 'To Do', 'todo': 'To Do',
  'in progress': 'In Progress', 'blocked': 'Blocked', 'done': 'Done'
};
// Returns the canonical value, or null when the text doesn't match any
// known status (caller decides how to warn about that).
function normDayStatus(text) {
  const key = (text || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(DAY_STATUS_CANON, key) ? DAY_STATUS_CANON[key] : null;
}
function normGate(text) {
  const t = (text || '').toUpperCase().trim();
  return ['GREEN', 'YELLOW', 'RED'].includes(t) ? t : null;
}
function normMove(text) {
  const t = (text || '').toLowerCase().trim();
  const m = { '': '', yes: 'Yes', no: 'No', blocked: 'Blocked' };
  return Object.prototype.hasOwnProperty.call(m, t) ? m[t] : null;
}

// Allows "/" so a row shared by two people (e.g. "RICKY TANJAYA / DIMAS
// FAHRUL — 1 task(s)") is still recognized as a person-header row — even
// though that combined name then won't match a single roster member (so its
// rows get skipped with a clear reason), which is far better than the old
// failure mode: an unmatched header fell through as a plain data row, and
// its rows got silently misattributed to whichever person came before it.
const PERSON_HEADER_RE = /^([A-Za-z][A-Za-z ./]+?)\s*[—-]\s*\d+\s*task/i;

function parseWeeklyUploadWorkbook(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, row => rows.push(rowTexts(row)));

  const weeklyRows = [];
  const progressRows = [];
  const warnings = [];

  // ---- Pass 1: Weekly Delivery Tracker (three Moving/On Hold/Not Dev Item sections) ----
  let movement = null;
  let colMap = null;
  let progressStartIdx = rows.length;

  for (let idx = 0; idx < rows.length; idx++) {
    const texts = rows[idx];
    const first = texts[1] || '';

    if (/DAILY PROGRESS TRACKER/i.test(texts.filter(Boolean).join(' '))) {
      progressStartIdx = idx;
      break;
    }

    const section = SECTION_PATTERNS.find(s => s.test.test(first));
    if (section) { movement = section.movement; colMap = null; continue; }

    if (!colMap) {
      const productColIdx = texts.findIndex(t => /^product$/i.test(t || ''));
      if (productColIdx > 0) {
        const map = { days: [] };
        texts.forEach((t, i) => {
          if (!t) return;
          const key = t.toLowerCase().replace(/\s+/g, ' ').trim();
          if (WEEKLY_HEADER_FIELD[key]) map[WEEKLY_HEADER_FIELD[key]] = i;
          else if (isWeekdayHeader(t) && map.days.length < 5) map.days.push(i);
        });
        if (map.name != null) { colMap = map; continue; }
      }
    }

    if (!movement || !colMap) continue;
    const name = texts[colMap.name];
    if (!name) continue; // blank spacer row inside a section

    const demoText = colMap.demoLink != null ? texts[colMap.demoLink] : '';
    const demo = splitDemoLink(demoText);
    if (demo.unparsed) warnings.push(`"${name}": Demo Link "${demo.unparsed}" wasn't recognized as a URL — left blank, add it manually via Edit links.`);

    const repoText = colMap.linkRepo != null ? (texts[colMap.linkRepo] || '') : '';
    const repoUrls = repoText.match(/https?:\/\/\S+/g) || [];
    if (repoUrls.length > 1) warnings.push(`"${name}": found ${repoUrls.length} repo links, only the first was imported — add the rest manually via Edit links.`);

    weeklyRows.push({
      name,
      movement,
      score: colMap.score != null ? texts[colMap.score] : '',
      gate: colMap.gate != null ? texts[colMap.gate] : '',
      mvp: colMap.mvp != null ? texts[colMap.mvp] : '',
      blocker: colMap.blocker != null ? texts[colMap.blocker] : '',
      demoPortal: demo.portal,
      demoCms: demo.cms,
      linkRepo: repoUrls[0] || null,
      credentials: colMap.credentials != null ? texts[colMap.credentials] : '',
      days: colMap.days.map(c => texts[c] || '')
    });
  }

  // ---- Pass 2: Dev Team Daily Progress Tracker (grouped per person) ----
  let person = null;
  let pColMap = null;
  for (let idx = progressStartIdx; idx < rows.length; idx++) {
    const texts = rows[idx];
    const first = texts[1] || '';
    if (/^legend/i.test(first)) break;

    const joined = texts.filter(Boolean).join(' ');
    const personM = first.match(PERSON_HEADER_RE) || joined.match(PERSON_HEADER_RE);
    if (personM) { person = personM[1].trim(); pColMap = null; continue; }

    if (texts.some(t => /^yesterday$/i.test(t || ''))) {
      const map = { days: [] };
      texts.forEach((t, i) => {
        const key = (t || '').toLowerCase();
        if (key === 'product') map.name = i;
        else if (key === 'yesterday') map.days.push({ yesterday: i, today: null, move: null });
        else if (key === 'today' && map.days.length) map.days[map.days.length - 1].today = i;
        else if (key.startsWith('move') && map.days.length) map.days[map.days.length - 1].move = i;
        else if (/blocker/i.test(t || '')) map.blocker = i;
      });
      if (map.name != null) pColMap = map;
      continue;
    }

    if (!person || !pColMap) continue;
    const name = texts[pColMap.name];
    if (!name) continue;

    const days = pColMap.days.slice(0, 5).map(d => ({
      yesterday: d.yesterday != null ? (texts[d.yesterday] || '') : '',
      today: d.today != null ? (texts[d.today] || '') : '',
      move: d.move != null ? (texts[d.move] || '') : ''
    }));
    progressRows.push({
      person,
      product: name,
      blocker: pColMap.blocker != null ? (texts[pColMap.blocker] || '') : '',
      days
    });
  }

  return { weeklyRows, progressRows, warnings };
}

module.exports = { parseWeeklyUploadWorkbook, normDayStatus, normGate, normMove };
