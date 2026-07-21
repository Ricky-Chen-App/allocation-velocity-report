// Pure CSV → AirpayTask[] parser for the "Detail Progress" tab of the AirPay
// Google Sheet. No I/O here — the caller (server.js) fetches the CSV text and
// hands it to parseAirpayCsv(). Kept dependency-free (repo has no csv-parse
// package) and side-effect-free so it's easy to unit test in isolation.
//
// Repo has no TypeScript build step, so shapes are documented via JSDoc
// instead of .ts files — same intent (typed contract), no new toolchain.
//
/**
 * @typedef {Object} AirpayTask
 * @property {string} id            - Trailing "(CODE)" extracted from Item / Keterangan, or a synthetic ROW-n id.
 * @property {string} name          - Item / Keterangan with the trailing (CODE) stripped.
 * @property {string|null} category    - First segment of Kategori (DCB / Digital Payment / Platform).
 * @property {string|null} subcategory - Segment(s) after the first "/" in Kategori, if any.
 * @property {string} progressRaw   - Raw Progress % cell (may be non-numeric, e.g. "UAT Done").
 * @property {number|null} pct      - Parsed 0-100, or null when not derivable.
 * @property {string} status        - Raw Status cell ("Done" / "On Progress" / ...).
 * @property {'delivered'|'inprogress'|'blocked'} group
 * @property {boolean} waiting      - inprogress + no numeric pct + waiting/registration language.
 * @property {string} bottleneck    - "-" when empty.
 * @property {string} nextAction    - "-" when empty.
 * @property {string|null} dependency
 * @property {string|null} target      - ISO date (YYYY-MM-DD) or null.
 * @property {string|null} startDate   - ISO date; from Detail's "Start Date: ..." or target-6d.
 * @property {string|null} pic
 * @property {'P0'|'P1'|'P2'|null} prio
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

function splitCategory(raw) {
  if (!raw) return [null, null];
  const parts = raw.split('/');
  return [
    parts[0] ? parts[0].trim() : null,
    parts.length > 1 ? parts.slice(1).join('/').trim() : null
  ];
}

function shouldSkipRow(itemRaw) {
  if (!itemRaw) return true;
  const low = itemRaw.toLowerCase();
  if (low.startsWith('on progress')) return true;
  if (low.startsWith('airpay daily')) return true;
  if (low.startsWith('legenda')) return true;
  if (itemRaw === 'Item / Keterangan') return true;
  return false;
}

const EXPECTED_COLS = [
  'item / keterangan', 'kategori', 'progress %', 'status',
  'bottleneck / issue', 'next action', 'dependency', 'target', 'remarks', 'detail'
];

/**
 * @param {string} csvText
 * @returns {{ tasks: AirpayTask[], summary: AirpaySummary, error?: string }}
 */
function parseAirpayCsv(csvText) {
  const rows = parseCsv(csvText).map(r => r.map(c => (c || '').trim()));

  let headerIdx = -1;
  const colIndex = {};
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map(c => c.toLowerCase());
    const hits = EXPECTED_COLS.filter(name => lower.includes(name)).length;
    if (hits >= 5) {
      headerIdx = i;
      EXPECTED_COLS.forEach(name => {
        const idx = lower.indexOf(name);
        if (idx !== -1) colIndex[name] = idx;
      });
      break;
    }
  }
  if (headerIdx === -1) {
    return { tasks: [], summary: computeSummary([]), error: 'Detail Progress header row not found' };
  }

  const tasks = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const itemRaw = r[colIndex['item / keterangan']] || '';
    if (shouldSkipRow(itemRaw)) continue;

    const { id, name } = splitItemCode(itemRaw);
    const [category, subcategory] = splitCategory(r[colIndex['kategori']] || '');
    const progressRaw = r[colIndex['progress %']] || '';
    const status = r[colIndex['status']] || '';
    const bottleneckRaw = r[colIndex['bottleneck / issue']] || '';
    const nextActionRaw = r[colIndex['next action']] || '';
    const dependencyRaw = colIndex['dependency'] !== undefined ? (r[colIndex['dependency']] || '') : '';
    const targetRaw = r[colIndex['target']] || '';
    const remarks = r[colIndex['remarks']] || '';
    const detail = colIndex['detail'] !== undefined ? (r[colIndex['detail']] || '') : '';

    const pct = derivePct(progressRaw);
    const group = deriveGroup(status);
    const waiting = group === 'inprogress' && pct === null && /wait|regist|hold|blocked|tbd|review/i.test(progressRaw);
    const target = parseIdDate(targetRaw);

    let startDate = null;
    const sdMatch = detail.match(/Start Date:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i);
    if (sdMatch) startDate = parseIdDate(sdMatch[1]);
    else if (target) {
      const d = new Date(target + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 6);
      startDate = d.toISOString().slice(0, 10);
    }

    const picMatch = remarks.match(/PIC:\s*([^·]+)/i);
    const prioMatch = remarks.match(/\b(P[012])\b/);

    tasks.push({
      id: id || `ROW-${i}`,
      name,
      category, subcategory,
      progressRaw, pct, status, group, waiting,
      bottleneck: bottleneckRaw || '-',
      nextAction: nextActionRaw || '-',
      dependency: dependencyRaw && dependencyRaw !== '-' ? dependencyRaw : null,
      target, startDate,
      pic: picMatch ? picMatch[1].trim() : null,
      prio: prioMatch ? prioMatch[1] : null,
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
