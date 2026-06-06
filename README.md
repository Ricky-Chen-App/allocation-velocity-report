# Resource Allocation & Velocity Report

Web tool project management yang terhubung ke **Jira Cloud** untuk memantau:

- **Developer Capacity** — utilization per developer dengan paging & section per grup
- **Velocity & Forecast** — estimasi berapa lama seluruh backlog Jira selesai
- **Timeline** — Gantt task per developer dengan filter kategori & project, deteksi reschedule (new start/due date)
- **Task Allocation** — distribusi task per developer
- **Executive Overview** — ringkasan KPI tim
- **Team Members** — kelola jabatan (CTO, PM, BA, QA, Dev) & level tiap anggota
- **Jira Sync** — status sinkronisasi issue

## Tech Stack

- **Backend**: Node.js + Express (proxy ke Jira REST API v3 & Agile API, menghindari CORS)
- **Frontend**: Single-page HTML (DM Sans design system)
- **Cache**: In-memory dengan TTL 10 menit + warmup saat startup

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Konfigurasi environment
cp .env.example .env
#    lalu isi JIRA_DOMAIN, JIRA_EMAIL, JIRA_TOKEN

# 3. Jalankan server
npm start
```

Buka **http://localhost:3000**

## Konfigurasi Scope

Edit di `server.js`:

```js
// Project categories yang diambil
const TARGET_CATEGORIES = ['VAS', 'Product', 'Project', 'Platform Internal', 'QA'];

// User groups yang diambil
const TARGET_GROUPS = [
  'PMO Team', 'Cehat Sehat Developer', 'Developer',
  'Matainja Developer', 'PPOB Developer', 'Waki Developer'
];
```

## Cara Mendapatkan Jira API Token

1. Buka https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token** → salin
3. Masukkan ke `.env` sebagai `JIRA_TOKEN`

## Endpoints

| Endpoint | Fungsi |
|---|---|
| `GET /api/projects` | Project terfilter by category |
| `GET /api/members` | Member dari 6 user group |
| `GET /api/capacity` | Utilization per developer |
| `GET /api/velocity` | Velocity dari sprint/board |
| `GET /api/forecast` | Estimasi penyelesaian backlog |
| `GET /api/timeline` | Data timeline (filter: category, projectKey, group, assigneeId) |
| `GET /api/tasks` | Task allocation |
| `GET /api/sync-status` | Status sync issue |
| `GET/PUT /api/member-profiles` | Profil jabatan & level anggota |
