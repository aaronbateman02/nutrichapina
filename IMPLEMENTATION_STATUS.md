# Implementation status — Nutri Chapina full platform (plan dated 2026-11-25)

Source plan: `Nutri_Chapina_Full_Implementation_Plan.zip` (not vendored here; lives with the owner).
Live production: `https://nutrichapina.com/` on AWS EC2 `i-0bc615a44196ecb51` (77.112.201.29).

| Milestone | State | Evidence / notes |
|---|---|---|
| M0 audit, staging, preservation | IN PROGRESS | This repo created; live snapshot vendored under `apps/static-site`; backup tarball on host; route inventory in `docs/M0_AUDIT.md`; staging deploy pending |
| M1 auth, roles, schema | NOT STARTED | Blocked on M0 + ADR-001 + owner decisions D01, D10 |
| M2 recipe library + menu publishing | NOT STARTED | First draft fixture: `recipes/drafts/raspberry-banana-yogurt-parfait.md` (unreviewed) |
| M3 Stripe checkout + entitlements | NOT STARTED | Blocked on D02, D03, D07, D11 + Stripe test keys |
| M4 real customer journey | NOT STARTED | — |
| M5 booking + credits | NOT STARTED | Blocked on D04–D06, D13 |
| M6 guided ops + messaging | NOT STARTED | Blocked on D08 |
| M7 grocery + retailer handoff | NOT STARTED | Blocked on D12; manual export only until then |
| M8 agentic proposals | NOT STARTED | After M2–M7 gates |

Rules: no live prices/charges/bookings without owner sign-off; demo nutrition estimates are
illustrative only and never seed approved data; EN/ES parity on every screen.
