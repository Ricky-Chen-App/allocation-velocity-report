// Indonesian national holidays + cuti bersama (joint leave days).
//
// IMPORTANT: this list must be refreshed every year — Indonesian holidays
// (especially Idul Fitri, Idul Adha, cuti bersama) move on the lunar/hijri
// calendar and are only fixed by government decree (SKB 3 Menteri), usually
// published a few months before the year starts. Ideally source this from a
// public holiday API (e.g. https://api-harilibur.vercel.app or a government
// feed) instead of hand-maintaining it — this static list is a stopgap.
//
// To add a holiday manually without touching any calculation logic, either
// push a { date, name } entry below or call addHoliday(date, name) at runtime.

const HOLIDAYS_2025_2026 = [
  // ——— 2025 ———
  { date: '2025-01-01', name: "Tahun Baru Masehi" },
  { date: '2025-01-27', name: "Cuti Bersama Isra Mikraj" },
  { date: '2025-01-28', name: "Isra Mikraj Nabi Muhammad SAW" },
  { date: '2025-01-29', name: "Tahun Baru Imlek" },
  { date: '2025-03-28', name: "Cuti Bersama Hari Suci Nyepi" },
  { date: '2025-03-29', name: "Hari Suci Nyepi (Tahun Baru Saka 1947)" },
  { date: '2025-03-31', name: "Hari Raya Idul Fitri 1446 H" },
  { date: '2025-04-01', name: "Hari Raya Idul Fitri 1446 H" },
  { date: '2025-04-02', name: "Cuti Bersama Idul Fitri" },
  { date: '2025-04-03', name: "Cuti Bersama Idul Fitri" },
  { date: '2025-04-04', name: "Cuti Bersama Idul Fitri" },
  { date: '2025-04-07', name: "Cuti Bersama Idul Fitri" },
  { date: '2025-04-18', name: "Wafat Isa Almasih" },
  { date: '2025-05-01', name: "Hari Buruh Internasional" },
  { date: '2025-05-12', name: "Hari Raya Waisak" },
  { date: '2025-05-13', name: "Cuti Bersama Hari Raya Waisak" },
  { date: '2025-05-29', name: "Kenaikan Isa Almasih" },
  { date: '2025-05-30', name: "Cuti Bersama Kenaikan Isa Almasih" },
  { date: '2025-06-01', name: "Hari Lahir Pancasila" },
  { date: '2025-06-06', name: "Hari Raya Idul Adha 1446 H" },
  { date: '2025-06-09', name: "Cuti Bersama Idul Adha" },
  { date: '2025-06-27', name: "Tahun Baru Islam 1447 H" },
  { date: '2025-08-17', name: "Hari Kemerdekaan RI" },
  { date: '2025-09-05', name: "Maulid Nabi Muhammad SAW" },
  { date: '2025-12-25', name: "Hari Raya Natal" },
  { date: '2025-12-26', name: "Cuti Bersama Natal" },

  // ——— 2026 ———
  { date: '2026-01-01', name: "Tahun Baru Masehi" },
  { date: '2026-01-16', name: "Isra Mikraj Nabi Muhammad SAW" },
  { date: '2026-02-17', name: "Tahun Baru Imlek" },
  { date: '2026-03-19', name: "Hari Suci Nyepi (Tahun Baru Saka 1948)" },
  { date: '2026-03-20', name: "Hari Raya Idul Fitri 1447 H" },
  { date: '2026-03-21', name: "Hari Raya Idul Fitri 1447 H" },
  { date: '2026-03-23', name: "Cuti Bersama Idul Fitri" },
  { date: '2026-03-24', name: "Cuti Bersama Idul Fitri" },
  { date: '2026-04-03', name: "Wafat Isa Almasih" },
  { date: '2026-05-01', name: "Hari Buruh Internasional" },
  { date: '2026-05-14', name: "Kenaikan Isa Almasih" },
  { date: '2026-05-27', name: "Hari Raya Idul Adha 1447 H" },
  { date: '2026-05-31', name: "Hari Raya Waisak" },
  { date: '2026-06-01', name: "Hari Lahir Pancasila" },
  { date: '2026-06-16', name: "Tahun Baru Islam 1448 H" },
  { date: '2026-08-17', name: "Hari Kemerdekaan RI" },
  { date: '2026-08-25', name: "Maulid Nabi Muhammad SAW" },
  { date: '2026-12-25', name: "Hari Raya Natal" }
];

// In-memory holiday set — populated from the array above, extendable at runtime.
const holidaySet = new Set(HOLIDAYS_2025_2026.map(h => h.date));
const holidayNames = new Map(HOLIDAYS_2025_2026.map(h => [h.date, h.name]));

function isHoliday(dateStr) {
  return holidaySet.has(dateStr);
}

// Add a holiday manually (e.g. a newly-announced cuti bersama) without
// editing the calculation logic anywhere else in the app.
function addHoliday(date, name) {
  holidaySet.add(date);
  holidayNames.set(date, name || date);
}

function getHolidayName(dateStr) {
  return holidayNames.get(dateStr) || null;
}

module.exports = { HOLIDAYS_2025_2026, isHoliday, addHoliday, getHolidayName };
