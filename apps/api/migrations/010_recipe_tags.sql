-- 010 recipe dietary tags (M2): versioned source-stated labels (e.g. High-Protein).
-- Transcribed from the source, never inferred; staff confirms at review.
-- Informational only: never auto-claims, never gates approval by itself.
ALTER TABLE recipe_revisions
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
