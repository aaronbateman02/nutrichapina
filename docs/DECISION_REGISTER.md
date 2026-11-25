# Decision register — business-owner vs technical (M1 scope)

Status key: OPEN = needs owner sign-off before activation. SCAFFOLD = implemented as
config/disabled default; safe to build without the final answer.

## Business-owner decisions (do not activate without sign-off)

| ID | Topic | Status | Scaffold behavior |
|---|---|---|---|
| D01 | Legal entity, dietitian licensure states, clinical scope | OPEN | No clinical intake, no professional services; accounts + profiles only |
| D02 | 28-day product price, content, duration, activation start | OPEN | Draft package row, not purchasable |
| D03 | Guided terms: one-time vs recurring, names, prices, credit grants | OPEN | Package versions draft-only; no checkout |
| D04 | Credit = 20 or 30 min; initial assessment length | OPEN (default 30 in test only, not contractual) | Config constant, test fixtures only |
| D05 | Paid-credit expiry/rollover/refunds/extensions | OPEN | No automatic forfeiture; manual adjustments disabled in M1 |
| D06 | Free 15-min intro: eligibility, stacking, window | OPEN | Entitlement row exists; booking disabled |
| D07 | Cancellation / no-show / refund / dispute policy | OPEN | Staging test policy only; no live money |
| D08 | Nutrition Q&A quota, channels, response time | OPEN | Product-support messages only; nutrition chat disabled |
| D09 | Personalization boundary: what needs professional review | OPEN | Only dietitian-approved revisions publishable (M2); no auto-personalization |
| D10 | Privacy/data retention, HIPAA applicability, vendor contracts, consent text | OPEN | Fictional staging data only; no real health data anywhere |
| D11 | Sales tax / Stripe Tax, receipts, disclosures | OPEN | No live checkout; test mode only when keys exist |
| D12 | Retailer partnerships + authorized scope | OPEN | Manual grocery export only |
| D13 | Calendar provider, availability, video visits, staff roster | OPEN | Availability adapter interface; no live booking |
| D14 | Nutrition data source + review policy | OPEN | `verified:false` default; estimates labeled illustrative, never seeded as approved |
| D15 | Support contact, bio/credentials, approved EN/ES copy | OPEN | No fabricated claims; placeholder content only |

## Technical decisions (made independently, recorded in ADRs)
- T01 stack: Node 22 + TypeScript + Express + Zod, PostgreSQL 16, raw-SQL migrations (ADR-002).
- T02 auth: bcrypt-12, 15-min JWT access + rotating refresh in httpOnly Secure SameSite cookies, single-use email/reset tokens.
- T03 staging topology: separate containers/networks/ports, resource caps, X-Robots noindex (ADR-001).
- T04 backups: AES-256-CBC pbkdf2 tarballs off-instance + passphrase with owner, restore-tested.
- T05 test strategy: Vitest + Supertest on ephemeral test DB; negative auth tests required per milestone.
- T06 API envelope `{data, error:{code,message,details}, request_id}`, UUID PKs, minor-unit money, append-only ledgers (schema ready M1, enforced M3/M5).
