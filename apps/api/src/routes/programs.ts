import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireRole, audit } from '../auth.js';
import { validateRevision } from './catalog.js';

const router = Router();
router.use(requireRole('administrator', 'dietitian'));

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

const Slot = z.object({
  day: z.number().int().min(1).max(28),
  slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  recipe_revision_id: z.string().uuid(),
  servings: z.number().int().min(1).max(12).default(1),
});

router.post('/programs', async (req, res) => {
  const p = z.object({ name: z.string().min(2).max(120) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const t = await query<{ id: string }>('INSERT INTO program_templates(status,name) VALUES ($1,$2) RETURNING id', ['draft', p.data.name]);
  const v = await query<{ id: string }>('INSERT INTO program_versions(template_id,revision,status,created_by) VALUES ($1,1,$2,$3) RETURNING id',
    [t.rows[0].id, 'draft', req.user!.id]);
  await audit(req.user!.id, 'program', t.rows[0].id, 'create');
  res.status(201).json({ data: { id: t.rows[0].id, version_id: v.rows[0].id }, error: null, request_id: req.id });
});

router.get('/programs', async (req, res) => {
  const r = await query(`SELECT t.id, t.name, MAX(v.revision) AS revisions,
    (SELECT status FROM program_versions WHERE template_id=t.id ORDER BY revision DESC LIMIT 1) AS latest_status
    FROM program_templates t LEFT JOIN program_versions v ON v.template_id=t.id GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.get('/programs/:id/versions', async (req, res) => {
  const r = await query('SELECT id,revision,status,created_by,published_at,created_at FROM program_versions WHERE template_id=$1 ORDER BY revision', [req.params.id]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.get('/programs/versions/:vid/slots', async (req, res) => {
  const v = await query('SELECT id FROM program_versions WHERE id=$1', [req.params.vid]);
  if (!v.rowCount) return fail(req, 'not_found', 404, res);
  const r = await query(
    `SELECT s.day,s.slot,s.servings,s.recipe_revision_id,rr.revision,rr.status,
            (SELECT title FROM recipe_contents WHERE revision_id=rr.id AND locale='en') AS title_en,
            (SELECT title FROM recipe_contents WHERE revision_id=rr.id AND locale='es') AS title_es
     FROM program_day_slots s JOIN recipe_revisions rr ON rr.id=s.recipe_revision_id
     WHERE s.program_version_id=$1 ORDER BY s.day,s.slot`, [req.params.vid]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.post('/programs/:id/versions', async (req, res) => {
  const latest = await query<{ id: string; revision: number; status: string }>('SELECT id,revision,status FROM program_versions WHERE template_id=$1 ORDER BY revision DESC LIMIT 1', [req.params.id]);
  if (!latest.rowCount) return fail(req, 'not_found', 404, res);
  const src = latest.rows[0];
  if (!['approved', 'published', 'archived'].includes(src.status)) return fail(req, 'conflict', 409, res);
  const v = await query<{ id: string }>('INSERT INTO program_versions(template_id,revision,status,created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.params.id, src.revision + 1, 'draft', req.user!.id]);
  await query('INSERT INTO program_day_slots(program_version_id,day,slot,recipe_revision_id,servings) SELECT $1,day,slot,recipe_revision_id,servings FROM program_day_slots WHERE program_version_id=$2',
    [v.rows[0].id, src.id]);
  await audit(req.user!.id, 'program', req.params.id, 'new_version');
  res.status(201).json({ data: { version_id: v.rows[0].id, revision: src.revision + 1 }, error: null, request_id: req.id });
});

router.put('/programs/versions/:vid/slots', async (req, res) => {
  const p = z.object({ slots: z.array(Slot).max(120) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const v = await query<{ id: string; status: string }>('SELECT id,status FROM program_versions WHERE id=$1', [req.params.vid]);
  if (!v.rowCount) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(v.rows[0].status)) return fail(req, 'conflict', 409, res);
  const seen = new Set<string>();
  for (const s of p.data.slots) {
    const k = `${s.day}:${s.slot}`;
    if (seen.has(k)) return fail(req, 'invalid_input', 422, res);
    seen.add(k);
    const rev = await query<{ status: string }>('SELECT status FROM recipe_revisions WHERE id=$1', [s.recipe_revision_id]);
    if (!rev.rowCount || rev.rows[0].status !== 'published') return fail(req, 'invalid_input', 422, res);
  }
  await query('DELETE FROM program_day_slots WHERE program_version_id=$1', [req.params.vid]);
  for (const s of p.data.slots) {
    await query('INSERT INTO program_day_slots(program_version_id,day,slot,recipe_revision_id,servings) VALUES ($1,$2,$3,$4,$5)',
      [req.params.vid, s.day, s.slot, s.recipe_revision_id, s.servings]);
  }
  await audit(req.user!.id, 'program_version', req.params.vid, 'slots_replace');
  res.json({ data: { ok: true, slots: p.data.slots.length }, error: null, request_id: req.id });
});

async function programIssues(versionId: string): Promise<string[]> {
  const issues: string[] = [];
  const slots = await query<{ day: number; slot: string; recipe_revision_id: string }>(
    'SELECT day,slot,recipe_revision_id FROM program_day_slots WHERE program_version_id=$1', [versionId]);
  if (!slots.rows.length) return ['empty program'];
  const maxDay = Math.max(...slots.rows.map((s) => s.day));
  if (![7, 14, 21, 28].includes(maxDay)) issues.push('program length must be 7, 14, 21 or 28 days');
  const have = new Set(slots.rows.map((s) => `${s.day}:${s.slot}`));
  for (let d = 1; d <= maxDay; d++) {
    for (const slot of ['breakfast', 'lunch', 'dinner']) {
      if (!have.has(`${d}:${slot}`)) issues.push(`missing ${slot} on day ${d}`);
    }
  }
  for (const s of slots.rows) {
    const rev = await query<{ status: string }>('SELECT status FROM recipe_revisions WHERE id=$1', [s.recipe_revision_id]);
    if (!rev.rowCount || rev.rows[0].status !== 'published') issues.push(`unpublished recipe revision ${s.recipe_revision_id}`);
  }
  return issues;
}

router.post('/programs/versions/:vid/submit', async (req, res) => {
  const v = await query<{ status: string }>('SELECT status FROM program_versions WHERE id=$1', [req.params.vid]);
  if (!v.rowCount) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(v.rows[0].status)) return fail(req, 'conflict', 409, res);
  await query("UPDATE program_versions SET status='awaiting_professional_review' WHERE id=$1", [req.params.vid]);
  await audit(req.user!.id, 'program_version', req.params.vid, 'submit_review');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/programs/versions/:vid/approve', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const v = await query<{ status: string }>('SELECT status FROM program_versions WHERE id=$1', [req.params.vid]);
  if (!v.rowCount) return fail(req, 'not_found', 404, res);
  if (!['draft', 'awaiting_professional_review'].includes(v.rows[0].status)) return fail(req, 'conflict', 409, res);
  const issues = await programIssues(req.params.vid);
  if (issues.length) {
    res.status(422).json({ data: { issues }, error: { code: 'invalid_input', message: msg('invalid_input', req.locale) }, request_id: req.id });
    return;
  }
  await query("UPDATE program_versions SET status='approved' WHERE id=$1", [req.params.vid]);
  await audit(req.user!.id, 'program_version', req.params.vid, 'approve');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/programs/versions/:vid/publish', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const v = await query<{ status: string; template_id: string }>('SELECT status,template_id FROM program_versions WHERE id=$1', [req.params.vid]);
  if (!v.rowCount) return fail(req, 'not_found', 404, res);
  if (v.rows[0].status !== 'approved') return fail(req, 'conflict', 409, res);
  await query("UPDATE program_versions SET status='published',published_at=now() WHERE id=$1", [req.params.vid]);
  await audit(req.user!.id, 'program_version', req.params.vid, 'publish');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/plans/assign', async (req, res) => {
  const p = z.object({ client_id: z.string().uuid(), program_version_id: z.string().uuid() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const client = await query('SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role=$2 WHERE u.id=$1', [p.data.client_id, 'customer']);
  if (!client.rowCount) return fail(req, 'not_found', 404, res);
  if (!req.user!.roles.includes('administrator')) {
    const scoped = await query('SELECT 1 FROM client_profiles WHERE user_id=$1 AND primary_professional_id=$2', [p.data.client_id, req.user!.id]);
    if (!scoped.rowCount) return fail(req, 'forbidden', 403, res);
  }
  const v = await query<{ status: string }>('SELECT status FROM program_versions WHERE id=$1', [p.data.program_version_id]);
  if (!v.rowCount || v.rows[0].status !== 'published') return fail(req, 'conflict', 409, res);
  const slots = await query<{ day: number; slot: string; recipe_revision_id: string; servings: number }>(
    'SELECT day,slot,recipe_revision_id,servings FROM program_day_slots WHERE program_version_id=$1', [p.data.program_version_id]);
  const plan = await query<{ id: string }>("INSERT INTO client_plans(client_id,revision,status) VALUES ($1,1,'active') RETURNING id", [p.data.client_id]);
  for (const s of slots.rows) {
    await query('INSERT INTO client_plan_meals(plan_id,day,slot,recipe_revision_id,servings) VALUES ($1,$2,$3,$4,$5)',
      [plan.rows[0].id, s.day, s.slot, s.recipe_revision_id, s.servings]);
  }
  await query('INSERT INTO plan_approval_events(plan_id,actor_id,action,note) VALUES ($1,$2,$3,$4)',
    [plan.rows[0].id, req.user!.id, 'assign', `program_version ${p.data.program_version_id}`]);
  await audit(req.user!.id, 'client_plan', plan.rows[0].id, 'assign');
  res.status(201).json({ data: { plan_id: plan.rows[0].id, meals: slots.rows.length }, error: null, request_id: req.id });
});

export { programIssues };
export default router;
