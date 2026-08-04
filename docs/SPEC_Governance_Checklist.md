# Spec Teknis — Governance Checklist & MoM Upload

Resource Portal — Linkit360 · `allocation-velocity-report.vercel.app`
Supabase project: `DB Report Allocation` (`xarykxplsjqbasulcrvk`, ap-southeast-1, PG 17)

Status: **DRAFT — belum diimplementasi.** Butuh review + 2 file contoh yang belum ter-attach.

Revisi: unit compliance = **project** (bukan team). User memilih project Jira dulu, baru upload.

---

## 1. Tujuan

**Unit compliance adalah project, bukan team.** User memilih project Jira lebih dulu — daftarnya
**seluruh 90 project** di `linkit360.atlassian.net`, bukan hanya yang dilacak — lalu upload bukti
governance untuk periode berjalan. Checklist dan MoM boleh diupload **keduanya sekaligus**;
minimal satu wajib ada.

System parse file, ekstrak **wins / blockers / dependencies / to-do**, dan render status
compliance per project dengan warna:

| Kondisi | Warna |
|---|---|
| Sudah upload (checklist, MoM, atau keduanya) untuk project + periode itu | 🟢 green |
| Belum upload, `now ≤ due_date` | ⚪ pending |
| `due_date < now ≤ due_date + warn_after_days` | 🟠 orange |
| `now > due_date + late_after_days` | 🔴 red |

Prinsip: **warna dihitung on-read, tidak disimpan.** Tidak perlu cron job. Satu SQL function jadi sumber kebenaran, dipakai UI dan API.

---

## 2. Kondisi eksisting (hasil audit)

### 2.1 Portal
Read-only konsumsi data. Sumber:

| Sumber | Modul |
|---|---|
| Jira live (`linkit360.atlassian.net`) | Executive, Developer Capacity, Velocity & Forecast, Task Allocation, Timeline, Jira Sync |
| Google Sheet | Report AirPay (Summary + Detail) |
| Supabase | Team Members, User Management, Org Design |

**Belum ada jalur upload sama sekali.** Fitur ini adalah write-path pertama → butuh Storage bucket, parser, dan state machine baru.

### 2.2 Tabel Supabase yang sudah ada

```
public.wins       (4 rows,  RLS on)
  id, win_date, category CHECK IN ('Platform','DCB','Digital Payment'),
  title, description, jira_issue_key, created_at, updated_at

public.blockers   (5 rows,  RLS on)
  id, title, jira_issue_key, pic,
  priority CHECK IN ('P0'..'P4'),
  status   CHECK IN ('Open','In Progress','Resolved'),
  bottleneck, next_action, target_date, created_at, updated_at

public.app_users  (2 rows,  RLS on)
  id, username, email, display_name, password_hash, password_salt,
  must_change_password, is_admin, is_active,
  allowed_project_keys text[], allowed_nav_ids text[],
  last_login_at, last_login_device, last_login_user_agent, ...
```

**Gap terhadap kebutuhan:**

1. `wins` / `blockers` tidak punya `project_key` maupun `submission_id` → tidak bisa dikaitkan ke project atau periode. Saat ini flat/global.
2. Tidak ada tabel `dependencies` sama sekali.
3. `wins.category` CHECK hanya 3 nilai — akan pecah kalau project lain punya kategori berbeda. Perlu dilonggarkan atau dijadikan lookup table.
4. **Tidak ada tabel `projects`.** Daftar project hanya hidup di Jira dan di `app_users.allowed_project_keys` (array teks tanpa FK). Ini yang paling menentukan: unit compliance adalah project, jadi project harus jadi entitas DB dengan primary key. Tabel team juga belum ada.
5. Auth pakai custom `app_users` (password_hash sendiri), **bukan** Supabase Auth → `auth.uid()` tidak tersedia. RLS tidak bisa pakai pola standar. Lihat §7.

---

## 3. Data model

### 3.1 Tabel baru

```sql
-- ---------- Team: hanya untuk grouping di board ----------
create table public.teams (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  slug         text not null unique,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- Project: unit compliance, disinkron dari Jira ----------
create table public.projects (
  key          text primary key,               -- key Jira: AIRPAY, LUN, DSH, IV, ...
  name         text not null,
  jira_id      text,
  team_id      uuid references public.teams(id) on delete set null,
  category     text,                           -- Platform | DCB | Digital Payment
  is_tracked   boolean not null default false, -- opt-in: hanya ini yang muncul di board
  tracked_from date,                           -- periode pertama yang dihitung
  is_active    boolean not null default true,  -- false kalau project hilang dari Jira
  last_synced_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint project_key_format check (key ~ '^[A-Z][A-Z0-9_]{1,15}$')
);

create index on public.projects (team_id);
create index on public.projects (is_tracked) where is_tracked;

-- ---------- Parser profile: definisi kolom template ----------
-- Satu profil dipakai banyak project. Menambah profil = insert 1 baris, bukan deploy kode.
create table public.parser_profiles (
  code            text primary key,          -- 'default', 'airpay', 'infra', ...
  label           text not null,
  schema_version  smallint not null default 2,
  sheets          jsonb not null,            -- lihat bentuknya di bawah
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.projects
  add column parser_profile text not null default 'default'
    references public.parser_profiles(code) on update cascade;

-- ---------- Aturan compliance per project ----------
create table public.compliance_policies (
  id               uuid primary key default gen_random_uuid(),
  project_key      text not null references public.projects(key) on delete cascade,
  period_type      text not null default 'weekly'
                     check (period_type in ('weekly','monthly')),
  -- hari jatuh tempo dalam periode. weekly: 1=Senin..7=Minggu
  due_dow          smallint check (due_dow between 1 and 7),
  -- monthly: tanggal jatuh tempo
  due_dom          smallint check (due_dom between 1 and 28),
  due_time         time not null default '17:00',
  timezone         text not null default 'Asia/Jakarta',
  warn_after_days  smallint not null default 1,   -- → orange
  late_after_days  smallint not null default 3,   -- → red
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint policy_one_per_project unique (project_key, period_type),
  constraint policy_thresholds_ordered check (late_after_days >= warn_after_days),
  constraint policy_due_field_present check (
    (period_type = 'weekly'  and due_dow is not null) or
    (period_type = 'monthly' and due_dom is not null)
  )
);

-- ---------- Periode konkret (di-generate dari policy) ----------
create table public.compliance_periods (
  id            uuid primary key default gen_random_uuid(),
  project_key   text not null references public.projects(key) on delete cascade,
  policy_id     uuid not null references public.compliance_policies(id),
  period_type   text not null check (period_type in ('weekly','monthly')),
  period_start  date not null,
  period_end    date not null,
  due_at        timestamptz not null,
  created_at    timestamptz not null default now(),
  unique (project_key, period_type, period_start),
  constraint period_range_valid check (period_end >= period_start)
);

-- ---------- Submission (file yang diupload) ----------
create table public.submissions (
  id             uuid primary key default gen_random_uuid(),
  period_id      uuid not null references public.compliance_periods(id) on delete cascade,
  project_key    text not null references public.projects(key) on delete cascade,
  uploaded_by    uuid not null references public.app_users(id),
  uploaded_at    timestamptz not null default now(),
  parse_status   text not null default 'pending'
                   check (parse_status in ('pending','parsing','done','failed')),
  parse_error    text,
  analysis       jsonb,                  -- hasil ekstraksi gabungan, lihat §5.3
  superseded_by  uuid references public.submissions(id),
  created_at     timestamptz not null default now()
);

-- Satu submission boleh berisi checklist DAN MoM sekaligus (masing-masing maks 1).
create table public.submission_files (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.submissions(id) on delete cascade,
  kind           text not null check (kind in ('mom','checklist')),
  file_path      text not null,          -- path di Storage bucket
  file_name      text not null,
  file_mime      text,
  file_size      bigint,
  file_sha256    text,
  parse_method   text,                   -- 'column' | 'markdown' | 'llm'
  parse_status   text not null default 'pending'
                   check (parse_status in ('pending','parsing','done','failed')),
  parse_error    text,
  created_at     timestamptz not null default now(),
  unique (submission_id, kind)            -- maks 1 checklist + 1 MoM per submission
);

create index on public.submissions (period_id);
create index on public.submissions (project_key, uploaded_at desc);
create index on public.submissions (parse_status) where parse_status <> 'done';
create index on public.submission_files (submission_id);
create unique index submission_files_active_sha
  on public.submission_files (submission_id, file_sha256);

-- ---------- To Do: apa yang harus dikerjakan + tenggat ----------
create table public.todos (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid references public.submissions(id) on delete cascade,
  project_key    text references public.projects(key) on delete set null,
  title          text not null,
  pic            text not null,
  due_date       date not null,          -- wajib: tanpa tenggat tidak bisa dihitung terlambat
  priority       text not null default 'P2'
                   check (priority in ('P0','P1','P2','P3','P4')),
  status         text not null default 'Not Started'
                   check (status in ('Not Started','In Progress','Done','Blocked')),
  jira_issue_key text,
  notes          text,
  source         text not null default 'upload'
                   check (source in ('upload','manual','jira')),
  source_kind    text check (source_kind in ('mom','checklist')),
  confidence     numeric(3,2),
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index on public.todos (project_key, due_date);
create index on public.todos (submission_id);
create index on public.todos (due_date) where status <> 'Done';

-- Status tenggat dihitung on-read, sama seperti warna compliance
create or replace function public.todo_state(
  p_due date, p_status text, p_now date default current_date
) returns text language sql immutable as $$
  select case
    when p_status = 'Done'      then 'done'
    when p_status = 'Blocked'   then 'blocked'
    when p_now > p_due          then 'overdue'
    when p_now = p_due          then 'due_today'
    when p_now + 3 >= p_due     then 'due_soon'
    else 'on_track'
  end;
$$;

-- ---------- Jejak aktivitas user per submission ----------
create table public.submission_events (
  id             bigserial primary key,
  submission_id  uuid not null references public.submissions(id) on delete cascade,
  at             timestamptz not null default now(),
  actor_id       uuid references public.app_users(id),   -- null = system
  event          text not null,   -- project_selected | file_uploaded | format_verified
                                  -- | project_key_matched | permission_verified
                                  -- | period_validated | parse_finished | confirmed | superseded
  level          text not null default 'ok'
                   check (level in ('ok','warn','error','info')),
  detail         jsonb
);

create index on public.submission_events (submission_id, at);

-- ---------- Dependencies (belum ada di DB) ----------
create table public.dependencies (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid references public.submissions(id) on delete cascade,
  project_key    text references public.projects(key) on delete set null,
  source_kind    text check (source_kind in ('mom','checklist')),
  title          text not null,
  depends_on     text,        -- project lain / team / vendor / sistem eksternal
  direction      text default 'outbound'
                   check (direction in ('inbound','outbound')),
  jira_issue_key text,
  status         text not null default 'Open'
                   check (status in ('Open','In Progress','Resolved')),
  pic            text,
  target_date    date,
  notes          text,
  source         text not null default 'upload'
                   check (source in ('upload','manual','jira')),
  confidence     numeric(3,2),   -- diisi kalau hasil LLM
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
```

### 3.2 Migrasi tabel eksisting

`wins` dan `blockers` harus di-scope. Kolom baru **nullable** supaya 9 baris eksisting tetap valid.

```sql
alter table public.wins
  add column project_key   text references public.projects(key) on delete set null,
  add column submission_id uuid references public.submissions(id) on delete cascade,
  add column source        text not null default 'manual'
       check (source in ('upload','manual','jira')),
  add column source_kind   text check (source_kind in ('mom','checklist')),
  add column confidence    numeric(3,2);

alter table public.blockers
  add column project_key   text references public.projects(key) on delete set null,
  add column submission_id uuid references public.submissions(id) on delete cascade,
  add column source        text not null default 'manual'
       check (source in ('upload','manual','jira')),
  add column source_kind   text check (source_kind in ('mom','checklist')),
  add column confidence    numeric(3,2);

create index on public.wins     (submission_id);
create index on public.wins     (project_key, win_date desc);
create index on public.blockers (submission_id);
create index on public.blockers (project_key, status);
```

**Backfill `project_key` dari `jira_issue_key`.** 9 baris eksisting punya `jira_issue_key`
seperti `LUM-482`; prefix sebelum tanda hubung adalah key project. Ini menutup sebagian besar baris:

```sql
update public.wins w
   set project_key = split_part(w.jira_issue_key, '-', 1)
 where w.jira_issue_key is not null
   and exists (select 1 from public.projects p
                where p.key = split_part(w.jira_issue_key, '-', 1));
-- ulangi untuk public.blockers
```

Baris tanpa `jira_issue_key` harus di-assign manual. Jangan tebak.

**Keputusan yang perlu diambil — `wins.category`:**
CHECK saat ini mengunci ke `'Platform' | 'DCB' | 'Digital Payment'`. Kalau team lain punya kategori lain, insert akan gagal. Dua opsi:

- **(a)** Drop CHECK, ganti tabel lookup `win_categories(code, label, is_active)` + FK. Fleksibel, admin bisa tambah kategori. **Direkomendasikan.**
- **(b)** Pertahankan CHECK, parser wajib map kategori tak dikenal → nilai default. Lebih simpel, tapi kehilangan informasi.

---

## 4. Status compliance — satu sumber kebenaran

Jangan hitung warna di frontend. Taruh di SQL, expose lewat view.

```sql
create or replace function public.compliance_state(
  p_due_at         timestamptz,
  p_has_submission boolean,
  p_warn_days      smallint,
  p_late_days      smallint,
  p_now            timestamptz default now()
) returns text
language sql immutable as $$
  select case
    when p_has_submission                                    then 'green'
    when p_now <= p_due_at                                   then 'pending'
    when p_now <= p_due_at + (p_late_days || ' days')::interval then 'orange'
    else 'red'
  end;
$$;
```

Catatan urutan ambang: `orange` mulai tepat setelah `due_at` lewat. `warn_after_days` disimpan untuk keperluan notifikasi/reminder (kirim peringatan H+`warn_after_days`), **bukan** untuk transisi warna — supaya tidak ada celah abu-abu antara `due` dan `due + warn`. Kalau memang ingin ada grace period diam sebelum orange, ganti cabang kedua jadi `p_now <= p_due_at + warn_days`.

View untuk konsumsi UI:

```sql
create or replace view public.v_compliance_status as
select
  p.id            as period_id,
  pr.key          as project_key,
  pr.name         as project_name,
  pr.category,
  t.id            as team_id,
  t.name          as team_name,
  p.period_type,
  p.period_start,
  p.period_end,
  p.due_at,
  s.id            as submission_id,
  s.kind          as submission_kind,
  s.uploaded_at,
  s.parse_status,
  public.compliance_state(
    p.due_at, s.id is not null,
    pol.warn_after_days, pol.late_after_days
  ) as state,
  case when s.id is null
       then greatest(0, extract(day from now() - p.due_at)::int)
       else 0 end as days_late
from public.compliance_periods p
join public.projects pr             on pr.key = p.project_key
left join public.teams t            on t.id = pr.team_id
join public.compliance_policies pol on pol.id = p.policy_id
left join lateral (
  select s2.* from public.submissions s2
  where s2.period_id = p.id and s2.superseded_by is null
  order by s2.uploaded_at desc limit 1
) s on true
where pr.is_tracked and pr.is_active;
```

Klausa `where pr.is_tracked` adalah alasan board tetap terbaca. Ada **90 project** di Jira; kalau
semuanya masuk board, tiap minggu muncul puluhan sel merah dari project yang memang tidak aktif,
dan sinyal pentingnya tenggelam. Admin menandai project mana yang dilacak.

**Catatan penting soal cakupan yang berbeda:** dropdown di halaman Submit menampilkan **semua 90
project** (dibatasi `allowed_project_keys`), sedangkan Compliance Board hanya menampilkan yang
`is_tracked`. Ini disengaja — orang boleh submit report untuk project apa pun yang dia pegang,
tapi hanya project yang di-enroll yang dihitung kepatuhannya. Submission untuk project yang belum
dilacak tetap tersimpan; kalau project itu di-enroll nanti, datanya sudah ada.

### Generasi periode
Periode dibuat lazily saat pertama kali dibutuhkan, bukan lewat cron:

```
GET /api/compliance?weeks=8
  → ensure_periods(tracked_project_keys, range)   -- upsert baris yang belum ada
  → select from v_compliance_status
```

Idempoten karena ada `unique (project_key, period_type, period_start)`. Periode tidak dibuat
sebelum `projects.tracked_from`, supaya project yang baru di-enroll tidak langsung merah untuk
minggu-minggu sebelumnya.

---

## 4b. Sinkronisasi project dari Jira

`projects` adalah cermin dari Jira, bukan daftar yang diketik manual. Sinkron memakai
`getVisibleJiraProjects` (MCP Atlassian sudah terhubung) atau REST `/rest/api/3/project/search`.

```
sync_projects():
  jira = fetch semua project
  upsert projects (key, name, jira_id, last_synced_at)   -- is_tracked TIDAK disentuh
  projects yang tidak ada di Jira → is_active = false     -- jangan hapus
```

Tiga aturan penting:

1. **Jangan pernah overwrite `is_tracked` saat sync.** Ini keputusan admin, bukan data Jira.
2. **Jangan hapus project yang hilang dari Jira** — set `is_active = false`. Submission dan
   wins/blockers historis masih menunjuk ke situ lewat foreign key.
3. **`key` sebagai primary key, bukan `jira_id`.** Key muncul di `jira_issue_key` (`LUM-482`),
   di nama file, dan di percakapan sehari-hari. Konsekuensinya: kalau tim Jira mengubah key
   project, FK ikut berubah. Pakai `on update cascade` pada semua FK yang menunjuk ke
   `projects(key)`, dan catat perubahan key di log sync.

Jumlah nyata di `linkit360.atlassian.net`: **90 project**. Contoh: `AIRPAY` (Airpay Reengineering),
`APMS` (AIRPAY - Monitoring), `APA`, `ARC` (PPOB VIA Software Architect), `PPOBNEW` (PPOB NEW VERSION),
`DSH` (Dashboard Linkit360), `IV` (Integration VAS), `GOR` (E-Governance), `HIT` (HRIS Internal Tools),
`SSCS` (Cepat Sehat), `SSKD` (Surat Sakit & Konsul Dokter), `WSA` (Wakicamp Software Architecture),
`UPM` (Unified Portal Metaplay), `RNDS` (RND Scrum), `SFMCP` (SF MCP AIRPAY).

Sebagian besar dari 90 ini adalah project negara (`KH`, `LA`, `MM`, `PAK`, `PHIL`, `AF`, `EUR`),
fungsi internal (`HRD`, `QAN`, `SYS`, `BOPS`), atau produk lama — memperkuat keputusan opt-in.
90 baris di board tiap minggu tidak akan dibaca siapa pun.

---

## 5. Pipeline upload & ekstraksi (hybrid)

```
POST /api/submissions  (project_key dipilih user di UI sebelum upload)
  ├─ cek project_key ada dan user berhak atas project itu (tidak harus is_tracked)
  ├─ minimal 1 file: checklist, MoM, atau keduanya
  ├─ untuk TIAP file:
  │    ├─ cek project_key di file == project_key yang dipilih  ← lihat catatan di bawah
  │    ├─ validasi: mime, size ≤ 20MB, ekstensi allowlist
  │    └─ hitung sha256 → tolak kalau duplikat di submission yang sama
  ├─ upload tiap file ke Storage bucket `compliance` (private)
  ├─ insert submissions + 1..2 baris submission_files (parse_status='pending')
  ├─ status UI langsung 🟢 green   ← tidak menunggu parsing selesai
  └─ trigger Edge Function `parse-submission` (async)
        ├─ checklist .xlsx  → parse kolom per sheet (deterministik)
        ├─ MoM .md          → parse tabel Markdown (deterministik)
        ├─ MoM .docx/.pdf   → extract text → LLM
        ├─ GABUNG hasil kedua file → lihat §5.5
        └─ tulis wins / blockers / dependencies / todos
```

**Penting:** green ditentukan oleh *keberadaan submission*, bukan oleh sukses parsing. Parsing gagal → tetap green, tapi UI tampilkan badge ⚠️ "analisa gagal, perlu review manual". Ini mencegah project kena merah gara-gara bug parser.

**Konflik `project_key`.** User memilih project di dropdown, tapi file juga berisi `project_key`
di sheet `Meta`. Kalau keduanya beda, ini hampir selalu berarti orang salah pilih di dropdown
atau menyalin file minggu lalu dari project lain. **Jangan diam-diam pakai salah satunya.**
Hentikan upload, tampilkan keduanya, minta user memilih mana yang benar. Ini satu-satunya cara
mencegah data masuk ke project yang salah — kesalahan yang sangat sulit dideteksi setelah tersimpan.

### 5.1 Jalur A — checklist spreadsheet (kolom, deterministik)

Untuk `.xls` / `.xlsx`. Tidak pakai LLM sama sekali → gratis, cepat, reproducible.

| Library | Kapan |
|---|---|
| `xlrd` | `.xls` format lama (BIFF). **Wajib** — SheetJS/openpyxl tidak baca `.xls` lama dengan andal |
| `openpyxl` / SheetJS | `.xlsx` |

Langkah:
1. Deteksi baris header (scan 10 baris pertama, cari yang paling banyak match ke kamus kolom).
2. Normalisasi nama kolom: lowercase, strip, buang non-alfanumerik.
3. Map ke field target lewat kamus sinonim.
4. Baris tanpa kolom wajib → masuk `analysis.unmapped_rows` untuk review.

Kamus sinonim awal (**perlu dikonfirmasi terhadap file asli**):

```
win          ← win, wins, achievement, pencapaian, delivered, completed
blocker      ← blocker, blockers, issue, kendala, hambatan, risk
dependency   ← dependency, dependencies, depends on, ketergantungan, blocked by
pic          ← pic, owner, assignee, penanggung jawab
status       ← status, state, progress
priority     ← priority, prioritas, severity, p0/p1
target_date  ← target, due, deadline, eta, target date
jira_key     ← jira, issue key, ticket, key
project      ← project, projek, proyek, integrasi, integration
```

### 5.2 Jalur B — MoM free-text (LLM, JSON schema ketat)

Untuk `.docx` / `.pdf` / `.md` / `.txt`, atau sel free-text di spreadsheet.

- Ekstraksi teks dulu: `python-docx` (docx), `pdfplumber` (pdf).
- Satu LLM call dengan **structured output / JSON schema**, bukan free-form prompt.
- Suhu 0. Wajib sertakan `confidence` per item dan `source_quote` (kutipan asli).
- Item dengan `confidence < 0.6` ditandai untuk review manual, tidak langsung dipercaya.
- **Jangan pakai regex** untuk ini — bahasa MoM campur ID/EN dan tidak terstruktur.

Batasan: kalau MoM > ~50 halaman, chunk per heading lalu merge. Simpan `analysis.chunks_processed` untuk audit.

### 5.4b Parser profile dan penolakan versi

**Satu profil, banyak project.** Mulai dengan satu profil `default` untuk seluruh 90 project.
Profil baru dibuat hanya kalau ada kebutuhan yang tidak bisa ditampung kolom `notes` — bukan
karena tiap tim ingin urutan kolom sendiri.

Alasan menolak model "satu parser per project": 90 project berarti 90 definisi untuk dirawat.
Setiap penambahan kolom menyentuh 90 tempat, setiap bug diperbaiki 90 kali, dan dalam beberapa
bulan tidak ada yang tahu lagi definisi mana yang masih dipakai. Struktur laporannya sendiri
identik antar project — yang berbeda hanya isinya.

Bentuk `parser_profiles.sheets`:

```jsonc
{
  "Meta":   { "required": ["project_key","period_type","period_start","period_end","submitted_by"] },
  "Wins":   { "header_row": 1, "data_from": 3,
              "columns": ["win_date","category","title","description","jira_issue_key","impact"],
              "required": ["win_date","category","title"],
              "enums": { "category": ["Platform","DCB","Digital Payment"] } },
  "Blockers": { "columns": ["title","priority","status","pic","bottleneck","next_action",
                            "target_date","jira_issue_key"],
                "required": ["title","priority","status","pic","bottleneck","next_action"],
                "enums": { "priority": ["P0","P1","P2","P3","P4"],
                           "status": ["Open","In Progress","Resolved"] } },
  "Dependencies": { "columns": ["title","depends_on","direction","status","pic",
                                "target_date","jira_issue_key","notes"],
                    "required": ["title","depends_on","direction","status"],
                    "enums": { "direction": ["inbound","outbound"],
                               "status": ["Open","In Progress","Resolved"] } },
  "Todos":  { "columns": ["title","pic","due_date","priority","status","jira_issue_key","notes"],
              "required": ["title","pic","due_date","priority","status"],
              "enums": { "priority": ["P0","P1","P2","P3","P4"],
                         "status": ["Not Started","In Progress","Done","Blocked"] } }
}
```

Parser membaca definisi ini dari database, bukan dari konstanta di kode. Itu yang membuat
penambahan profil tidak butuh deploy.

#### Template yang diunduh sudah terisi

Tombol unduh di drawer sudah tahu project dan periode yang dipilih, jadi sheet `Meta`
di-generate terisi dan sel-selnya di-protect:

```
GET /api/templates/checklist?project_key=AIRPAY&period_start=2026-08-03
  → Checklist_AIRPAY_W32_v2.xlsx
    Meta.project_key    = AIRPAY          (locked)
    Meta.project_name   = Airpay Reengineering
    Meta.period_start   = 2026-08-03      (locked)
    Meta.period_end     = 2026-08-09      (locked)
    Meta.submitted_by   = <email session>
    Meta.schema_version = 2               (locked)
    Meta.parser_profile = default         (locked, hidden)
```

Ini menghapus seluruh kelas kesalahan "salah ketik project_key" dan "salah salin file minggu lalu"
di titik paling awal — jauh lebih murah daripada mendeteksinya saat upload.

#### Aturan penolakan

Bedakan kesalahan struktur dari kesalahan isi. Keduanya diperlakukan berbeda:

| Masalah | Aksi | Alasan |
|---|---|---|
| Sheet hilang / header beda / `schema_version` usang | **Tolak upload** (422) | Ketahuan instan dan bisa diperbaiki saat itu juga. Menerimanya menghasilkan submission hijau tanpa isi — kepatuhan palsu |
| `parser_profile` di file ≠ profil project | **Tolak upload** (422) | Kolom tidak akan cocok; hasil parsing pasti salah |
| `project_key` di file ≠ project yang dipilih | **Tolak upload** (422) | Data bisa masuk project yang salah, hampir mustahil terdeteksi setelah tersimpan |
| Periode di file ≠ periode berjalan | **Tolak upload** (422) | Sama seperti di atas |
| Satu baris `priority` berisi `"High"` | **Terima**, `unmapped_rows[]` | Menolak seluruh file karena satu sel salah ketik akan membuat orang berhenti memakai fitur ini |
| Kolom opsional kosong | **Terima** | Bukan kesalahan |

Bentuk respons penolakan — sebutkan **apa** yang berbeda, jangan hanya bahwa berbeda:

```jsonc
// 422
{
  "error": "template_mismatch",
  "expected": { "schema_version": 2, "parser_profile": "default" },
  "found":    { "schema_version": 1, "parser_profile": "default" },
  "differences": [
    { "type": "missing_sheet",  "sheet": "Todos" },
    { "type": "missing_column", "sheet": "Wins", "column": "impact" }
  ],
  "download_url": "/api/templates/checklist?project_key=AIRPAY&period_start=2026-08-03"
}
```

UI menampilkan perbedaan itu apa adanya, plus tombol unduh template yang benar. Pesan
"Format tidak valid" memaksa orang menebak, dan menebak berarti mencoba berulang kali sampai
menyerah.

#### Menaikkan versi

Saat kolom berubah: buat baris profil baru (`default` v3), **pertahankan handler v2**, lalu
pindahkan project satu per satu. Jangan pernah menghapus versi lama — reparse dibutuhkan setiap
kali ada bug di parser, dan file lama harus tetap bisa dibaca.

### 5.5 Menggabungkan checklist + MoM

Kalau kedua file diupload, hasilnya digabung ke satu himpunan baris per kategori. Aturannya:

1. **Parse tiap file terpisah**, catat asal tiap baris di `source_kind` (`checklist` atau `mom`).
   Ini yang memungkinkan pertanyaan "angka ini datang dari mana" dijawab tanpa membuka file.
2. **Lebur duplikat.** Dua baris dianggap sama kalau `jira_issue_key` sama, atau — bila keduanya
   kosong — judulnya sama setelah dinormalisasi (lowercase, rapatkan spasi, buang tanda baca ujung).
3. **Saat konflik, checklist menang** untuk field terstruktur (`priority`, `status`, `due_date`,
   `target_date`). Checklist punya dropdown validation; MoM adalah teks bebas yang nilainya ditebak.
4. **MoM menang** untuk field naratif (`description`, `notes`, `bottleneck`, `next_action`) kalau
   checklist mengosongkannya. MoM biasanya memuat konteks yang tidak muat di sel spreadsheet.
5. **Catat tiap peleburan** di `analysis.merged[]` — `{key, kept_from, dropped_from, fields_overridden[]}`.

Jangan diam-diam membuang baris yang mirip tapi tidak identik. Kalau kemiripan judul di bawah
ambang tapi di atas 0,8, tandai sebagai `analysis.possible_duplicates[]` dan minta user memutuskan.
Melebur dua item yang sebenarnya berbeda akan menghilangkan blocker dari laporan, dan tidak ada
yang akan menyadarinya.

### 5.6 To Do dan tenggat

`todos.due_date` **wajib**. To-do tanpa tenggat tidak bisa dihitung terlambat, jadi tidak ada
gunanya di laporan governance — baris tanpa `due_date` ditolak dan masuk `unmapped_rows`.

Status tenggat dihitung on-read lewat `todo_state()` (§3.1), sama seperti warna compliance:

| Kondisi | State |
|---|---|
| `status = 'Done'` | `done` |
| `status = 'Blocked'` | `blocked` |
| `now > due_date` | `overdue` |
| `now = due_date` | `due_today` |
| `due_date - now ≤ 3 hari` | `due_soon` |
| sisanya | `on_track` |

`blocked` sengaja diperiksa **sebelum** `overdue`. To-do yang terblokir oleh pihak lain dan lewat
tenggat bukan kelalaian PIC-nya — menandainya merah akan menyalahkan orang yang salah dan
mendorong orang menghindari status `Blocked`.

### 5.3 Bentuk `submissions.analysis`

```jsonc
{
  "schema_version": 1,
  "parse_method": "hybrid",
  "parsed_at": "2026-08-04T10:00:00Z",
  "source_format": "xls",
  "sheet_names": ["Week 31", "Notes"],
  "header_row_index": 3,
  "files": [
    { "kind": "checklist", "name": "Checklist_AIRPAY_W32.xlsx", "method": "column" },
    { "kind": "mom",       "name": "MoM_AIRPAY_W32.md",         "method": "markdown" }
  ],
  "counts": { "wins": 4, "blockers": 2, "dependencies": 3, "todos": 5 },
  "counts_by_source": {
    "checklist": { "wins": 3, "blockers": 2, "dependencies": 2, "todos": 4 },
    "mom":       { "wins": 2, "blockers": 1, "dependencies": 2, "todos": 3 }
  },
  "merged": [
    { "key": "AIRPAY-501", "kept_from": "checklist", "dropped_from": "mom",
      "fields_overridden": ["notes"] }
  ],
  "possible_duplicates": [],
  "projects": ["AirPay", "Lumos"],
  "integrations": ["DCB Telkomsel", "PPOB Bank X"],
  "unmapped_rows": [ { "row": 17, "raw": {} } ],
  "warnings": ["kolom 'Target Date' tidak ditemukan"],
  "llm": { "model": "...", "input_tokens": 0, "output_tokens": 0 }
}
```

Row terstruktur tetap ditulis ke tabel `wins` / `blockers` / `dependencies` / `todos`.
`analysis` hanya untuk audit, debugging, dan hal yang tak masuk skema.

### 5.4 Re-upload
Submission baru untuk periode yang sama → submission lama di-set `superseded_by`, baris
`wins`/`blockers`/`dependencies`/`todos` miliknya ikut terhapus lewat `on delete cascade`.
History file tetap tersimpan di Storage.

Menambahkan file kedua ke submission yang sudah ada (misal checklist dulu, MoM menyusul)
**bukan** re-upload: cukup insert satu baris `submission_files` lalu jalankan ulang penggabungan.
Ini kasus yang lumrah — checklist dikirim sebelum rapat, MoM sesudahnya.

---

## 6. Storage

Bucket `compliance`, **private** (bukan public).

```
compliance/{project_key}/{period_type}/{period_start}/{submission_id}__{filename}
```

- Akses lewat signed URL, TTL 60 detik, digenerate server-side setelah cek izin.
- Allowlist ekstensi: `.xls .xlsx .csv .docx .pdf .md .txt`. Tolak sisanya.
- Max 20 MB per file.
- Validasi **magic bytes**, bukan hanya ekstensi — nama file bisa dipalsukan.

---

## 7. Otorisasi — perhatian khusus

Portal pakai auth custom (`app_users.password_hash` + `password_salt`), **bukan Supabase Auth**. Konsekuensi: `auth.uid()` kosong, jadi RLS pola standar tidak jalan.

Tiga opsi, urut dari yang paling direkomendasikan:

**(a) Semua akses lewat API route server-side (rekomendasi jangka pendek).**
Frontend tidak pernah pegang service-role key. Next.js route handler verifikasi session, cek `app_users.allowed_project_keys`, baru query Supabase pakai service role. RLS tetap `enabled` + tanpa policy permisif sebagai jaring pengaman — kalau ada anon key bocor, tidak ada yang bisa dibaca.

**(b) Migrasi ke Supabase Auth.** Paling benar jangka panjang, RLS jadi natural. Tapi ini pekerjaan terpisah dan menyentuh flow login yang sudah jalan — jangan digabung ke fitur ini.

**(c) Custom JWT claim.** Terbitkan JWT sendiri berisi `team_ids`, RLS baca `current_setting('request.jwt.claims')`. Jalan, tapi kompleksitas key management tidak sepadan untuk skala saat ini.

Matriks izin:

| Aksi | Siapa |
|---|---|
| Upload submission untuk project X | user yang punya X di `allowed_project_keys`, atau admin |
| Lihat status project X | sama seperti di atas |
| Lihat semua project | admin (`is_admin = true`) |
| Tandai project dilacak (`is_tracked`) | admin |
| Atur policy / threshold per project | admin |
| Hapus submission | admin |

**Catatan keamanan:** `app_users.allowed_project_keys` sudah berisi key Jira — sekarang ini
cocok persis dengan `projects.key`, jadi otorisasi menjadi langsung: `project_key = any(allowed_project_keys)`.
Ini keuntungan tak terduga dari memindahkan unit compliance ke project; dengan model berbasis team
sebelumnya, dibutuhkan lapisan mapping tambahan yang rawan salah.

Evaluasi keanggotaan ini **wajib di server**. Dropdown project di UI hanya kenyamanan tampilan —
selalu cek ulang `project_key` yang dikirim di `POST /api/submissions` terhadap
`allowed_project_keys` milik session, jangan percaya nilai dari client.

---

## 8. API contract

```
GET    /api/submissions?from=&to=&project_key=&status=
       → daftar untuk tabel di halaman Submit
       [{ id, project_key, project_name, period_start, period_end, week_label,
           kind, file_name, uploaded_by_name, uploaded_at, state, parse_status,
           needs_review }]

GET    /api/submissions/:id/events
       → [{ at, actor_name, event, level, detail }]   -- activity log di drawer

GET    /api/templates/checklist?project_key=&period_start=
       → .xlsx dengan sheet Meta terisi + terkunci, dinamai
         Checklist_<KEY>_W<nn>_v<schema>.xlsx
GET    /api/templates/mom?project_key=&period_start=
       → .md dengan YAML frontmatter terisi

GET    /api/parser-profiles                     (admin)
PUT    /api/projects/:key/parser-profile        (admin) — { parser_profile }

GET    /api/projects?tracked=true
       → [{ key, name, category, team_id, team_name, is_tracked,
             current_period: { period_start, due_at, state, days_late } }]
       Hanya project yang ada di allowed_project_keys user (admin: semua)

GET    /api/compliance?from=&to=&project_key=&team_id=
       → [{ period_id, project_key, project_name, team_name, period_start, due_at,
             state, days_late, submission_kind, uploaded_at, parse_status }]

POST   /api/submissions            (multipart)
       body: project_key, period_id | period_start, kind, file
       → 201 { submission_id, state:'green', parse_status:'pending' }
       → 403 kalau project_key tidak ada di allowed_project_keys
       → 409 kalau sha256 duplikat di periode yang sama
       → 422 kalau project_key di file ≠ project_key yang dipilih
             { error:'project_mismatch', selected:'AIRPAY', in_file:'APMS' }

POST   /api/projects/sync                      (admin) — tarik ulang dari Jira
PUT    /api/projects/:key/tracking             (admin) — { is_tracked, tracked_from }

GET    /api/submissions/:id
       → { ...submission, wins[], blockers[], dependencies[], analysis }

GET    /api/submissions/:id/file   → 302 ke signed URL (TTL 60s)

DELETE /api/submissions/:id        (admin)

GET    /api/compliance/policies                   (admin)
PUT    /api/compliance/policies/:project_key      (admin)
       body: { period_type, due_dow|due_dom, due_time, timezone,
               warn_after_days, late_after_days }
```

---

## 9. UI

Menu baru di sidebar, sejajar `Report AirPay`:

```
Governance
  ├─ Submit               ← daftar submission + tombol "Submit report" → drawer form
  ├─ Compliance Board     ← semua project dilacak: mana on time, mana telat
  └─ Settings             ← admin: project mana dilacak + threshold per project
```

### 9.1 Halaman Submit

Isinya **daftar submission yang sudah dikirim**, bukan form. Form hidup di drawer yang dibuka
lewat tombol `Submit report`.

Kolom tabel: Project · Periode · Jenis · File · Diupload oleh · Waktu · Status · Detail.
Filter: pencarian bebas, project, status (on time / telat / perlu review).

Alasan daftar jadi tampilan utama: pertanyaan yang paling sering muncul saat orang membuka
halaman ini bukan "bagaimana cara upload", tapi "apakah minggu ini sudah dikirim, dan oleh siapa".
Form yang langsung terbuka memaksa semua orang melewati layar yang hanya relevan bagi sebagian.

**Drawer form** — empat langkah berurutan, tiap langkah terkunci sampai langkah sebelumnya selesai:

| # | Langkah | Perilaku |
|---|---|---|
| 1 | Pilih project | Dropdown dapat dicari, hanya `is_tracked` ∩ `allowed_project_keys` |
| 2 | Periode | **Read-only.** Minggu, rentang, jatuh tempo, status — diturunkan dari policy project |
| 3 | Upload checklist | Tab Checklist / MoM + dropzone + tombol unduh template. Terkunci sampai langkah 1 selesai |
| 4 | Activity | Log aktivitas user, ditulis bertahap saat validasi berjalan |

Periode sengaja **tidak bisa dipilih manual**. Membiarkan orang memilih minggu membuka pintu
untuk submit ke periode yang salah, dan tidak ada cara mendeteksinya setelah tersimpan.
Kalau perlu submit periode lampau, itu tindakan admin yang terpisah dan tercatat.

### 9.2 Activity log (langkah 4)

Yang ditampilkan di drawer adalah **jejak aktivitas user**, bukan tabel wins/blockers/dependencies:

```
· Project dipilih              AIRPAY — Airpay Reengineering
· File diupload                Checklist_AIRPAY_W32.xlsx · 18.2 KB
✓ Format file diverifikasi     magic bytes PK\x03\x04 → xlsx valid
✓ Ukuran file dicek            18.2 KB · di bawah batas 20 MB
✓ Sheet Meta dibaca            schema_version 1 · 5 sheet ditemukan
✓ project_key dicocokkan       AIRPAY di file = AIRPAY yang dipilih
✓ Izin diverifikasi            AIRPAY ada di allowed_project_keys
✓ Periode divalidasi           2026-08-03 → 2026-08-09 · sesuai policy
! Parsing selesai              5 baris terbaca dari 6
                               1 baris dilewati — kolom priority berisi "High", bukan P0–P4
✓ Submission dikonfirmasi      oleh Ricky · 2026-08-10 09:16
```

Hasil ekstraksi wins/blockers/dependencies pindah ke **Compliance Board**. Alasannya: saat submit,
yang perlu diketahui user adalah *apakah filenya diterima dan apa yang gagal* — bukan membaca
ulang isi file yang barusan dia buat sendiri.

Log ini bukan sekadar tampilan. Simpan sebagai `submission_events(submission_id, at, actor_id,
event, detail jsonb)` — ini yang menjawab "siapa mengubah data ini dan kapan" saat ada sengketa
soal angka di report bulanan.

### 9.3 Compliance Board

Halaman terpisah, sumbernya checklist dan MoM yang sudah diupload.

- **KPI** — on time, telat H+1…H+3, telat > H+3, rata-rata keterlambatan.
- **Grid** — baris = project, dikelompokkan per team, kolom = minggu, plus kolom rasio `On time`
  (`5/6`). Rasio, bukan satu warna rata-rata: merata-ratakan beberapa minggu jadi satu warna
  menyembunyikan minggu yang bermasalah.
- **Detail minggu berjalan** — per project: status, waktu submit terakhir, jumlah wins / blockers /
  dependencies, tombol detail. Di sinilah hasil ekstraksi dibaca.

Grid compliance **dihapus dari halaman Submit** — dua tempat menampilkan status yang sama
akan menyimpang begitu salah satunya lupa diperbarui.

Aksesibilitas: **warna saja tidak cukup.** Tambahkan ikon + label teks di tiap sel (✓ / ! / ✕ / –) supaya terbaca oleh pengguna buta warna dan tetap jelas saat dicetak hitam-putih.

Ringkasan atas: jumlah team green / orange / red, total blocker terbuka, total dependency terbuka.

---

## 10. Urutan implementasi

| # | Langkah | Ketergantungan |
|---|---|---|
| 1 | Konfirmasi format 2 file contoh, kunci kamus kolom | **file belum ter-attach** |
| 2 | Migration: `teams`, `projects`, `compliance_policies`, `compliance_periods`, `submissions`, `dependencies` | — |
| 2b | Sync project dari Jira + UI admin untuk menandai `is_tracked` | 2 |
| 3 | Migration: alter `wins` + `blockers`, backfill `project_key` dari `jira_issue_key` | 2b |
| 4 | Putuskan nasib CHECK `wins.category` (opsi a atau b) | 3 |
| 5 | Storage bucket `compliance` + kebijakan signed URL | — |
| 6 | Fungsi `compliance_state` + view `v_compliance_status` + `ensure_periods` | 2 |
| 7 | API route upload + list (server-side authz, §7a) + cek `project_mismatch` | 5, 6 |
| 7b | Tabel `parser_profiles` + seed profil `default` + endpoint template ter-personalisasi | 2, 7 |
| 8 | Edge Function `parse-submission` — baca definisi kolom dari `parser_profiles.sheets` | 1, 7b |
| 9 | Edge Function — jalur LLM untuk MoM | 8 |
| 10 | UI halaman Submit (daftar + drawer form 4 langkah) | 7 |
| 10b | UI Compliance Board (KPI + grid + detail minggu berjalan) | 7 |
| 10c | Tabel `submission_events` + tulis log di tiap langkah validasi | 7 |
| 11 | Verifikasi: uji parser dengan file asli, cek transisi warna dengan tanggal palsu | semua |

Langkah 11 wajib. Uji transisi warna dengan menyuntik `p_now` ke `compliance_state()` — jangan menunggu waktu nyata berlalu.

---

## 11. Hal yang masih terbuka

1. **Format file contoh belum diketahui.** Kamus kolom di §5.1 adalah tebakan. Wajib dikonfirmasi.
2. Format MoM apa? `.docx`, `.pdf`, atau Confluence page? Kalau Confluence — MCP Atlassian sudah terhubung, bisa tarik langsung tanpa upload.
3. Project mana saja yang perlu ditandai `is_tracked` di awal? Dari 50+ project Jira, kemungkinan hanya sebagian kecil yang butuh governance mingguan.
4. Perlu notifikasi (email/Slack) saat orange/red, atau cukup visual di dashboard?
5. `tracked_from` tiap project — mulai kapan dihitung? Backfill historis atau mulai dari minggu berjalan?
6. Apakah wins/blockers hasil upload harus di-sync balik ke Jira sebagai issue, atau cukup hidup di portal?
7. Satu project bisa punya beberapa team pengisi (misal AIRPAY dikerjakan dua squad)? Model saat ini mengasumsikan satu project = satu owning team.
