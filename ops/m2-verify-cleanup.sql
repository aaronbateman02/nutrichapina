-- M2 verify walkthrough cleanup (staging only). Removes ONLY the clearly-marked
-- fictional m2.verify.* rows + M2 Verify catalog/program rows. Owner + E2E records untouched.
BEGIN;
DELETE FROM client_plan_meals WHERE plan_id IN (SELECT id FROM client_plans WHERE client_id IN (SELECT id FROM users WHERE email LIKE 'm2.verify.%'));
DELETE FROM plan_approval_events WHERE plan_id IN (SELECT id FROM client_plans WHERE client_id IN (SELECT id FROM users WHERE email LIKE 'm2.verify.%'));
DELETE FROM client_plans WHERE client_id IN (SELECT id FROM users WHERE email LIKE 'm2.verify.%');
DELETE FROM program_day_slots WHERE program_version_id IN (SELECT id FROM program_versions WHERE template_id IN (SELECT id FROM program_templates WHERE name = 'M2 Verify 7-day'));
DELETE FROM program_versions WHERE template_id IN (SELECT id FROM program_templates WHERE name = 'M2 Verify 7-day');
DELETE FROM program_templates WHERE name = 'M2 Verify 7-day';
DELETE FROM recipe_approved_substitutions WHERE recipe_id IN (SELECT id FROM recipes WHERE slug = 'm2-verify-bowl');
DELETE FROM recipe_images WHERE revision_id IN (SELECT id FROM recipe_revisions WHERE recipe_id IN (SELECT id FROM recipes WHERE slug = 'm2-verify-bowl'));
DELETE FROM recipe_ingredients WHERE revision_id IN (SELECT id FROM recipe_revisions WHERE recipe_id IN (SELECT id FROM recipes WHERE slug = 'm2-verify-bowl'));
DELETE FROM recipe_contents WHERE revision_id IN (SELECT id FROM recipe_revisions WHERE recipe_id IN (SELECT id FROM recipes WHERE slug = 'm2-verify-bowl'));
DELETE FROM recipe_revisions WHERE recipe_id IN (SELECT id FROM recipes WHERE slug = 'm2-verify-bowl');
DELETE FROM recipes WHERE slug = 'm2-verify-bowl';
DELETE FROM ingredient_unit_conversions WHERE ingredient_id IN (SELECT id FROM ingredients WHERE canonical_name LIKE 'M2 Verify %');
DELETE FROM ingredient_translations WHERE ingredient_id IN (SELECT id FROM ingredients WHERE canonical_name LIKE 'M2 Verify %');
DELETE FROM ingredients WHERE canonical_name LIKE 'M2 Verify %';
DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE 'm2.verify.%');
UPDATE client_profiles SET primary_professional_id=NULL WHERE primary_professional_id IN (SELECT id FROM users WHERE email LIKE 'm2.verify.%');
DELETE FROM users WHERE email LIKE 'm2.verify.%';
COMMIT;
SELECT 'remaining m2.verify users:' AS check, count(*) FROM users WHERE email LIKE 'm2.verify.%';
SELECT 'remaining M2 Verify ingredients:' AS check, count(*) FROM ingredients WHERE canonical_name LIKE 'M2 Verify %';
