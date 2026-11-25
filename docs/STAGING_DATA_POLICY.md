# Staging data policy (staging.nutrichapina.com only)

1. Fictional data only. No real customer identities, contact details, health
   information, or payment instruments in staging, ever.
2. No backups of the staging database. It is disposable by design.
3. Reset procedure (destroys all staging rows):
   `docker run --rm --network nutrichapina-staging-net -e PGPASSWORD=<from root-only env file> postgres:16 psql -h nutrichapina-postgres -U nutri -d postgres -c 'DROP DATABASE nutrichapina_test;'` is for tests; for staging itself: stop api, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, rerun migrations, restart.
4. Staging credentials are clearly labeled test values, stored root-only on the
   host plus the owner-held project folder (gitignored, never committed).
5. Production data never flows into staging. Staging never writes to production
   hosts, databases, or DNS.
6. Staging is `noindex,nofollow,noarchive` at the nginx layer and carries no
   analytics.
