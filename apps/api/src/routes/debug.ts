import { Router } from 'express';
import { query } from '../db.js';

// Staging-only debug outbox. Mounted only when ALLOW_DEBUG_OUTBOX=true (never prod).
// Returns pending single-use token identifiers so staging tests can complete
// email flows without an SMTP provider. Tokens themselves are never logged.
const router = Router();

router.get('/outbox', async (_req, res) => {
  const verify = (await query(
    'SELECT id,user_id,expires_at,used_at,created_at FROM email_verification_tokens ORDER BY created_at DESC LIMIT 20',
  )).rows;
  const reset = (await query(
    'SELECT id,user_id,expires_at,used_at,created_at FROM password_reset_tokens ORDER BY created_at DESC LIMIT 20',
  )).rows;
  res.json({ data: { verify, reset }, error: null, request_id: (_req as unknown as { id: string }).id });
});

export default router;
