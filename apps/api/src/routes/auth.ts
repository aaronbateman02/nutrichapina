import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import {
  hashPassword, checkPassword, newToken, tokenHash, signAccess,
  setAuthCookies, clearAuthCookies, readCookies, requireAuth, rateLimit, audit,
} from './auth.js';
import { newSecret, totpVerify, otpauthUrl } from '../mfa.js';

const router = Router();
const err = (req: { locale: 'en' | 'es'; id: string }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: req.id });

const Email = z.string().email().max(254);
const Password = z.string().min(10).max(128);

async function rolesOf(userId: string): Promise<string[]> {
  const r = await query<{ role: string }>('SELECT role FROM user_roles WHERE user_id=$1', [userId]);
  return r.rows.map((x) => x.role);
}

router.post('/register', async (req, res) => {
  if (!rateLimit(`reg:${req.ip}`, 10, 3600_000)) return err(req, 'locked', 429, res);
  const p = z.object({ email: Email, password: Password, locale: z.enum(['en', 'es']).optional() }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const email = p.data.email.toLowerCase();
  const existing = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rowCount) return err(req, 'conflict', 409, res);
  const hash = await hashPassword(p.data.password);
  const u = await query<{ id: string }>(
    'INSERT INTO users(email,password_hash,locale) VALUES ($1,$2,$3) RETURNING id',
    [email, hash, p.data.locale ?? 'es'],
  );
  const id = u.rows[0].id;
  await query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, 'customer']);
  await query('INSERT INTO client_profiles(user_id) VALUES ($1)', [id]);
  await query('INSERT INTO household_preferences(user_id) VALUES ($1)', [id]);
  const raw = newToken();
  await query(
    "INSERT INTO email_verification_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '24 hours')",
    [id, tokenHash(raw)],
  );
  await audit(id, 'user', id, 'register');
  res.status(201).json({ data: { id }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/verify-email', async (req, res) => {
  const p = z.object({ token: z.string().min(10) }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const h = tokenHash(p.data.token);
  const t = await query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id,user_id,expires_at,used_at FROM email_verification_tokens WHERE token_hash=$1', [h],
  );
  const row = t.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return err(req, 'expired', 410, res);
  await query('UPDATE email_verification_tokens SET used_at=now() WHERE id=$1', [row.id]);
  await query('UPDATE users SET email_verified_at=now() WHERE id=$1', [row.user_id]);
  await audit(row.user_id, 'user', row.user_id, 'verify_email');
  res.json({ data: { ok: true }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/login', async (req, res) => {
  if (!rateLimit(`login:${req.ip}`, 20, 600_000)) return err(req, 'locked', 429, res);
  const p = z.object({ email: Email, password: z.string().min(1).max(128), token: z.string().regex(/^\d{6}$/).optional() }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const u = await query<{ id: string; password_hash: string; email_verified_at: string | null; status: string; mfa_secret: string | null; mfa_required: boolean }>(
    'SELECT id,password_hash,email_verified_at,status,mfa_secret,mfa_required FROM users WHERE email=$1', [p.data.email.toLowerCase()],
  );
  const row = u.rows[0];
  if (!row || !(await checkPassword(p.data.password, row.password_hash))) return err(req, 'bad_credentials', 401, res);
  if (row.status !== 'active' || !row.email_verified_at) {
    return err(req, row.status !== 'active' ? 'forbidden' : 'unverified', row.status !== 'active' ? 403 : 403, res);
  }
  if (row.mfa_required) {
    if (!p.data.token || !row.mfa_secret || !totpVerify(row.mfa_secret, p.data.token)) {
      res.status(403).json({ data: { mfa_required: true }, error: { code: 'forbidden', message: msg('forbidden', req.locale) }, request_id: (req as unknown as { id: string }).id });
      return;
    }
  }
  const roles = (await rolesOf(row.id)) as ('customer' | 'dietitian' | 'administrator' | 'support')[];
  const access = signAccess({ id: row.id, roles });
  const raw = newToken();
  await query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '30 days')", [row.id, tokenHash(raw)]);
  setAuthCookies(res, access, raw);
  await audit(row.id, 'user', row.id, 'login');
  res.json({ data: { id: row.id, roles }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/refresh', async (req, res) => {
  const { refresh } = readCookies(req);
  if (!refresh) return err(req, 'unauthorized', 401, res);
  const h = tokenHash(refresh);
  const t = await query<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    'SELECT id,user_id,expires_at,revoked_at FROM refresh_tokens WHERE token_hash=$1', [h],
  );
  const row = t.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return err(req, 'unauthorized', 401, res);
  await query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [row.id]);
  const roles = (await rolesOf(row.user_id)) as ('customer' | 'dietitian' | 'administrator' | 'support')[];
  const raw = newToken();
  await query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '30 days')", [row.user_id, tokenHash(raw)]);
  setAuthCookies(res, signAccess({ id: row.user_id, roles }), raw);
  res.json({ data: { ok: true }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/logout', requireAuth, async (req, res) => {
  const { refresh } = readCookies(req);
  if (refresh) await query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1', [tokenHash(refresh)]);
  clearAuthCookies(res);
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/request-reset', async (req, res) => {
  const p = z.object({ email: Email }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const u = await query<{ id: string }>('SELECT id FROM users WHERE email=$1', [p.data.email.toLowerCase()]);
  if (u.rows[0]) {
    const raw = newToken();
    await query(
      "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [u.rows[0].id, tokenHash(raw)],
    );
  }
  // Always 200: never reveal whether an account exists.
  res.json({ data: { ok: true }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/reset-password', async (req, res) => {  const p = z.object({ token: z.string().min(10), password: Password }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const h = tokenHash(p.data.token);
  const t = await query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id,user_id,expires_at,used_at FROM password_reset_tokens WHERE token_hash=$1', [h],
  );
  const row = t.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return err(req, 'expired', 410, res);
  await query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [row.id]);
  await query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [await hashPassword(p.data.password), row.user_id]);
  await query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
  await audit(row.user_id, 'user', row.user_id, 'password_reset');
  res.json({ data: { ok: true }, error: null, request_id: (req as unknown as { id: string }).id });
});

router.post('/mfa/setup', requireAuth, async (req, res) => {
  const secret = newSecret();
  await query('UPDATE users SET mfa_secret=$1, updated_at=now() WHERE id=$2', [secret, req.user!.id]);
  await audit(req.user!.id, 'user', req.user!.id, 'mfa_setup');
  const email = (await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [req.user!.id])).rows[0].email;
  res.json({ data: { secret, otpauth_url: otpauthUrl('NutriChapina', email, secret) }, error: null, request_id: req.id });
});

router.post('/mfa/enable', requireAuth, async (req, res) => {
  const p = z.object({ token: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const row = (await query<{ mfa_secret: string | null }>('SELECT mfa_secret FROM users WHERE id=$1', [req.user!.id])).rows[0];
  if (!row?.mfa_secret || !totpVerify(row.mfa_secret, p.data.token)) return err(req, 'bad_credentials', 401, res);
  await query('UPDATE users SET mfa_required=TRUE, updated_at=now() WHERE id=$1', [req.user!.id]);
  await audit(req.user!.id, 'user', req.user!.id, 'mfa_enable');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/mfa/disable', requireAuth, async (req, res) => {
  const p = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!p.success) return err(req, 'invalid_input', 422, res);
  const row = (await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [req.user!.id])).rows[0];
  if (!row || !(await checkPassword(p.data.password, row.password_hash))) return err(req, 'bad_credentials', 401, res);
  await query('UPDATE users SET mfa_secret=NULL, mfa_required=FALSE, updated_at=now() WHERE id=$1', [req.user!.id]);
  await audit(req.user!.id, 'user', req.user!.id, 'mfa_disable');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

export default router;
