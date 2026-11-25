# M2 evidence — recipe library + menu publishing (staging, 2026-11-25)

Source plan: `Implementation Plans/Nutri_Chapina_Full_Implementation_Plan.zip`
(`docs/RECIPE_LIBRARY_SPEC.md`, `docs/DATA_MODEL_AND_APIS.md`, `docs/ACCEPTANCE_AND_TEST_PLAN.md` T01/T02).
Live production: `https://nutrichapina.com/` untouched. All M2 work targets staging only.

## Migrations (staging DB, `node dist/migrate.js`)
- 004_recipes (ingredients, translations, conversions, recipes, revisions, contents, items)
- 005_platform (program_templates, client_plans, providers, appointments, conversations, messages)
- 006_menus (program_versions, program_day_slots, client_plan_meals, plan_approval_events,
  recipe_approved_substitutions, recipe_images, appointment_notes)
- 007_program_names (`program_templates.name`, backfilled `Untitled program`)
- 008_program_version_status (M2 closeout: adds `changes_requested` to
  `program_versions.status` CHECK so reviewer return-for-corrections persists;
  004 already allowed it for recipe revisions)

## Test suite (`npx vitest run`, ephemeral test DB)
M1 T1–T8 (8/8) unchanged. M2 T11–T16 (`apps/api/tests/m2.test.ts`):
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
Re-run on staging: `DATABASE_URL=... TEST_DATABASE_URL=... npx vitest run` → expect 14/14
(M1 8 + M2 6). Do not run against production.

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

## Live staging walkthrough (fictional accounts, through nginx)
1. Admin creates ingredient `Chicken breast, raw` + `Dry rice` with EN/ES names.
2. Dietitian creates recipe (4 servings, 500 g chicken + 200 g rice, EN+ES titles/steps),
   saves draft, reopens (persistence, unpublished), previews 1 vs 4 servings (deterministic),
   submits → approves (`allergens_reviewed:true`) → publishes; edits create v2 draft,
   v1 stays published.
3. Admin builds 7-day program from published rev, submits → approves → publishes,
   assigns to customer A; customer A reads plan + recipe (ES toggle works);
   customer B denied (plan 404, recipe 403).
4. Support attempts approve → 403 server-side (not just UI-hidden).

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
