# M0 production audit — 2026-11-25

## Host
- EC2 `i-0bc615a44196ecb51` (Fantasy War Room), us-east-2, EIP 77.112.201.29, SG `sg-0efd66a21da8cefb6` (80/443/22 open).
- Shared host: also runs firefly, fullcourt, infrastructure web/api, postgres:16 (other project — DO NOT reuse for Nutri data), firefly-studio (appeared 2026-11-23, sibling agent).
- Disk 35% used. `sudo -n true` OK for ec2-user.

## Nutri containers (isolated, loopback-only)
- `nutrichapina-site:prod` on `nutrichapina-net`, 127.0.0.1:8082. Other 6 containers untouched.

## Live site snapshot (vendored here under `apps/static-site/site/`)
- `/` landing, Spanish-default build (39,228 bytes), EN/ES toggle + persistence.
- `/dashboard` customer demo + estimated nutrition per serving (illustrative, unverified).
- `/manage` practice console demo, deployed by sibling agent 2026-11-23 (not by this track).

## Nginx / TLS
- Host nginx 1.30.4 reverse proxy; vhost `nutrichapina.conf` (certbot-managed) + HSTS.
- Cert `nutrichapina.com` covers apex + www + `nutrichapina.nostrabotus.com`, valid to 2027-02-21, auto-renew on.
- `http` → `https` 301; `/dashboard` → `/dashboard/` and `/manage` → `/manage/` redirects.

## DNS (Route53)
- `nutrichapina.com` ACTIVE (was clientHold until 2026-11-23 email verification).
- Apex + www A 77.112.201.29; `staging.nutrichapina.com` pending (M0); `clients` CNAME to github.io (pre-existing).

## Route inventory (must preserve)
`/`, `/dashboard`, `/dashboard/`, `/dashboard/*.js|css|assets/*`,
`/manage`, `/manage/`, `/.well-known/acme-challenge/`. No SPA catch-all; new routes must
not swallow `/dashboard` or `/manage`.

## Deployment (current, pre-pipeline)
Manual: files to `/opt/nutrichapina/site`, `docker build --no-cache`, recreate container,
`nginx -t` + reload. Rollback: recreate container from previous image tag or re-extract
backup tarball below and rebuild.

## Backups (host paths, not in repo)
- `/opt/nutrichapina-backup-2026-11-25.tar.gz` sha256 `e0d0c605f3e8315128539f1752fc47c61ce664246545e35261e471a886684fe8`
- `/opt/nutrichapina.conf.backup-2026-11-25` sha256 `cc3d97bce35f226e6ac512bfdebb0aa8b5f5ffd56bc6011d974ef99b450afec5`

## Secrets inventory (names only — values stay in host env / Stripe dashboard)
AWS IAM `kalshi-bot`; GitHub `aaronbateman02` (gh CLI); Let's Encrypt auto-renewal;
Stripe test/live keys (NOT YET provisioned); future: DB credentials, session secret, mail sandbox.

## Open blockers (owner decisions D01–D15, see plan)
No clinical intake, prices, checkout, booking, retailer keys, or health-data processing
until the corresponding decisions are signed off and recorded here.
