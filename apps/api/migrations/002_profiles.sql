-- 002 profiles, household, consents, audit
CREATE TABLE client_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  primary_professional_id UUID REFERENCES users(id),
  timezone TEXT NOT NULL DEFAULT 'America/Guatemala',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE household_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household_size INT NOT NULL DEFAULT 1 CHECK (household_size BETWEEN 1 AND 20),
  shared_dinner BOOLEAN NOT NULL DEFAULT TRUE,
  cooking_minutes INT NOT NULL DEFAULT 30 CHECK (cooking_minutes BETWEEN 0 AND 240),
  skill TEXT NOT NULL DEFAULT 'comfortable' CHECK (skill IN ('beginner','comfortable','advanced')),
  budget_minor INT,
  store TEXT NOT NULL DEFAULT 'other',
  delivery_cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (delivery_cadence IN ('weekly','three','daily')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON consent_events(user_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events(actor_id);
CREATE INDEX ON audit_events(entity_type, entity_id);
