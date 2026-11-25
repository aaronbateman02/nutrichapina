import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireRole, hashPassword, audit } from '../auth.js';

const router = Router();
// Staff area: administrator full access; dietitian read + assigned-scope writes later.
router.use(requireRole('administrator', 'dietitian'));

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

async function scopeClientList(viewerId: string, viewerRoles: string[]): Promise<{ rows: Record<string, unknown>[] }> {
  if (viewerRoles.includes('administrator')) {
    const r = await query(
      `SELECT u.id,u.email,u.locale,u.created_at,p.display_name,p.primary_professional_id
       FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='customer'
       LEFT JOIN client_profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 100`,
    );
    return { rows: r.rows as Record<string, unknown>[] };
  }
  const r = await query(
    `SELECT u.id,u.email,u.locale,u.created_at,p.display_name,p.primary_professional_id
     FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='customer'
     LEFT JOIN client_profiles p ON p.user_id=u.id
     WHERE p.primary_professional_id=$1 ORDER BY u.created_at DESC LIMIT 100`,
    [viewerId],
  );
  return { rows: r.rows as Record<string, unknown>[] };
}

router.get('/clients', async (req, res) => {
  const { rows } = await scopeClientList(req.user!.id, req.user!.roles);
  res.json({ data: rows, error: null, request_id: req.id });
});

router.get('/clients/:id', async (req, res) => {
  const id = req.params.id;
  if (!req.user!.roles.includes('administrator')) {
    const a = await query('SELECT 1 FROM client_profiles WHERE user_id=$1 AND primary_professional_id=$2', [id, req.user!.id]);
    if (!a.rowCount) return fail(req, 'forbidden', 403, res);
  }
  const u = await query<{ id: string; email: string; locale: string; created_at: string; display_name: string | null; timezone: string | null }>('SELECT u.id,u.email,u.locale,u.created_at,p.display_name,p.timezone FROM users u LEFT JOIN client_profiles p ON p.user_id=u.id WHERE u.id=$1', [id]);
  if (!u.rowCount) return fail(req, 'not_found', 404, res);
  const household = (await query('SELECT * FROM household_preferences WHERE user_id=$1', [id])).rows[0] ?? null;
  const entitlements = (await query('SELECT kind,valid_from,valid_to FROM entitlements WHERE client_id=$1', [id])).rows;
  await audit(req.user!.id, 'client', id, 'view');
  res.json({ data: { ...u.rows[0], household, entitlements }, error: null, request_id: req.id });
});

// Administrator-only: create a customer record (verified immediately by staff attestation).
router.post('/clients', requireRole('administrator'), async (req, res) => {
  const p = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(128), display_name: z.string().max(120).optional() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const email = p.data.email.toLowerCase();
  const dup = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (dup.rowCount) return fail(req, 'conflict', 409, res);
  const u = await query<{ id: string }>('INSERT INTO users(email,password_hash,email_verified_at,locale) VALUES ($1,$2,now(),$3) RETURNING id',
    [email, await hashPassword(p.data.password), req.locale]);
  const id: string = u.rows[0].id;
  await query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, 'customer']);
  await query('INSERT INTO client_profiles(user_id,display_name) VALUES ($1,$2)', [id, p.data.display_name ?? '']);
  await query('INSERT INTO household_preferences(user_id) VALUES ($1)', [id]);
  // Consume any pending verification token path: none issued for staff-created accounts.
  await audit(req.user!.id, 'client', id, 'staff_create');
  res.status(201).json({ data: { id }, error: null, request_id: req.id });
});

export default router;
