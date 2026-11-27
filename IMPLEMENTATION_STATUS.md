# Implementation status — Nutri Chapina full platform (plan dated 2026-11-25)

Source plan: `Nutri_Chapina_Full_Implementation_Plan.zip` (not vendored here; lives with the owner).
Live production: `https://nutrichapina.com/` on AWS EC2 `i-0bc615a44196ecb51` (77.112.201.29).

| Milestone | State | Evidence / notes |
|---|---|---|
| M0 audit, staging, preservation | DONE 2026-11-25 | Repo created + pushed; live snapshot vendored; backup tarball on host; `staging.nutrichapina.com` live (own container `:staging`, own network, own cert to 2027-02-23); route inventory + ADR-001 in docs |
| M1 auth, roles, schema | DONE (staging) 2026-11-25 | API + Postgres + migrations + 8/8 tests + staging wiring; evidence `docs/M1_EVIDENCE.md`; no prod behavior change |
| M2 recipe library + menu publishing | DONE (staging) 2026-11-25 | API + migrations 004–008 + T11–T15; closeout adds validate/preview/request-changes/archive/duplicate/substitutions; evidence `docs/M2_EVIDENCE.md`; no prod behavior change |
| M3 Stripe checkout + entitlements | IN PROGRESS (mock) 2026-11-26 | Mock checkout + idempotent webhooks + manual refunds, T20–T22, 22/22 green; evidence `docs/M3_EVIDENCE.md`; no real money; needs test keys + D11 |
| M4 real customer journey | NOT STARTED | — |
| M5 booking + credits | NOT STARTED | Blocked on D04–D06, D13 |
| M6 guided ops + messaging | NOT STARTED | Blocked on D08 |
| M7 grocery + retailer handoff | NOT STARTED | Blocked on D12; manual export only until then |
| M8 agentic proposals | NOT STARTED | After M2–M7 gates |

Rules: no live prices/charges/bookings without owner sign-off; demo nutrition estimates are
illustrative only and never seed approved data; EN/ES parity on every screen.
