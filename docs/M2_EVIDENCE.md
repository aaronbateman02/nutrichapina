# M2 evidence — recipe library + menu publishing (staging, 2026-11-25)

Source plan: `Implementation Plans/Nutri_Chapina_Full_Implementation_Plan.zip`
(`docs/RECIPE_LIBRARY_SPEC.md`, `docs/DATA_MODEL_AND_APIS.md`, `docs/ACCEPTANCE_AND_TEST_PLAN.md` T01/T02).
Live production: `https://nutrichapina.com/` untouched. All M2 work targets staging only.

## Migrations (staging DB, `node dist/migrate.js` in throwaway container on staging net)
- 004_recipes (ingredients, translations, conversions, recipes, revisions, contents, items)
- 005_platform (program_templates, client_plans, providers, appointments, conversations, messages)
- 006_menus (program_versions, program_day_slots, client_plan_meals, plan_approval_events,
  recipe_approved_substitutions, recipe_images, appointment_notes)
- 007_program_names (`program_templates.name`, backfilled `Untitled program`)
- 008_program_version_status (M2 closeout: adds `changes_requested` to
  `program_versions.status` CHECK so reviewer return-for-corrections persists;
  004 already allowed it for recipe revisions)
- Deploy 2026-11-25: synced `src/routes/{catalog,programs}.ts`, `tests/m2.test.ts`,
  `migrations/008*` to `/opt/nutrichapina-staging/api`, rebuilt `nutrichapina-api:staging`
  (`tsc` clean inside build), ran 008 via throwaway container, recreated the
  `nutrichapina-api` container with identical config (staging net, 127.0.0.1:8084,
  uploads volume, staging env). Prod containers/files/nginx untouched
  (prod `/` 200, prod `/api` 404 as before — no prod API exists).

## Test suite — ACTUAL STAGING RUN 2026-11-25 (`apps/api/tests/`, ephemeral `nutrichapina_test` DB)
Command (throwaway `node:22-alpine` container on `nutrichapina-staging-net`,
`TEST_DATABASE_URL=.../nutrichapina_test`, `JWT_SECRET=test-only`, `COOKIE_SECURE=false`):
`npm ci && npm test` → **16/16 pass (~20s)**.
- m1.test.ts 10/10: T1 register/dedupe/verify, T2 login gating + replay, T3 session/household,
  T4 refresh/logout, T5 isolation + customer 403 on staff, T6 admin/dietitian scope,
  T7 reset rotation, T9 staff MFA enroll/gate/remove, T10 cross-origin mutations blocked.
- m2.test.ts 6/6: T11 ingredients, T12 recipe lifecycle + immutability, T13 nutrition gate,
  T14 7-day program + assign + grocery math + cross-customer denial, T15 upload validation,
  T16 closeout (explicit validate, deterministic preview 500 g @ 4 servings → 125 g @ 1 /
  250 g @ 2, request-changes → resubmit → approve → publish → archive, duplicate 201/409,
  substitutions, program request-changes/archive 409s on draft).
- First T16 run caught a REAL enforcement working as designed: approve-from-`changes_requested`
  returns 409; the correct loop is changes_requested → edit → resubmit → approve.
  Test was fixed to follow the spec loop; server untouched. Full re-run 6/6 green.
- T11 ingredients: validation 422, case-insensitive duplicate 409, bad conversion 422,
  support 403, customer 403 on staff routes; conversions append-only.
- T12 recipe lifecycle: draft → fix missing `steps_es` → submit → approve requires
  `allergens_reviewed` (422 without) → empty-items draft submittable but never approvable (422)
  → support approve 403 → approve + publish 200 → published immutable (PUT 409)
  → new revision drafts v2, old v1 stays `published`.
- T13 nutrition gate: `verify_nutrition:true` without provenance 422; approved-unverified
  publishes; customer `GET /me/recipes/:rev` 403 before assignment (404 if not published).
- T14 menu: unpublished revision in slots 422; full 7-day (21 slots) put 200;
  publish-before-approve 409; submit → approve (422 with issues if incomplete, 200 when
  7/14/21/28-day complete) → publish; assign snapshots 21 meals; customer reads own plan
  (21 meals) + published recipe with `nutrition:null, nutrition_verified:false`;
  grocery aggregation verified in-test (500 g chicken × 21, 200 g rice × 21);
  customer B cross-read plan 404 / recipe 403.
- T15 uploads: anon 401, customer 403, bad mime 422, bad magic bytes 422,
  1px PNG 201 with `/media/<uuid>.png`, link to draft revision 201, bad path 422,
  detail shows 1 image. Served via `/media` (Express static + staging nginx `/media/` → :8084,
  `ops/staging-nutrichapina.conf`).
- T16 closeout: explicit validate (clean draft `valid:true`); preview scaling deterministic
  (500 g @ 4 servings → 125 g @ 1, 250 g @ 2; bad servings 422); request-changes from
  `ready_for_review` only (support 403, draft-direct 409) → `changes_requested`, still
  editable, then approve/publish/archive; duplicate with new slug 201 (reuse 409);
  substitutions distinct-ids only (same-id 422), list 1, delete ok; program
  request-changes/archive from draft correctly 409.

Run note (this Windows workstation): no local Postgres/Docker here, so the suite was
last green on the staging host path; `npm run build` (tsc) is green locally, and the new
T16 block typechecks clean (`tsc --noEmit` on the test file).
Re-run anywhere: `DATABASE_URL=... TEST_DATABASE_URL=... npx vitest run` → expect 16/16
(10 M1 + 6 M2). Never against production (tests DROP SCHEMA on the TEST database only).

## M2 closeout additions (this pass, additive only — no existing test touched)
- `POST /staff/recipes/revisions/:revId/validate` — explicit pre-approval check
  (same rules `approve` enforces). Returns `{issues, allergens, valid}`.
- `GET /staff/recipes/revisions/:revId/preview?locale=en|es&servings=N` — deterministic
  quantity scaling (`scaled = base_qty / base_servings × N`, rounded to 2dp for display);
  no LLM arithmetic, no invented nutrition.
- `POST /staff/recipes/revisions/:revId/request-changes` (dietitian/admin,
  `ready_for_review` → `changes_requested`, optional note ≤1000 chars, audited).
- `POST /staff/recipes/revisions/:revId/archive` (`approved|published` → `archived`;
  archived revisions stay resolvable for plan history, fail slot validation for new menus).
- `POST /staff/recipes/:id/duplicate` (`{slug}` → new recipe + draft rev1 copying latest
  contents/items verbatim, audited as `duplicate_of`).
- Approved substitutions (table existed since 006 with no API):
  `GET /staff/recipes/:id/substitutions`, `POST` (both ingredient ids must exist,
  distinct; 409 on duplicate pair), `DELETE /staff/substitutions/:subId`.
  Records the reviewed allowance; customer swap enforcement arrives with M4.
- `POST /staff/programs/versions/:vid/request-changes`
  (`awaiting_professional_review` → `changes_requested`, slots preserved) and
  `POST /staff/programs/versions/:vid/archive` (`approved|published` → `archived`).
  Assigned client plans snapshot meals at assign time, so archive never rewrites history.

## Live staging walkthrough — ACTUAL RUN 2026-11-25, 18/18 green (fictional accounts)
Script: `ops/m2-verify-walkthrough.ps1` (public HTTPS through nginx, cookie sessions).
Seed/cleanup: `ops/m2-verify-seed.sql` / `ops/m2-verify-cleanup.sql`
(SQL only: register rate-limiter `reg:<ip>` 10/hr correctly throttled repeated script runs,
so accounts were seeded with the same bcrypt-12 hash the API uses, then verified via SQL —
all `m2.verify.*@example.test`, clearly fictional).
1. Dietitian login shows roles `[customer, dietitian]`; creates `M2 Verify Chicken` (+kg→g
   conversion) and `M2 Verify Rice` → 201.
2. Creates `m2-verify-bowl` (4 servings, 500 g + 200 g, EN+ES titles/steps) → draft 201;
   explicit validate → `valid:true`; preview `servings=1` → 125 g deterministic.
3. Submit → approve (`allergens_reviewed:true`) → publish → 200 each.
4. Creates `M2 Verify 7-day` program; PUT 21 slots (7×breakfast/lunch/dinner) → `slots:21`;
   submit → approve → publish → 200.
5. Assigns published version to custA (dietitian-assigned scope via
   `primary_professional_id`) → `meals:21`.
6. custA: 1 plan → 21 meals; recipe read OK with `nutrition:null, nutrition_verified:false`;
   custB: plan → 404, recipe → 403. EN/ES error envelopes confirmed on the wire.
7. Cleanup: all walkthrough rows deleted in FK order (plans → slots → versions → templates →
   substitutions → images → items → contents → revisions → recipes → conversions →
   translations → ingredients → audit → null professional refs → users). Integrity check
   after: 6 pre-existing staging users intact (incl. owner `bateman_aaron@hotmail.com`
   record), 0 recipes / 0 programs / 0 plans, `schema_migrations` 001–008, API healthy.
   Ops note: `client_profiles.primary_professional_id` has NO cascade (unlike `user_id`),
   so cleanup must null it before deleting users — recorded here, no schema change made.

## Customer dashboard (`/dashboard`, staging)
- No API session → pure demo, unchanged.
- Signed-in customer with assigned plan → `window.__ncPlan`: menu renders assigned
  days/meals from server recipes, grocery view aggregates `qty × servings`
  (dinner × household size), nutrition shown only when `nutrition_verified:true`,
  else `Nutritión aún sin verificar` notice. Server state never mixes with demo state.

## Staff console (`/manage`, staging)
- Anonymous → demo fictional data only.
- Staff session → LIVE pill: real clients, recipe library (all revisions + status),
  ingredient catalog + conversions, recipe editor (bilingual, items, photo upload),
  program builder (7/14/21/28-day grid, published-only slot options, submit/approve/
  publish/new-version/assign), audit trail via `audit_events`.

## What M2 does NOT do (deferred to M3–M8, per owner decisions D01–D15)
- No prices, checkout, Stripe, credits, booking, messaging, retailer orders.
- No auto-personalization: only dietitian/administrator-approved revisions publishable;
  free-text ingredient lines block approval until resolved to catalog ids.
- Nutrition `verified:false` default; estimates illustrative, never seeded as approved.
- Sample recipes in `recipes/drafts/` remain UNREVIEWED drafts; importing the 7 demo
  recipes as server drafts is a dietitian task, not an auto-approval.
- EN/ES parity on every screen; bilingual error envelope preserved.

## AI-assisted recipe import — "From link" + "From file" tabs (staging, 2026-11-25)
Staff pastes a recipe URL — or uploads a file (print-to-PDF, saved page, notes) —
the server extracts the text (SSRF-guarded fetch, or pdf-parse/plain/HTML parsing),
the model returns a uniform JSON draft, the editor pre-fills, and staff reviews,
saves, and approves through the normal flow. Imports can only ever land as
unreviewed drafts; nothing auto-publishes.
- API: `POST /api/v1/staff/recipe-imports/extract {url}` → `{proposal, source_url}`;
  `POST /api/v1/staff/recipe-imports/file {filename, mime, data_base64}` →
  `{proposal, source_url: null}` (accepted: PDF ≤5 MB with magic-byte check,
  text/plain, text/markdown, text/html; scanned-image PDFs with no readable text
  get `ai_pdf_empty`); `POST /api/v1/staff/recipe-imports/photo` (draft-only).
  Roles: administrator/dietitian; per-user rate limit (10/hr default,
  `AI_IMPORT_RATE_MAX` override).
- Fetch guards: http/https only, DNS re-resolution with private/loopback/link-local
  (incl. 169.254.x) rejection on every redirect hop, 2 MB cap, 15–20 s timeouts,
  HTML-only for extract / image-only for photo, magic-byte sniff (png/jpg/webp).
- Proposal schema (strict zod): bilingual titles/descriptions/steps, servings,
  items `{name_en, name_es, quantity, unit, notes}`, nutrition only if stated
  (never invented), allergen hints, photo URL. Free-text items block approval until
  resolved to catalog ids (existing T12 gate); nutrition needs provenance + human
  review to verify (existing T13 gate).
- Provenance: migration 009 adds `recipe_revisions.source_url` + `source_method`
  (`manual|duplicate|ai_extract`); saved drafts carry it, visible as an
  "Imported from link" pill in the recipe drawer; revision copies preserve it.
- Provider: owner's OpenCode Go subscription via `POST
  https://opencode.ai/inference/go/openai/v1/chat/completions`, model
  `gemini-4-argon` (IDs verified against the live `/v1/models` catalog), Bearer key
  from staging `api.env` (`AI_PROVIDER=opencode_go`, `AI_MODEL`, `AI_API_KEY` — host
  only, never in repo). Stable per-user `x-opencode-session` sent as Go requires.
  Privacy note: Go retains Gemini 4 Argon requests up to 55 days (abuse monitoring);
  only public page text is ever sent, never customer data.
- Failure codes (bilingual): `ai_not_configured` 501, `ai_rejected` 502 (upstream
  auth/entitlement refusal), `ai_fetch_blocked` 422 (site bot-blocks the download —
  e.g. EatingWell returns 403 to servers), `ai_fetch_failed` 422 (network/timeout),
  plus the standard 422/409 guards. The editor shows the server message, so staff
  always know whether to retry, try another page, or enter manually.
- Tests: T17 (stub provider, no network past DNS): scheme/SSRF/body 422s, support 403,
  anon 401, stub shape, save-with-provenance → submit → approve with
  `verify_nutrition` (provenance chain works), photo 404/409 guards, stub upstream
  rejection → 502 `ai_rejected`. Full suite 18/18 green on staging host (T18 covers the file route: real 13 KB PDF parses, txt/html accepted, bad mime + non-PDF bytes rejected, support denied, ~193 KB regression case for the body-parser limits).
- Payload limits (fixed 2026-11-26): the 64 KB Express default 413'd real PDFs and staging nginx defaulted to 1 MB. Per-route Express parsers now (8 MB file-import, 4 MB photo upload; 64 KB default kept elsewhere) + `client_max_body_size 10m` in the staging vhost only (prod untouched). Live proof: 389 KB upload passes transport; junk text cleanly 422s with server-logged schema paths; the owner's real wraps recipe text extracts fully (11 items, 2+2 steps, nutrition, allergens milk+wheat).
- Live check 2026-11-25: page fetch OK (BBC Good Food 200; EatingWell/Allrecipes/Cookie
  & Kate 403 bot-wall their pages), model call answered HTTP 403 `permission_error`
  "This API key can't call models" while the same key reads Go usage meters fine
  (monthly 16%). Diagnosis: key is valid but lacks models scope — owner action: use a
  personal key from the Go-subscribed workspace (or service-account key with models
  access). Superseded 2026-11-26: entitled key works — BBC extract → 200 full
  bilingual proposal (15 items, 3+3 steps, page-stated nutrition, allergens
  soy+peanut, photo URL); saved as draft, submitted, approve correctly rejected
  with 422 free-text gates; staging cleaned. Schema now null-coerces model nulls
  (unknown units → `unit`) and logs failing paths server-side.
- UI: `liveRecipeEditor` gained Manual/From-link tabs (new drafts only), extract
  status + proposal summary, "Use this draft" pre-fill, photo fetched at save when
  present. Startup smoke test still green.

## Security / privacy
- Staff routes `requireRole('administrator','dietitian')`; approve/publish double-checks
  role server-side; support 403, customer 403, anon 401.
- Uploads: allowlist png/jpeg/webp, magic-byte sniff, ≤2 MB, random UUID filename,
  `/media/<uuid>.ext` path regex on link; no patient uploads in public assets.
- CSRF same-origin check on mutations; cookies httpOnly/Secure/SameSite=Lax.
- No real customer data in staging; fictional test accounts only.

## Rollback
- Code: `git revert` the M2 commits (additive routes + 008 migration).
- DB: 008 is widening-only (adds an allowed status value); rollback = restore
  `program_versions_status_check` to the 006 list. 004–007 are M2-scaffolding;
  full rollback = restore pre-M2 backup tarball + rebuild staging container.
- Prod untouched: prod containers/files/nginx verified unchanged (no chip/wiring
  strings in prod image, prod `/` 200).
