# M1 evidence — staging only, 2026-11-25

## Migrations (staging DB, `node dist/migrate.js`)
applied 001_identity, 002_profiles, 003_billing, 004_recipes, 005_platform.

## Test suite (`npx vitest run`, 8/8 pass, ~7s, ephemeral test DB)
T1 register validates/dedupes/issues verification — pass.
T2 login blocked pre-verification; bad token 410; good token verifies once, replay 410 — pass.
T3 session reads own record; household persists; bad input 422 — pass.
T4 refresh rotates; logout revokes — pass.
T5 second customer isolated (own id only, own household defaults); customer 403 on /staff; anon 401 — pass.
T6 admin creates + views customer; dietitian sees assigned only, 403 on unassigned + unknown id — pass.
T7 reset rotates credentials, kills sessions, single-use enforced — pass.
T8 bilingual error strings (es/en) — pass.

## Live staging checks (through nginx, `staging.nutrichapina.com`)
- `GET /api/v1/me` → 401 `unauthorized` envelope; `POST /api/v1/auth/register` (bad body) → 422 `invalid_input`.
- `GET /admin/` → 200 staff console; `GET /dashboard/app.js` contains account probe (2 refs).
- `GET /` → 200; prod `nutrichapina.com` → 200, prod containers untouched.
- API logs contain no request bodies (sanitized handler verified after malformed POST).
- Staging caps: static 256m/0.5cpu, api 512m/0.5cpu, postgres 1g/1cpu; X-Robots noindex live; LE cert to 2027-02-23; renew timer active.

## Live staging walkthrough (through nginx, fictional accounts, 2026-11-25)
Register → 201 + id; admin promote via SQL; admin login → roles [administrator];
`GET /staff/clients` → list; `POST /staff/clients` → 201 (verified customer);
customer login → roles [customer]; `GET /me` → own record only;
`PUT /me/household` → ok, re-GET shows size 4/beginner/walmart;
customer `GET /staff/clients` → 403; `POST /api/v1/auth/logout` → ok, then `/me` → 401.
Unverified-login gating, replay/single-use, reset, and bilingual errors covered by T2/T7/T8.

## Limitations / deferred
- Full browser click-flow (register → dashboard chip visible) not executed here: no browser automation in this environment; chip verified served + API verified; recommend manual staging walkthrough.
- Support role ungranted; dietitian assigned-scope only; MFA enrollment endpoint deferred to M1-hardening (type + flag ready).
- Mailer is staging outbox; no real SMTP; no real customer data anywhere.
