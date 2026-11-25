-- 007 program names (M2): templates need a human-readable name.
ALTER TABLE program_templates ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Untitled program';
