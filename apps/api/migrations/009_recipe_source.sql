-- 009 recipe import provenance (M2): URL/algorithm a draft came from.
-- Imports always land as drafts; approval flow unchanged. Human review required.
ALTER TABLE recipe_revisions
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS source_method TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_method IN ('manual', 'duplicate', 'ai_extract'));
