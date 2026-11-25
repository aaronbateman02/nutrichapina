import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireAuth, audit } from '../auth.js';

const router = Router();
router.use(requireAuth);

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

router.get('/', async (req, res) => {
  const id = req.user!.id;
  const u = await query<{ id: string; email: string; locale: string; created_at: string }>(
    'SELECT id,email,locale,created_at FROM users WHERE id=$1', [id],
  );
  const roles = (await query<{ role: string }>('SELECT role FROM user_roles WHERE user_id=$1', [id])).rows.map((r) => r.role);
  const profile = (await query('SELECT display_name,timezone FROM client_profiles WHERE user_id=$1', [id])).rows[0] ?? null;
  const household = (await query('SELECT household_size,shared_dinner,cooking_minutes,skill,budget_minor,store,delivery_cadence FROM household_preferences WHERE user_id=$1', [id])).rows[0] ?? null;
  const entitlements = (await query('SELECT kind,valid_from,valid_to FROM entitlements WHERE client_id=$1', [id])).rows;
  res.json({ data: { user: u.rows[0], roles, profile, household, entitlements }, error: null, request_id: req.id });
});

router.patch('/', async (req, res) => {
  const p = z.object({
    display_name: z.string().max(120).optional(),
    locale: z.enum(['en', 'es']).optional(),
    timezone: z.string().max(64).optional(),
  }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  if (p.data.locale) await query('UPDATE users SET locale=$1,updated_at=now() WHERE id=$2', [p.data.locale, req.user!.id]);
  await query(
    'UPDATE client_profiles SET display_name=COALESCE($1,display_name), timezone=COALESCE($2,timezone), updated_at=now() WHERE user_id=$3',
    [p.data.display_name ?? null, p.data.timezone ?? null, req.user!.id],
  );
  await audit(req.user!.id, 'profile', req.user!.id, 'update');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.put('/household', async (req, res) => {
  const p = z.object({
    household_size: z.number().int().min(1).max(20),
    shared_dinner: z.boolean(),
    cooking_minutes: z.number().int().min(0).max(240),
    skill: z.enum(['beginner', 'comfortable', 'advanced']),
    budget_minor: z.number().int().min(0).nullable().optional(),
    store: z.string().max(64),
    delivery_cadence: z.enum(['weekly', 'three', 'daily']),
  }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const v = p.data;
  await query(
    `UPDATE household_preferences SET household_size=$1,shared_dinner=$2,cooking_minutes=$3,skill=$4,
     budget_minor=$5,store=$6,delivery_cadence=$7,updated_at=now() WHERE user_id=$8`,
    [v.household_size, v.shared_dinner, v.cooking_minutes, v.skill, v.budget_minor ?? null, v.store, v.delivery_cadence, req.user!.id],
  );
  await audit(req.user!.id, 'household', req.user!.id, 'update');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.get('/consents', async (req, res) => {
  const rows = (await query('SELECT document_version,locale,created_at FROM consent_events WHERE user_id=$1 ORDER BY created_at DESC', [req.user!.id])).rows;
  res.json({ data: rows, error: null, request_id: req.id });
});

router.get('/plans', async (req, res) => {
  const rows = (await query('SELECT id,revision,status,created_at FROM client_plans WHERE client_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user!.id])).rows;
  res.json({ data: rows, error: null, request_id: req.id });
});

router.get('/plans/:id', async (req, res) => {
  const plan = await query('SELECT id,revision,status,created_at FROM client_plans WHERE id=$1 AND client_id=$2', [req.params.id, req.user!.id]);
  if (!plan.rowCount) return fail(req, 'not_found', 404, res);
  const meals = await query(
    `SELECT m.day,m.slot,m.servings,m.recipe_revision_id,rr.revision,c.locale,c.title
     FROM client_plan_meals m JOIN recipe_revisions rr ON rr.id=m.recipe_revision_id
     LEFT JOIN recipe_contents c ON c.revision_id=rr.id AND c.locale=$2
     WHERE m.plan_id=$1 ORDER BY m.day,m.slot`,
    [req.params.id, req.locale],
  );
  res.json({ data: { plan: plan.rows[0], meals: meals.rows }, error: null, request_id: req.id });
});

router.get('/recipes/:revisionId', async (req, res) => {
  const rev = await query<{ id: string; status: string; servings: number; nutrition: unknown; nutrition_verified: boolean }>(
    'SELECT id,status,servings,nutrition,nutrition_verified FROM recipe_revisions WHERE id=$1', [req.params.revisionId]);
  if (!rev.rowCount || rev.rows[0].status !== 'published') return fail(req, 'not_found', 404, res);
  const assigned = await query(
    `SELECT 1 FROM client_plan_meals m JOIN client_plans p ON p.id=m.plan_id
     WHERE p.client_id=$1 AND m.recipe_revision_id=$2 LIMIT 1`, [req.user!.id, req.params.revisionId]);
  if (!assigned.rowCount) return fail(req, 'forbidden', 403, res);
  const contents = await query('SELECT locale,title,description,steps FROM recipe_contents WHERE revision_id=$1', [req.params.revisionId]);
  const items = await query(
    `SELECT ri.quantity,ri.unit,ri.optional,i.canonical_name,t.name
     FROM recipe_ingredients ri LEFT JOIN ingredients i ON i.id=ri.ingredient_id
     LEFT JOIN ingredient_translations t ON t.ingredient_id=ri.ingredient_id AND t.locale=$2
     WHERE ri.revision_id=$1`,
    [req.params.revisionId, req.locale],
  );
  const r = rev.rows[0];
  res.json({
    data: {
      id: r.id, servings: r.servings,
      nutrition: r.nutrition_verified ? r.nutrition : null,
      nutrition_verified: r.nutrition_verified,
      contents: contents.rows, items: items.rows,
    },
    error: null, request_id: req.id,
  });
});

router.post('/consents', async (req, res) => {
  const p = z.object({ document_version: z.string().max(32), locale: z.enum(['en', 'es']) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const ip = createHashIp(req.ip ?? '');
  await query('INSERT INTO consent_events(user_id,document_version,locale,ip_hash) VALUES ($1,$2,$3,$4)',
    [req.user!.id, p.data.document_version, p.data.locale, ip]);
  res.status(201).json({ data: { ok: true }, error: null, request_id: req.id });
});

function createHashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export default router;
