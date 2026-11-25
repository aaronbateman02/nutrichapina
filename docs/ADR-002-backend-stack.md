# ADR-002 — M1 backend stack (staging only)

## Choice
Node.js 22 LTS + TypeScript (strict) + Express 5 + Zod validation, `pg` driver,
PostgreSQL 16 in its own container (`nutrichapina-postgres`, volume `nutrichapina-pgdata`,
loopback `127.0.0.1:5433`), raw-SQL versioned migrations with a minimal TS runner,
Vitest + Supertest. No ORM.

## Why
- Smallest auditable surface for auth/RBAC/ledger invariants; deterministic SQL the
  plan's property tests can target directly.
- Fits the shared host: two small containers + existing nginx vhost pattern.
- TypeScript strict + Zod gives bilingual error envelopes without a heavy framework.
- Raw SQL migrations keep review/rollback legible for a compliance-sensitive schema.

## Auth design (M1)
- Register → bcrypt-12 hash → `users` + `user_roles('customer')`; email-verify token
  (24 h, single use). Login → access JWT 15 min + rotating refresh (httpOnly, Secure,
  SameSite=Lax, 30 d, hashed at rest). Logout revokes refresh. Reset via single-use
  token (1 h). Staff MFA: TOTP enforced for `dietitian`/`administrator` at login
  (M1 accepts TOTP secret enrollment; requirement flag on).
- RBAC middleware: role check + ownership check on every route; support role type
  reserved but ungranted until D08/D10 resolved.
- Mail: `mailer` interface; staging uses DB outbox table + owner-gated debug read
  (never production). No real SMTP in M1.

## Schema (M1 migrations; M3/M5 tables created now, endpoints later)
users, user_roles, email_verification_tokens, password_reset_tokens, refresh_tokens,
client_profiles, household_preferences, consent_events, audit_events,
service_packages, package_versions, orders, entitlements, credit_policies,
credit_grants, credit_ledger_entries, credit_holds, intro_entitlements, appointments,
providers (empty), ingredients, recipes, recipe_revisions (+children), program
templates/plans (shell), grocery windows/items (shell), conversations/messages (shell).

## Non-goals M1
Live Stripe, live booking, retailer calls, AI. /manage demo untouched; new minimal
/admin shell in staging only, wired to the same API.
