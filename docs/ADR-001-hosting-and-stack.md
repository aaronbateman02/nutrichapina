# ADR-001 — where the platform runs (M0, revisitable before production PHI)

Context: single shared EC2 host serves production today via isolated loopback-only
containers behind host nginx. M1 needs PostgreSQL, an API runtime, and staging.

Decision (for M0–M2 staging): stay on the current host with strict isolation —
one docker network + data volume per service, loopback-only publishes, separate
`nutrichapina-staging` container + vhost, its own Postgres container/cluster
(never the existing `infrastructure-postgres-1`), nightly `pg_dump` to host path.

Revisit before any production health-data or live billing: dedicated host or
managed database, private networking, and assessed vendor contracts (see plan
docs B-security and D10). Move trigger: first real client record or live charge.

Alternatives rejected for now: immediate rewrite to another framework (adapt, per
plan B); sharing the sibling project's database (ownership/audit boundary).
