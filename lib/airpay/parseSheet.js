// Pure CSV → AirpayTask[] parser for the "Detail Progress" tab of the AirPay
// Google Sheet. No I/O here — the caller (server.js) fetches the CSV text and
// hands it to parseAirpayCsv(). Kept dependency-free (repo has no csv-parse
// package) and side-effect-free so it's easy to unit test in isolation.
//
// The sheet is actively hand-edited by its owner and has been restructured
// twice already without notice (headers renamed, then whole new columns
// added — see git history on this file for what broke each time). Column
// lookup is therefore keyword-based rather than an exact schema, and every
// field the app actually needs has a fallback path to an older sheet shape
// so a future edit degrades gracefully instead of going blank again.
//
// Repo has no TypeScript build step, so shapes are documented via JSDoc
// instead of .ts files — same intent (typed contract), no new toolchain.
//
/**
 * @typedef {Object} AirpayTask
 * @property {string} id            - Trailing "(CODE)" extracted from the Item cell, or a synthetic ROW-n id.
 * @property {string} name          - Item cell with the trailing (CODE) stripped.
 * @property {string|null} category    - Category column (e.g. DCB / Digital Payment / Platform).
 * @property {string|null} subcategory - Operator & Service column if present; else the "Category / X" suffix
 *                                        from an older single-column Category (e.g. "DCB / Telkomsel").
 * @property {string} progressRaw   - Raw Progress % cell (may be non-numeric, e.g. "UAT Done").
 * @property {number|null} pct      - Parsed 0-100, or null when not derivable.
 * @property {string} status        - Raw Status cell ("Done" / "On Progress" / ...).
 * @property {'delivered'|'inprogress'|'blocked'} group
 * @property {boolean} waiting      - inprogress + no numeric pct + waiting/registration language.
 * @property {string} bottleneck    - "-" when empty.
 * @property {string} nextAction    - "-" when empty.
 * @property {string|null} dependency
 * @property {string|null} target      - ISO date (YYYY-MM-DD) or null. Most-current due date: New Due Date
 *                                        > Due Date > Target End > legacy single Target column.
 * @property {string|null} startDate   - ISO date. Most-current start: New Start Date > Start Date >
 *                                        Target Start > "Start Date: ..." embedded in Detail > target-6d.
 * @property {string|null} pic         - Assignee column if present, else "PIC: ..." parsed out of Remarks.
 * @property {'P0'|'P1'|'P2'|null} prio - Priority column if present, else parsed out of Remarks.
 * @property {string} detail
 *
 * @typedef {Object} AirpaySummary
 * @property {number} overallPct
 * @property {number} delivered
 * @property {number} inprogress
 * @property {number} blocked
 * @property {number} total
 */

// ——— RFC4180-ish CSV parser (quoted fields, embedded commas/newlines, "" escape) ———
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      field += c; continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue; // normalize CRLF -> LF
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, may: 4, jun: 5, jul: 6,
  agu: 7, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, des: 11, dec: 11
};
function parseIdDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (mon === undefined) return null;
  return new Date(Date.UTC(parseInt(m[3], 10), mon, parseInt(m[1], 10))).toISOString().slice(0, 10);
}

function derivePct(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d{1,3})\s*%/);
  if (m) return Math.min(100, parseInt(m[1], 10));
  const low = raw.toLowerCase();
  if (low.includes('uat')) return 90;
  if (low.includes('review')) return 85;
  if (low.includes('done')) return 100;
  return null;
}

function deriveGroup(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('done')) return 'delivered';
  if (s.includes('blocked') || s.includes('cancel') || s.includes('tbd')) return 'blocked';
  return 'inprogress';
}

// Trailing "(CODE)" -> id; rest -> name. Names may contain earlier parens
// (e.g. "Quantum (Horo1 / Cloudplay) (DCB-16)") — only the LAST group is the code.
function splitItemCode(raw) {
  const m = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) return { id: m[2].trim(), name: m[1].trim() };
  return { id: null, name: raw };
}

// Legacy shape only: a single "Category" cell like "DCB / Telkomsel" gets
// split into category + subcategory. The current sheet has a dedicated
// Operator & Service column instead (see buildTask), so this is a fallback.
function splitCategory(raw) {
  if (!raw) return [null, null];
  const parts = raw.split('/');
  return [
    parts[0] ? parts[0].trim() : null,
    parts.length > 1 ? parts.slice(1).join('/').trim() : null
  ];
}

// The sheet uses a bare "-" as its empty-cell convention everywhere
// (dates, assignee, priority, bottleneck, ...). Normalize it to '' so every
// downstream check (parseIdDate, truthiness, "!== '-'" comparisons) only
// has to deal with one notion of "not set".
function cell(row, idx) {
  if (idx === undefined) return '';
  const v = (row[idx] || '').trim();
  return v === '-' ? '' : v;
}

function shouldSkipRow(itemRaw) {
  if (!itemRaw) return true;
  const low = itemRaw.toLowerCase();
  if (low.startsWith('on progress')) return true;
  if (low.startsWith('airpay daily')) return true;
  // Footer legend row — seen as both "Legenda status:" (ID) and "Status
  // legend:" (EN) after the sheet owner translated it; match either order.
  if (low.includes('legend')) return true;
  // Repeated header row (e.g. pasted mid-sheet), any language/phrasing.
  if (low.includes('item') && (low.includes('keterangan') || low.includes('description'))) return true;
  return false;
}

// Column names are matched by KEYWORD, not exact string, because the sheet
// owner edits this schema without notice — headers have been renamed
// ("Item / Keterangan" -> "Item / Description", "Kategori" -> "Category")
// and, separately, whole new columns were inserted (Target Start/End,
// Start/Due Date, New Start/Due Date, Assignee, Priority, replacing what
// used to be free text baked into Remarks). An ordered list + "claim" the
// matched column index as we go (rather than a plain object of matchers)
// so more specific patterns are checked before broader ones — otherwise a
// generic target: h=>h.includes('target') would grab "Target Start" and
// never let "Target End" bind to anything.
const COL_MATCHERS = [
  ['item', h => h.includes('item')],
  ['kategori', h => h.includes('categ') || h.includes('kategori')],
  ['operator', h => h.includes('operator') || h.includes('service')],
  ['country', h => h.includes('country')],
  ['progress %', h => h.includes('progress') && h.includes('%')],
  ['status', h => h.includes('status')],
  ['bottleneck / issue', h => h.includes('bottleneck')],
  ['next action', h => h.includes('next action') || h.includes('next step')],
  ['dependency', h => h.includes('depend')],
  ['new start date', h => h.includes('new') && h.includes('start')],
  ['new due date', h => h.includes('new') && h.includes('due')],
  ['target start', h => h.includes('target') && h.includes('start')],
  ['target end', h => h.includes('target') && h.includes('end')],
  ['start date', h => h.includes('start') && h.includes('date')],
  ['due date', h => h.includes('due')],
  ['target', h => h.includes('target')], // legacy single Target column (no Start/End split)
  ['assignee', h => h.includes('assign') || h.includes('pic')],
  ['priority', h => h.includes('priorit')],
  ['remarks', h => h.includes('remark')],
  ['detail', h => h.includes('detail')]
];
// Column A carries a merged title ("AIRPAY DAILY CHECKLIST — DETAIL PROGRESS
// PER ITEM No") that itself contains "item"/"progress"/"detail" — without a
// length cap it wins the keyword match over the real "Item"/"Progress %"/
// "Detail" columns (every real header is a short label, well under 30 chars).
const MAX_HEADER_CELL_LEN = 30;

function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map(c => c.toLowerCase());
    const colIndex = {};
    const claimed = new Set();
    for (const [key, test] of COL_MATCHERS) {
      const idx = lower.findIndex((c, ci) =>
        !claimed.has(ci) && c.length > 0 && c.length <= MAX_HEADER_CELL_LEN && test(c));
      if (idx !== -1) { colIndex[key] = idx; claimed.add(idx); }
    }
    if (Object.keys(colIndex).length >= 5) return { headerIdx: i, colIndex };
  }
  return null;
}

/**
 * @param {string} csvText
 * @returns {{ tasks: AirpayTask[], summary: AirpaySummary, error?: string }}
 */
function parseAirpayCsv(csvText) {
  const rows = parseCsv(csvText).map(r => r.map(c => (c || '').trim()));

  const header = findHeader(rows);
  if (!header) {
    return { tasks: [], summary: computeSummary([]), error: 'Detail Progress header row not found' };
  }
  const { headerIdx, colIndex } = header;

  const tasks = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const itemRaw = r[colIndex['item']] || '';
    if (shouldSkipRow(itemRaw)) continue;

    const { id, name } = splitItemCode(itemRaw);

    // Category / subcategory: prefer the dedicated "Operator & Service"
    // column (current sheet shape); fall back to splitting "Category" on
    // "/" for the older single-column shape.
    const categoryRaw = cell(r, colIndex['kategori']);
    const operatorRaw = cell(r, colIndex['operator']);
    let category, subcategory;
    if (colIndex['operator'] !== undefined) {
      category = categoryRaw || null;
      subcategory = operatorRaw || null;
    } else {
      [category, subcategory] = splitCategory(categoryRaw);
    }

    const progressRaw = r[colIndex['progress %']] || '';
    const status = r[colIndex['status']] || '';
    const bottleneckRaw = r[colIndex['bottleneck / issue']] || '';
    const nextActionRaw = r[colIndex['next action']] || '';
    const dependencyRaw = cell(r, colIndex['dependency']);
    const remarks = r[colIndex['remarks']] || '';
    const detail = colIndex['detail'] !== undefined ? (r[colIndex['detail']] || '') : '';

    const pct = derivePct(progressRaw);
    const group = deriveGroup(status);
    const waiting = group === 'inprogress' && pct === null && /wait|regist|hold|blocked|tbd|review/i.test(progressRaw);

    // Most-current due date: a reschedule (New Due Date) always wins over
    // the original Due Date / Target End; legacy sheets only ever had one
    // unqualified "Target" column, which is the last fallback.
    const target =
      parseIdDate(cell(r, colIndex['new due date'])) ||
      parseIdDate(cell(r, colIndex['due date'])) ||
      parseIdDate(cell(r, colIndex['target end'])) ||
      parseIdDate(cell(r, colIndex['target']));

    let startDate =
      parseIdDate(cell(r, colIndex['new start date'])) ||
      parseIdDate(cell(r, colIndex['start date'])) ||
      parseIdDate(cell(r, colIndex['target start']));
    if (!startDate) {
      const sdMatch = detail.match(/Start Date:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i);
      if (sdMatch) startDate = parseIdDate(sdMatch[1]);
    }
    if (!startDate && target) {
      const d = new Date(target + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 6);
      startDate = d.toISOString().slice(0, 10);
    }

    // Assignee/Priority: prefer the dedicated columns (current sheet shape);
    // fall back to "PIC: X · Priority: Y" once baked into Remarks (older shape).
    const assigneeRaw = cell(r, colIndex['assignee']);
    const priorityRaw = cell(r, colIndex['priority']);
    const picMatch = !assigneeRaw ? remarks.match(/PIC:\s*([^·]+)/i) : null;
    const prioMatch = !priorityRaw ? remarks.match(/\b(P[012])\b/) : (priorityRaw.match(/\b(P[012])\b/i) || null);

    tasks.push({
      id: id || `ROW-${i}`,
      name,
      category, subcategory,
      progressRaw, pct, status, group, waiting,
      bottleneck: bottleneckRaw || '-',
      nextAction: nextActionRaw || '-',
      dependency: dependencyRaw || null,
      target, startDate,
      pic: assigneeRaw || (picMatch ? picMatch[1].trim() : null),
      prio: prioMatch ? prioMatch[1].toUpperCase() : null,
      detail
    });
  }

  return { tasks, summary: computeSummary(tasks) };
}

function computeSummary(tasks) {
  const delivered = tasks.filter(t => t.group === 'delivered').length;
  const inprogress = tasks.filter(t => t.group === 'inprogress').length;
  const blocked = tasks.filter(t => t.group === 'blocked').length;
  const total = tasks.length;
  return {
    overallPct: total ? Math.round((delivered / total) * 100) : 0,
    delivered, inprogress, blocked, total
  };
}

module.exports = { parseAirpayCsv, parseCsv, derivePct, deriveGroup, splitItemCode, splitCategory, parseIdDate };
