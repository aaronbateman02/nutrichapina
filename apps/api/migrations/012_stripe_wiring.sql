-- 012 Stripe wiring (M3, mock-first): customers, price mappings, webhook
-- idempotency, invoices, refunds. Real money stays off until live keys + D07/D11.
CREATE TABLE stripe_customers (
  client_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stripe_price_mappings (
  package_version_id UUID PRIMARY KEY REFERENCES package_versions(id) ON DELETE CASCADE,
  stripe_price_id TEXT NOT NULL,
  stripe_product_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','test','live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE payment_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void','refunded','partially_refunded')),
  stripe_invoice_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Refunds default to manual owner review (D07 answered 2026-11-26): records only,
-- never auto-revoke entitlements without an explicit approval action.
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INT NOT NULL CHECK (amount_minor > 0),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','succeeded')),
  stripe_refund_id TEXT UNIQUE,
  decided_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS failure_code TEXT;
