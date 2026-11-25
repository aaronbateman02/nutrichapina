-- 006 menus, plan assignment, substitutions, media, notes (M2)
CREATE TABLE program_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES program_templates(id) ON DELETE CASCADE,
  revision INT NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','validated','awaiting_professional_review','approved','published','archived')),
  created_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, revision)
);

CREATE TABLE program_day_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_version_id UUID NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  day INT NOT NULL CHECK (day BETWEEN 1 AND 28),
  slot TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  recipe_revision_id UUID NOT NULL REFERENCES recipe_revisions(id),
  servings INT NOT NULL DEFAULT 1 CHECK (servings BETWEEN 1 AND 12),
  UNIQUE (program_version_id, day, slot)
);

CREATE TABLE client_plan_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES client_plans(id) ON DELETE CASCADE,
  day INT NOT NULL CHECK (day BETWEEN 1 AND 28),
  slot TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  recipe_revision_id UUID NOT NULL REFERENCES recipe_revisions(id),
  servings INT NOT NULL DEFAULT 1 CHECK (servings BETWEEN 1 AND 12),
  UNIQUE (plan_id, day, slot)
);

CREATE TABLE plan_approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES client_plans(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recipe_approved_substitutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  sub_ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  rules JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, ingredient_id, sub_ingredient_id)
);

CREATE TABLE recipe_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id UUID NOT NULL REFERENCES recipe_revisions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE appointment_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
