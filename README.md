# Star Generation — Group Class Enrollment & Billing

Three role-based apps for group classes: students buy hour packages and pay before they get access, tutors schedule lessons and write monthly logbooks, and admins approve logbooks, which is what pays tutors.

| Repo | What | Port |
|---|---|---|
| **[sg-api](https://github.com/dimsurd/sg-api)** (this repo) | Express + TypeScript API, PostgreSQL schema & seed, docs | 4000 |
| [sg-app](https://github.com/dimsurd/sg-app) | Next.js PWA for **students and tutors** (mobile-first) | 3000 |
| [sg-backoffice](https://github.com/dimsurd/sg-backoffice) | Next.js back office for **admins** | 3001 |

- [ARCHITECTURE.md](ARCHITECTURE.md): data model, where business rules are enforced, and the design system
- [DECISIONS.md](DECISIONS.md): answers to the open decisions, the improvement, and what's next
- API reference: [`openapi.yaml`](openapi.yaml), served as Swagger UI at http://localhost:4000/docs

## Seeded logins

All passwords are `Password123!`. There is no sign-up flow.

| Email | Role | Sign in at | Seeded state |
|---|---|---|---|
| `admin@stargeneration.test` | Admin | back office (:3001) | — |
| `tutor1@stargeneration.test` | Tutor | app (:3000) | Teaches **Math Group A** |
| `tutor2@stargeneration.test` | Tutor | app (:3000) | No class yet |
| `student1@stargeneration.test` | Student | app (:3000) | Enrolled and paid (12h): 6h used, 3h booked |
| `student2@stargeneration.test` | Student | app (:3000) | Not enrolled; can take the last seat |
| `student3@stargeneration.test` | Student | app (:3000) | Not enrolled; hits "class full" after student2 |

**Math Group A**: capacity 2, Rp150,000/h for students, Rp100,000/h for the tutor, 12-hour packages.

Seed dates are relative to *today*, so the demo always has:
- two months ago: an approved logbook with earnings
- last month: a submitted logbook waiting for the admin
- two upcoming lessons

## Run it from a fresh clone

**Requirements:** Node.js ≥ 20.9, pnpm, and PostgreSQL ≥ 14 running locally (`psql` on your PATH).

```bash
mkdir star-generation && cd star-generation
git clone git@github.com:dimsurd/sg-api.git
git clone git@github.com:dimsurd/sg-app.git
git clone git@github.com:dimsurd/sg-backoffice.git
```

### 1. API (terminal 1)

```bash
cd sg-api
cp .env.example .env          # set DATABASE_URL if your Postgres isn't on localhost:5432 without a password
pnpm install
pnpm db:reset                 # drops/creates the database, loads db/schema.sql and db/seed.sql
pnpm dev                      # http://localhost:4000  ·  docs at /docs
```

Set `JWT_SECRET` in `.env` to any long random string, e.g. `openssl rand -hex 32`.

### 2. Back office (terminal 2)

```bash
cd sg-backoffice
pnpm install
pnpm dev                      # http://localhost:3001  → sign in as the admin
```

### 3. Student & tutor app (terminal 3)

```bash
cd sg-app
pnpm install
pnpm dev                      # http://localhost:3000  → sign in as a tutor or student
```

Both frontends proxy `/api/*` to `http://localhost:4000`; override it with `API_URL=...`. The service worker only registers in production (`pnpm build && pnpm start`), so dev never serves stale pages.

## Tests

```bash
cd sg-api
pnpm test
```

This creates a separate `star_generation_test` database (override with `TEST_DATABASE_URL`) and runs:
- **Business-rule tests** through the HTTP API against real PostgreSQL: capacity (including two students enrolling at the same moment), duplicate enrollment, WIB times, tutor overlap, hour reservations and refunds on cancel, logbook visibility and read-only approval, idempotent earnings, money visibility per role, and the dashboard maths.
- **Contract tests**: every Express route must be in `openapi.yaml`, and real responses must validate against the documented schemas.

Other scripts: `pnpm typecheck` in any repo, `pnpm lint` in the frontends, and `pnpm gen:api` in the frontends to regenerate API types from the running API's `openapi.yaml`.

## A 5-minute walkthrough

1. **student2** (app): Browse → Enroll → Invoices → *Pay* (simulated). The class unlocks, and student2 is added to the 2 upcoming lessons.
2. **student3** (app): Browse → the class shows **Full**.
3. **tutor1** (app): Teaching → Math Group A → schedule a lesson (WIB). Try an overlapping time to see it rejected.
4. **admin** (back office): Logbooks → last month → check the **earnings preview** → *Request changes*.
5. **tutor1**: the Teaching home shows "sent back". Open it, edit an entry, and *Resubmit*.
6. **admin**: *Approve*. Earnings are recorded once; approving again changes nothing. **student1** can now read that month's logbook, and tutor1's Earnings moves it from pending to approved.
7. **admin** Dashboard: unpaid invoices with aging, students low on hours (*Issue package*), and per-class margin.
