# Nutri Chapina — M0/M1 reviewer packet (for third-party review before M2)

Date: 2026-11-25. Repo: https://github.com/aaronbateman02/nutrichapina (branch `main`).
Live staging: https://staging.nutrichapina.com (landing, `/dashboard`, `/manage`, `/admin`).
Production: https://nutrichapina.com (unchanged static demo; no API routes, no accounts).

## 1. What was delivered

**M0 (audit, repo, staging, preservation) — done and verified:**
- Git repo created; live production snapshot vendored (`apps/static-site/site/`: landing ES-default, dashboard demo + nutrition estimates, `/manage` practice-console demo from sibling agent).
- Encrypted off-instance backup (`backups/` ignored by git; passphrase with owner), restore-tested from tarball listing.
- Staging env: own container/network/ports, own LE cert to 2027-02-23, X-Robots noindex, resource caps (static 256m/0.5cpu).
- Route inventory, deploy + rollback playbook, secrets inventory (names only) in `docs/M0_AUDIT.md`; `docs/ADR-001-hosting-and-stack.md`.
- Secrets scan clean (repo + `/opt/nutrichapina*`).

**M1 (auth, roles, shared DB) — done on staging, tested:**
- Stack (`docs/ADR-002-backend-stack.md`): Node 22 + TS strict + Express 5 + Zod, Postgres 16 in its own container/volume/loopback (`127.0.0.1:5433`), raw-SQL versioned migrations, bcrypt-12, 15-min JWT access + rotating refresh in httpOnly Secure SameSite cookies, single-use email/reset tokens, staging outbox instead of SMTP.
- Schema: 5 migrations — identity/roles/sessions, profiles/household/consents/audit, billing+credit shells, recipes+immutable revisions, plans/grocery/appointments/messaging shells.
- Endpoints: `/api/v1/auth/*` (register, verify, login, refresh, logout, request/reset), `GET/PATCH /me`, `PUT /me/household`, consents, `/api/v1/staff/clients*` (RBAC: admin full, dietitian assigned-scope only).
- `/manage` (sibling agent's console) wired to the API on staging: anonymous = unchanged fictional demo; staff sign-in → live records only, never mixed; create-customer (admin) through the UI.
- Dashboard probe: signed-in visitors see an account chip (graceful no-op in prod).
- Interim staging-only `/admin` shell exists for API testing; slated for removal once `/manage` wiring is approved (single-console decision).

## 2. Test evidence (all in `docs/M1_EVIDENCE.md`)

- Vitest + Supertest, 8/8 pass on ephemeral test DB: registration validation/dedupe, verification single-use + replay rejection, login gating pre-verification, session read + household persistence, refresh rotation, logout revocation, cross-customer isolation, staff-gate 403s, admin create/view, dietitian assigned-scope (sees assigned, 403 on unassigned/unknown), password-reset rotation + session kill, bilingual error strings.
- Live staging walkthrough over nginx + TLS: register → verify-gate → admin login → staff list/create/view → customer login → `/me` → household PUT → persistence → logout → 401. Owner walkthrough: signed into staging `/manage` as administrator, created a real staging customer via UI; verified persisted via API.
- Browser E2E (Chromium): demo renders with zero JS errors; sign-in flips to LIVE pill; clients page lists exactly the 2 real DB records, zero fictional ones; profile drawer shows real fields with honest M4/M5 placeholders. This test caught one real bug (TDZ init blanked the page) — fixed and re-verified green.
- Live checks: 401/422 auth envelopes through nginx, `/admin` 200, sanitized error logs (no request bodies), prod untouched (containers up 2+ days).

## 3. Decision register (business vs technical)

Full table: `docs/DECISION_REGISTER.md`. All D01–D15 remain OPEN with safe scaffolds (no live prices, no forfeiture, no clinical intake, `nutrition_verified:false` default, manual grocery export, no live booking/retailer/AI). Technical decisions T01–T06 made independently and recorded. Nothing requires the reviewer to unblock except noting disagreements.

## 4. Honest disclosures (please probe these)

1. **Two transient secret exposures during provisioning:** DB password and JWT secret were printed into operator shell output while writing env files (my mistake, twice). Both were rotated immediately (fresh Postgres volume + new secrets, old files deleted); the exposed values were never used by any running service and lived <1 hour. Current secrets exist only in root-owned `/opt/nutrichapina-staging/*` and were never committed (verified by scan). Backup passphrase is owner-held, gitignored.
2. **Demo nutrition estimates** in the dashboard modal are my computed estimates, labeled illustrative, never reviewed — must not seed approved data (per D14). Migration to dietitian-verified values is M2 work.
3. **Staging DB contains 3 test accounts**, one with the owner's real email (owner-entered during walkthrough). No other real customer data anywhere. Staging has no backup/retention policy yet.
4. **No git history for pre-repo deploys** (manual file copies); M0 snapshot is the baseline. Sibling agent's `/manage` + `firefly-studio` container appeared mid-stream; both preserved untouched.
5. **Known simplifications:** in-memory rate limiter (single instance; replace before horizontal scale); TOTP enrollment endpoint deferred (types + flag ready); support role ungranted; dietitian sees assigned clients only; dashboard account chip verified served + API-verified, full click-through done only for `/manage`, not dashboard.
6. **One false alarm documented:** a logout 404 during testing was my curl missing `-X POST`, not an app bug — retested correctly, logout revokes as designed.

## 5. What the reviewer can check right now (read-only unless noted)

- `https://staging.nutrichapina.com/` and `/dashboard/` and `/manage/` load over valid TLS (HSTS on).
- `GET https://staging.nutrichapina.com/api/v1/me` → 401 envelope (no session).
- Repo: `IMPLEMENTATION_STATUS.md`, `docs/M0_AUDIT.md`, `docs/ADR-001*`, `docs/ADR-002*`, `docs/DECISION_REGISTER.md`, `docs/M1_EVIDENCE.md`, `apps/api` source + migrations + tests.
- Interactive check needs a staging account (ask the owner — provisioned in seconds via the admin API; nothing self-registers into staff roles).

## 6. Proposed M2 next (awaiting reviewer feedback + owner go-ahead)

Admin recipe/ingredient manual editor with strict draft → review → approved → published versioning against the M1 schema (`004_recipes.sql`), bilingual preview, dietitian approval gate; first content: `recipes/drafts/raspberry-banana-yogurt-parfait.md` (unreviewed draft, source-attributed, steps TODO). No website scraping (copyright/terms), no unverified nutrition promotion.
