-- 008 program version status alignment (M2 closeout): allow changes_requested
-- 006 defined (draft, validated, awaiting_professional_review, approved, published, archived)
-- but programs.ts slot/submit guards also accept changes_requested (mirroring recipe flow).
-- Add it so a reviewer can return a program version for corrections without DB rejection.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'program_versions_status_check'
  ) THEN
    ALTER TABLE program_versions DROP CONSTRAINT program_versions_status_check;
  END IF;
END $$;
ALTER TABLE program_versions ADD CONSTRAINT program_versions_status_check
  CHECK (status IN ('draft','validated','changes_requested','awaiting_professional_review','approved','published','archived'));
