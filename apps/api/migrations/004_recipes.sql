-- 004 ingredients + recipes with immutable revisions (M2 builds on this)
CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'produce',
  allergen_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ingredient_translations (
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','es')),
  name TEXT NOT NULL,
  PRIMARY KEY (ingredient_id, locale)
);
CREATE TABLE ingredient_unit_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  factor NUMERIC NOT NULL CHECK (factor > 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE recipe_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  revision INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready_for_review','approved','published','changes_requested','archived')),
  servings INT NOT NULL DEFAULT 1 CHECK (servings > 0),
  active_minutes INT,
  total_minutes INT,
  difficulty TEXT,
  reviewer_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  nutrition JSONB,
  nutrition_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, revision)
);
CREATE TABLE recipe_contents (
  revision_id UUID NOT NULL REFERENCES recipe_revisions(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','es')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (revision_id, locale)
);
CREATE TABLE recipe_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id UUID NOT NULL REFERENCES recipe_revisions(id) ON DELETE CASCADE,
  ingredient_id UUID REFERENCES ingredients(id),
  free_text TEXT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  optional BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (ingredient_id IS NOT NULL OR free_text IS NOT NULL)
);
