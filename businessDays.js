// Indonesia-aware business-day math shared by velocity/forecast calculations.
// Weekend + national-holiday rules live in data/holidays_id.js — this file
// only implements the calendar arithmetic on top of that list.

const { isHoliday } = require('./data/holidays_id');

function toDateOnly(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toIso(d) {
  // Local-date string (not toISOString) so timezone offset never rolls the
  // date backward/forward across midnight — same rationale as server.js's
  // timeline endpoint (see its comment at computeTaskBars call site).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isBusinessDay(date) {
  const d = toDateOnly(date);
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false; // Sun / Sat
  return !isHoliday(toIso(d));
}

// Inclusive of both start and end. Returns null (not 0) when either date is
// missing/invalid — callers must be able to tell "no dates set" apart from
// "0 business days between two valid same-day dates".
function businessDaysBetween(start, end) {
  if (!start || !end) return null;
  const s = toDateOnly(start);
  const e = toDateOnly(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
  if (e < s) return null; // reversed range — caller flags this as an anomaly, not a negative count

  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    if (isBusinessDay(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Adds `days` business days to `date`, skipping weekends + holidays.
// days=0 returns the same date unchanged (does not snap forward/back).
function addBusinessDays(date, days) {
  const d = toDateOnly(date);
  let remaining = Math.round(days);
  const step = remaining >= 0 ? 1 : -1;
  remaining = Math.abs(remaining);
  while (remaining > 0) {
    d.setDate(d.getDate() + step);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

module.exports = { isBusinessDay, businessDaysBetween, addBusinessDays, toIso };
