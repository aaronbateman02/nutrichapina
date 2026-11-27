# M3 evidence — mock checkout + entitlements (staging, 2026-11-26)

Scope: mock-first per owner ("wire Stripe as mocked, key later"). Zero money movement.
Real-key swap is config-only (`STRIPE_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).

## Migrations (staging DB)
- 012_stripe_wiring: `stripe_customers`, `stripe_price_mappings` (mock/test/live),
  `payment_events` (webhook idempotency, PK on provider event id), `invoices`
  (UNIQUE order), `refunds` (requested/approved/rejected/succeeded + decided_by),
  `orders.stripe_checkout_session_id` UNIQUE + `failure_code`.

## Test suite — 22/22 green on staging host (T20–T22 new)
- T20 checkout: validation 422, draft version 404, null price 422, published →
  201 `mock_cs_*` + `awaiting_payment` order + customer order list; anon 401.
- T21 webhooks: `checkout.session.completed` → paid + `program_access` entitlement
  (valid_to = now + duration), credit ledger == grant, intro row, paid invoice;
  redelivery → `duplicate:true`, zero double grants; `payment_failed` → order
  failed, zero grants.
- T22 refunds (D07 = manual review, answered 2026-11-26): customer 403 on file,
  over-refund 422, request → `requested`, decide approve/reject, re-decide 409,
  entitlements untouched throughout (no auto-revoke by design).
- Two real bugs caught by the suite: router-level auth poisoned the public webhook
  (moved to per-route auth), and a bare-interval `valid_to` (needs `now() +`).

## Live staging walkthrough (mock, fictional accounts, cleaned after)
Register → checkout $19 test package → `mock_cs_*` session → webhook complete →
order `paid` → `program_access` visible on `GET /me`. Duplicate event id correctly
ignored on retry (learned: reuse of an event id is a no-op by design).
All smoke rows removed (orders, entitlements, ledger, packages, users); 0 residue.

## Owner decisions consumed
- D07 refunds: manual review each case (no auto-revoke encoded).
- D02/D03 prices: homepage rates ($19 / $39-mo / $109 / $199) staged as the draft
  catalog values; still changeable, still not purchasable.
- OPEN: D05 credit expiry, D06 intro window,
  D04 credit minutes (default 30 in code, not contractual), live Stripe keys.
  D11 answered 2026-11-26: Stripe Tax at checkout before live; test mode ignores tax.

## What real mode still needs
`STRIPE_SECRET_KEY` + webhook secret + `STRIPE_MODE=test`; HMAC signature check
already implemented (timestamp tolerance + raw-body capture); fulfillment path is
identical. Subscriptions/portal (for $39 recurring) and the package admin editor
are the next slices, not this one.

## Rollback
Additive only: revert commits + `DROP TABLE` the six 012 tables/columns on staging
(disposable DB). Prod untouched (no API surface there at all).
