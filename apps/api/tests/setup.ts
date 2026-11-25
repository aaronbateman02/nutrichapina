process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://nutri:nutri@localhost:5433/nutrichapina_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-min-32-chars-xxxxxxxx';
process.env.COOKIE_SECURE = 'false';
process.env.ALLOW_DEBUG_OUTBOX = 'true';
