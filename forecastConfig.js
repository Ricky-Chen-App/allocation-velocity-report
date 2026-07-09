// Single source of truth for every mandays-forecast parameter and formula.
// Management can retune the numbers here without touching any calculation
// code — server.js only ever reads these values, never redefines them.
// Every parameter carries a plain-language `label`/`formula` string that the
// frontend's "Cara Perhitungan" panel renders verbatim, so the displayed
// explanation and the actual math can never drift apart.

const PARAMS = {
  WORK_HOURS_PER_DAY: {
    value: 8,
    label: 'Jam kerja per manday',
    note: 'Dipakai untuk mengonversi mandays ke jam (Remaining Hours = mandays × jam/hari).'
  },
  FOCUS_FACTOR: {
    value: 0.75,
    label: 'Focus Factor (efektivitas dev)',
    note: 'Dev tidak 100% waktu efektif ngoding (meeting, review, konteks-switch, dll) — dipakai untuk mengecilkan kapasitas harian dari sekadar jumlah kepala.'
  },
  CALENDAR_CONVERSION: {
    value: 7 / 5,
    label: 'Konversi hari kerja → hari kalender',
    note: '5 hari kerja = 7 hari kalender, dipakai untuk mengubah estimasi hari-kerja jadi estimasi hari-kalender yang lebih mudah dibaca (mis. untuk "≈ X hari lagi").'
  },
  OVERLOAD_THRESHOLD: {
    value: 1.0,
    label: 'Ambang batas Overload',
    note: 'Rasio beban/kapasitas dev di atas nilai ini ditandai Overload (merah).'
  },
  IDLE_THRESHOLD: {
    value: 0.5,
    label: 'Ambang batas Idle',
    note: 'Rasio beban/kapasitas dev di bawah nilai ini ditandai Idle/underutilized (kuning).'
  },
  OPTIMISTIC_ADJUST: {
    value: 0.15,
    label: 'Penyesuaian skenario optimis',
    note: 'Menaikkan Focus Factor efektif sebesar persentase ini untuk menghitung tanggal selesai versi optimis (tim bekerja lebih lancar dari rata-rata).'
  },
  PESSIMISTIC_ADJUST: {
    value: 0.15,
    label: 'Penyesuaian skenario pesimis',
    note: 'Menurunkan Focus Factor efektif sebesar persentase ini untuk menghitung tanggal selesai versi pesimis (banyak gangguan/hambatan).'
  },
  MAX_REASONABLE_MANDAYS_PER_ISSUE: {
    value: 60,
    label: 'Batas wajar mandays per issue',
    note: '1 issue dengan durasi lebih dari ini (hari kerja) ditandai sebagai kemungkinan salah set tanggal — biasanya harus dipecah jadi sub-task.'
  },
  ZERO_MANDAYS_MIN_SUBTASKS: {
    value: 3,
    label: 'Batas subtask untuk validasi 0 mandays',
    note: 'Issue dengan 0 mandays (tanggal start = due, atau rentang sangat pendek) TAPI punya subtask sebanyak ini atau lebih dicurigai belum di-estimasi dengan benar.'
  },
  BURNDOWN_LOOKBACK_DAYS: {
    value: 30,
    label: 'Rentang riwayat burndown',
    note: 'Berapa hari ke belakang yang direkonstruksi untuk garis "aktual" pada chart burndown/burnup.'
  }
};

function val(key) { return PARAMS[key].value; }

// Default Jira field IDs — verified live against /rest/api/3/field on
// 2026-07-09 (customfield_10578="New Start Date", customfield_10049="New Due
// Date", customfield_10015="Start date", duedate="Due date" system field).
// server.js re-resolves these by NAME at boot (resolveDateFieldIds) and
// passes the resolved map in; these are only the fallback if that lookup
// fails or Jira renames/removes a field.
const DEFAULT_FIELD_IDS = {
  start: 'customfield_10015',
  newStart: 'customfield_10578',
  due: 'duedate',
  newDue: 'customfield_10049'
};

// effective_start = new_start_date ?? start_date
// effective_due   = new_due_date   ?? due_date
// Returns raw date strings (or null) — NOT Date objects, and deliberately
// does NOT fall back to `created` or a synthesized date the way the
// Timeline's computeTaskBars() does. A true null here is exactly the signal
// the Timeline Health check (Bagian 4) uses to flag "no estimate" — silently
// substituting a fallback date would hide that anomaly.
function getEffectiveDates(fields, fieldIds = DEFAULT_FIELD_IDS) {
  const start = fields[fieldIds.newStart] || fields[fieldIds.start] || null;
  const due = fields[fieldIds.newDue] || fields[fieldIds.due] || null;
  return { start, due };
}

// ratio = load / capacity for one developer in the current period.
function classifyLoad(ratio) {
  if (ratio == null || !isFinite(ratio)) return 'no-data';
  if (ratio > val('OVERLOAD_THRESHOLD')) return 'overload';
  if (ratio < val('IDLE_THRESHOLD')) return 'idle';
  return 'healthy';
}

const LOAD_STATUS_LABEL = {
  overload: 'Overload',
  healthy: 'Sesuai / On-track',
  idle: 'Idle / Underutilized',
  'no-data': 'No data'
};

module.exports = {
  PARAMS,
  val,
  DEFAULT_FIELD_IDS,
  getEffectiveDates,
  classifyLoad,
  LOAD_STATUS_LABEL
};
