-- 003 packages, orders, entitlements, credits (shell for M3/M5; enforced later)
CREATE TABLE service_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE package_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES service_packages(id),
  locale_data JSONB NOT NULL DEFAULT '{}',
  product_type TEXT NOT NULL DEFAULT 'one_time' CHECK (product_type IN ('one_time','recurring')),
  duration_days INT,
  credit_grant INT NOT NULL DEFAULT 0,
  price_minor INT,
  currency TEXT NOT NULL DEFAULT 'USD',
  sale_status TEXT NOT NULL DEFAULT 'draft' CHECK (sale_status IN ('draft','published','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_id, id)
);
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  package_version_id UUID REFERENCES package_versions(id),
  state TEXT NOT NULL DEFAULT 'created',
  total_minor INT,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  source_order_id UUID REFERENCES orders(id),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, kind, source_order_id)
);
CREATE TABLE credit_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  minutes_per_credit INT NOT NULL DEFAULT 30,
  grace_days INT NOT NULL DEFAULT 45,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  amount INT NOT NULL,
  policy_snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  delta INT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_ledger_entries(client_id);
CREATE TABLE credit_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  credits INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','settled','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE intro_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  redeemed_at TIMESTAMPTZ,
  eligibility_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
