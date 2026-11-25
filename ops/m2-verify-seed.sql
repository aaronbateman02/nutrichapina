-- M2 verify walkthrough seed (staging only, fictional accounts).
-- Bypasses /register (rate-limited) by inserting the same rows register creates.
BEGIN;
INSERT INTO users(email,password_hash,locale,email_verified_at) VALUES
  ('m2.verify.dietitian@example.test','$2b$12$vq/n32zzUKuL73X4dKXVTeBZOw1iqV3j67V1ridcRhZGwkE0Vtta2','en',now()),
  ('m2.verify.custA@example.test','$2b$12$vq/n32zzUKuL73X4dKXVTeBZOw1iqV3j67V1ridcRhZGwkE0Vtta2','en',now()),
  ('m2.verify.custB@example.test','$2b$12$vq/n32zzUKuL73X4dKXVTeBZOw1iqV3j67V1ridcRhZGwkE0Vtta2','en',now())
ON CONFLICT (email) DO UPDATE SET email_verified_at=now();
INSERT INTO user_roles(user_id,role)
  SELECT id,'customer' FROM users WHERE email LIKE 'm2.verify.%'
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id,role)
  SELECT id,'dietitian' FROM users WHERE email='m2.verify.dietitian@example.test'
ON CONFLICT DO NOTHING;
INSERT INTO client_profiles(user_id)
  SELECT id FROM users WHERE email LIKE 'm2.verify.%'
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO household_preferences(user_id)
  SELECT id FROM users WHERE email LIKE 'm2.verify.%'
ON CONFLICT (user_id) DO NOTHING;
UPDATE client_profiles SET primary_professional_id=(SELECT id FROM users WHERE email='m2.verify.dietitian@example.test')
WHERE user_id=(SELECT id FROM users WHERE email='m2.verify.custA@example.test');
COMMIT;
SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE email LIKE 'm2.verify.%' ORDER BY email;
SELECT u.email, r.role FROM user_roles r JOIN users u ON u.id=r.user_id WHERE u.email LIKE 'm2.verify.%' ORDER BY 1,2;
