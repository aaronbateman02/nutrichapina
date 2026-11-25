import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireRole, audit } from '../auth.js';

const router = Router();
// Ingredient + recipe + menu authoring: dietitian and administrator.
// Support has no access here (read-only public data comes from customer routes).
router.use(requireRole('administrator', 'dietitian'));

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

const Unit = z.string().min(1).max(16);

// ---------- ingredients ----------
router.get('/ingredients', async (req, res) => {
  const q = typeof req.query.q === 'string' ? `%${req.query.q.toLowerCase()}%` : null;
  const r = q
    ? await query('SELECT i.*, t.locale, t.name FROM ingredients i LEFT JOIN ingredient_translations t ON t.ingredient_id=i.id WHERE LOWER(i.canonical_name) LIKE $1 OR LOWER(t.name) LIKE $1 ORDER BY i.canonical_name LIMIT 100', [q])
    : await query('SELECT i.*, t.locale, t.name FROM ingredients i LEFT JOIN ingredient_translations t ON t.ingredient_id=i.id ORDER BY i.canonical_name LIMIT 100');
  res.json({ data: r.rows, error: null, request_id: req.id });
});

const ingredientBody = z.object({
  canonical_name: z.string().min(2).max(120),
  category: z.enum(['produce', 'protein', 'grains', 'dairy', 'pantry']).default('produce'),
  allergen_class: z.string().max(64).nullable().optional(),
  translations: z.object({ en: z.string().min(1).max(120), es: z.string().min(1).max(120) }),
  conversions: z.array(z.object({ from_unit: Unit, to_unit: Unit, factor: z.number().positive().finite() })).max(20).optional(),
});

router.post('/ingredients', async (req, res) => {
  const p = ingredientBody.safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const dup = await query('SELECT id FROM ingredients WHERE LOWER(canonical_name)=LOWER($1)', [p.data.canonical_name]);
  if (dup.rowCount) return fail(req, 'conflict', 409, res);
  const ing = await query<{ id: string }>('INSERT INTO ingredients(canonical_name,category,allergen_class) VALUES ($1,$2,$3) RETURNING id',
    [p.data.canonical_name, p.data.category, p.data.allergen_class ?? null]);
  const id: string = ing.rows[0].id;
  await query('INSERT INTO ingredient_translations(ingredient_id,locale,name) VALUES ($1,$2,$3),($1,$4,$5)',
    [id, 'en', p.data.translations.en, 'es', p.data.translations.es]);
  for (const c of p.data.conversions ?? []) {
    await query('INSERT INTO ingredient_unit_conversions(ingredient_id,from_unit,to_unit,factor) VALUES ($1,$2,$3,$4)',
      [id, c.from_unit, c.to_unit, c.factor]);
  }
  await audit(req.user!.id, 'ingredient', id, 'create');
  res.status(201).json({ data: { id }, error: null, request_id: req.id });
});

router.patch('/ingredients/:id', async (req, res) => {
  const p = z.object({
    canonical_name: z.string().min(2).max(120).optional(),
    category: z.enum(['produce', 'protein', 'grains', 'dairy', 'pantry']).optional(),
    allergen_class: z.string().max(64).nullable().optional(),
    translations: z.object({ en: z.string().min(1).max(120), es: z.string().min(1).max(120) }).optional(),
  }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const cur = await query('SELECT id FROM ingredients WHERE id=$1', [req.params.id]);
  if (!cur.rowCount) return fail(req, 'not_found', 404, res);
  const v = p.data;
  await query('UPDATE ingredients SET canonical_name=COALESCE($1,canonical_name), category=COALESCE($2,category), allergen_class=COALESCE($3,allergen_class) WHERE id=$4',
    [v.canonical_name ?? null, v.category ?? null, v.allergen_class ?? null, req.params.id]);
  if (v.translations) {
    await query('INSERT INTO ingredient_translations(ingredient_id,locale,name) VALUES ($1,$2,$3),($1,$4,$5) ON CONFLICT (ingredient_id,locale) DO UPDATE SET name=EXCLUDED.name',
      [req.params.id, 'en', v.translations.en, 'es', v.translations.es]);
  }
  // Conversions are append-only with effective dates: never silently mutated.
  await audit(req.user!.id, 'ingredient', req.params.id as string, 'update');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/ingredients/:id/conversions', async (req, res) => {
  const p = z.object({ from_unit: Unit, to_unit: Unit, factor: z.number().positive().finite() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const cur = await query('SELECT id FROM ingredients WHERE id=$1', [req.params.id]);
  if (!cur.rowCount) return fail(req, 'not_found', 404, res);
  await query('INSERT INTO ingredient_unit_conversions(ingredient_id,from_unit,to_unit,factor) VALUES ($1,$2,$3,$4)',
    [req.params.id, p.data.from_unit, p.data.to_unit, p.data.factor]);
  await audit(req.user!.id, 'ingredient', req.params.id as string, 'conversion_add');
  res.status(201).json({ data: { ok: true }, error: null, request_id: req.id });
});

// ---------- recipes ----------
const recipeItem = z.object({
  ingredient_id: z.string().uuid().nullable().optional(),
  free_text: z.string().max(200).nullable().optional(),
  quantity: z.number().positive().finite(),
  unit: Unit,
  optional: z.boolean().optional(),
});
const recipeBody = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  title_en: z.string().min(2).max(160),
  title_es: z.string().min(2).max(160),
  description_en: z.string().max(2000).default(''),
  description_es: z.string().max(2000).default(''),
  steps_en: z.array(z.string().min(1).max(2000)).max(40).default([]),
  steps_es: z.array(z.string().min(1).max(2000)).max(40).default([]),
  servings: z.number().int().min(1).max(24).default(1),
  active_minutes: z.number().int().min(0).max(600).nullable().optional(),
  total_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  difficulty: z.enum(['easy', 'moderate', 'advanced']).nullable().optional(),
  items: z.array(recipeItem).max(60).default([]),
  nutrition: z.record(z.string(), z.unknown()).nullable().optional(),
});

async function getRevision(revId: string): Promise<Record<string, unknown> | null> {
  const r = await query('SELECT * FROM recipe_revisions WHERE id=$1', [revId]);
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
}

export interface ValidationIssue { field: string; message: string }
export async function validateRevision(revId: string): Promise<{ issues: ValidationIssue[]; allergens: string[] }> {
  const issues: ValidationIssue[] = [];
  const rev = await getRevision(revId);
  if (!rev) return { issues: [{ field: 'revision', message: 'missing' }], allergens: [] };
  const contents = await query<{ locale: string; title: string; description: string; steps: unknown }>(
    'SELECT locale,title,description,steps FROM recipe_contents WHERE revision_id=$1', [revId]);
  const byLoc: Record<string, { title: string; steps: unknown }> = {};
  for (const c of contents.rows) byLoc[c.locale] = c;
  for (const loc of ['en', 'es']) {
    if (!byLoc[loc]?.title?.trim()) issues.push({ field: `title_${loc}`, message: 'required' });
    if (!Array.isArray(byLoc[loc]?.steps) || (byLoc[loc].steps as unknown[]).length === 0) issues.push({ field: `steps_${loc}`, message: 'required' });
  }
  if (!((rev.servings as number) > 0)) issues.push({ field: 'servings', message: 'must be positive' });
  const items = await query<{ id: string; ingredient_id: string | null; free_text: string | null; quantity: string; unit: string }>(
    'SELECT id,ingredient_id,free_text,quantity,unit FROM recipe_ingredients WHERE revision_id=$1', [revId]);
  if (!items.rows.length) issues.push({ field: 'items', message: 'at least one ingredient required' });
  const allergens = new Set<string>();
  for (const it of items.rows) {
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0) issues.push({ field: `item:${it.id}:quantity`, message: 'must be positive' });
    if (!it.unit?.trim()) issues.push({ field: `item:${it.id}:unit`, message: 'required' });
    if (it.ingredient_id) {
      const ing = await query<{ allergen_class: string | null }>('SELECT allergen_class FROM ingredients WHERE id=$1', [it.ingredient_id]);
      if (!ing.rowCount) issues.push({ field: `item:${it.id}:ingredient`, message: 'unknown ingredient' });
      else if (ing.rows[0].allergen_class) allergens.add(ing.rows[0].allergen_class as string);
    } else if (!it.free_text?.trim()) {
      issues.push({ field: `item:${it.id}`, message: 'ingredient or free text required' });
    } else {
      issues.push({ field: `item:${it.id}:free_text`, message: 'resolve to catalog ingredient before publish' });
    }
  }
  return { issues, allergens: [...allergens] };
}

router.post('/recipes', async (req, res) => {
  const p = recipeBody.safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const dup = await query('SELECT id FROM recipes WHERE slug=$1', [p.data.slug]);
  if (dup.rowCount) return fail(req, 'conflict', 409, res);
  const v = p.data;
  const rec = await query<{ id: string }>('INSERT INTO recipes(slug,created_by) VALUES ($1,$2) RETURNING id', [v.slug, req.user!.id]);
  const recipeId: string = rec.rows[0].id;
  const rev = await query<{ id: string }>(
    'INSERT INTO recipe_revisions(recipe_id,revision,status,servings,active_minutes,total_minutes,difficulty,nutrition) VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [recipeId, 'draft', v.servings, v.active_minutes ?? null, v.total_minutes ?? null, v.difficulty ?? null, v.nutrition ? JSON.stringify(v.nutrition) : null],
  );
  const revId: string = rev.rows[0].id;
  await query('INSERT INTO recipe_contents(revision_id,locale,title,description,steps) VALUES ($1,$2,$3,$4,$5),($1,$6,$7,$8,$9)',
    [revId, 'en', v.title_en, v.description_en, JSON.stringify(v.steps_en), 'es', v.title_es, v.description_es, JSON.stringify(v.steps_es)]);
  for (const it of v.items) {
    await query('INSERT INTO recipe_ingredients(revision_id,ingredient_id,free_text,quantity,unit,optional) VALUES ($1,$2,$3,$4,$5,$6)',
      [revId, it.ingredient_id ?? null, it.free_text ?? null, it.quantity, it.unit, it.optional ?? false]);
  }
  await audit(req.user!.id, 'recipe', recipeId, 'create_draft');
  res.status(201).json({ data: { id: recipeId, revision_id: revId }, error: null, request_id: req.id });
});

router.get('/recipes', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const q = typeof req.query.q === 'string' ? `%${req.query.q.toLowerCase()}%` : null;
  let sql = `SELECT r.id,r.slug,rv.id AS revision_id,rv.revision,rv.status,rv.servings,c.title,c.locale
    FROM recipes r JOIN recipe_revisions rv ON rv.recipe_id=r.id
    LEFT JOIN recipe_contents c ON c.revision_id=rv.id AND c.locale='en'`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { params.push(status); where.push(`rv.status=$${params.length}`); }
  if (q) { params.push(q); where.push(`(LOWER(r.slug) LIKE $${params.length} OR LOWER(c.title) LIKE $${params.length})`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY r.created_at DESC LIMIT 100';
  const r = await query(sql, params);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.get('/recipes/:id/revisions', async (req, res) => {
  const r = await query('SELECT id,revision,status,servings,reviewer_id,reviewed_at,created_at FROM recipe_revisions WHERE recipe_id=$1 ORDER BY revision', [req.params.id]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.get('/recipes/revisions/:revId', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  const contents = await query('SELECT locale,title,description,steps FROM recipe_contents WHERE revision_id=$1', [req.params.revId]);
  const items = await query(
    `SELECT ri.id,ri.ingredient_id,ri.free_text,ri.quantity,ri.unit,ri.optional,i.canonical_name
     FROM recipe_ingredients ri LEFT JOIN ingredients i ON i.id=ri.ingredient_id WHERE ri.revision_id=$1`,
    [req.params.revId],
  );
  const { issues, allergens } = await validateRevision(req.params.revId);
  const images = await query('SELECT path,alt,sort FROM recipe_images WHERE revision_id=$1 ORDER BY sort', [req.params.revId]);
  res.json({ data: { revision: rev, contents: contents.rows, items: items.rows, images: images.rows, validation: { issues, allergens } }, error: null, request_id: req.id });
});

const recipePatch = z.object({
  title_en: z.string().min(2).max(160).optional(),
  title_es: z.string().min(2).max(160).optional(),
  description_en: z.string().max(2000).optional(),
  description_es: z.string().max(2000).optional(),
  steps_en: z.array(z.string().min(1).max(2000)).max(40).optional(),
  steps_es: z.array(z.string().min(1).max(2000)).max(40).optional(),
  servings: z.number().int().min(1).max(24).optional(),
  active_minutes: z.number().int().min(0).max(600).nullable().optional(),
  total_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  difficulty: z.enum(['easy', 'moderate', 'advanced']).nullable().optional(),
  items: z.array(recipeItem).max(60).optional(),
  nutrition: z.record(z.string(), z.unknown()).nullable().optional(),
});

router.put('/recipes/revisions/:revId', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(rev.status as string)) return fail(req, 'conflict', 409, res);
  const p = recipePatch.safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const v = p.data;
  await query('UPDATE recipe_revisions SET servings=COALESCE($1,servings),active_minutes=COALESCE($2,active_minutes),total_minutes=COALESCE($3,total_minutes),difficulty=COALESCE($4,difficulty),nutrition=COALESCE($5,nutrition) WHERE id=$6',
    [v.servings ?? null, v.active_minutes ?? null, v.total_minutes ?? null, v.difficulty ?? null, v.nutrition ? JSON.stringify(v.nutrition) : null, req.params.revId]);
  for (const loc of ['en', 'es'] as const) {
    const title = loc === 'en' ? v.title_en : v.title_es;
    const desc = loc === 'en' ? v.description_en : v.description_es;
    const steps = loc === 'en' ? v.steps_en : v.steps_es;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (title !== undefined) { vals.push(title); sets.push(`title=$${vals.length}`); }
    if (desc !== undefined) { vals.push(desc); sets.push(`description=$${vals.length}`); }
    if (steps !== undefined) { vals.push(JSON.stringify(steps)); sets.push(`steps=$${vals.length}`); }
    if (sets.length) {
      await query(`UPDATE recipe_contents SET ${sets.join(', ')} WHERE revision_id=$${vals.length + 1} AND locale=$${vals.length + 2}`, [...vals, req.params.revId, loc]);
    }
  }
  if (v.items) {
    await query('DELETE FROM recipe_ingredients WHERE revision_id=$1', [req.params.revId]);
    for (const it of v.items) {
      await query('INSERT INTO recipe_ingredients(revision_id,ingredient_id,free_text,quantity,unit,optional) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.params.revId, it.ingredient_id ?? null, it.free_text ?? null, it.quantity, it.unit, it.optional ?? false]);
    }
  }
  await audit(req.user!.id, 'recipe_revision', req.params.revId, 'update_draft');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/recipes/revisions/:revId/submit', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(rev.status as string)) return fail(req, 'conflict', 409, res);
  await query("UPDATE recipe_revisions SET status='ready_for_review' WHERE id=$1", [req.params.revId]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, 'submit_review');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/recipes/revisions/:revId/approve', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (!['draft', 'ready_for_review'].includes(rev.status as string)) return fail(req, 'conflict', 409, res);
  const p = z.object({ allergens_reviewed: z.literal(true), verify_nutrition: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const { issues, allergens } = await validateRevision(req.params.revId);
  if (issues.length) {
    res.status(422).json({ data: { issues, allergens }, error: { code: 'invalid_input', message: msg('invalid_input', req.locale) }, request_id: req.id });
    return;
  }
  if (p.data.verify_nutrition) {
    const nut = rev.nutrition as { provenance?: unknown } | null;
    if (!nut || !nut.provenance) return fail(req, 'invalid_input', 422, res);
    await query('UPDATE recipe_revisions SET nutrition_verified=TRUE WHERE id=$1', [req.params.revId]);
  }
  await query('UPDATE recipe_revisions SET status=$1,reviewer_id=$2,reviewed_at=now() WHERE id=$3', ['approved', req.user!.id, req.params.revId]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, `approve allergens=${allergens.join('|') || 'none'}`);
  res.json({ data: { ok: true, allergens }, error: null, request_id: req.id });
});

router.post('/recipes/revisions/:revId/publish', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (rev.status !== 'approved') return fail(req, 'conflict', 409, res);
  await query("UPDATE recipe_revisions SET status='published' WHERE id=$1", [req.params.revId]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, 'publish');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

router.post('/recipes/:id/revisions', async (req, res) => {
  const latest = await query<{ id: string; revision: number }>('SELECT id,revision FROM recipe_revisions WHERE recipe_id=$1 ORDER BY revision DESC LIMIT 1', [req.params.id]);
  if (!latest.rowCount) return fail(req, 'not_found', 404, res);
  const src = latest.rows[0];
  const rev = await query<{ id: string }>(
    'INSERT INTO recipe_revisions(recipe_id,revision,status,servings,active_minutes,total_minutes,difficulty,nutrition) SELECT recipe_id,$1,$2,servings,active_minutes,total_minutes,difficulty,nutrition FROM recipe_revisions WHERE id=$3 RETURNING id',
    [src.revision + 1, 'draft', src.id],
  );
  const newId: string = rev.rows[0].id;
  await query('INSERT INTO recipe_contents(revision_id,locale,title,description,steps) SELECT $1,locale,title,description,steps FROM recipe_contents WHERE revision_id=$2', [newId, src.id]);
  await query('INSERT INTO recipe_ingredients(revision_id,ingredient_id,free_text,quantity,unit,optional) SELECT $1,ingredient_id,free_text,quantity,unit,optional FROM recipe_ingredients WHERE revision_id=$2', [newId, src.id]);
  await audit(req.user!.id, 'recipe', req.params.id, 'new_revision');
  res.status(201).json({ data: { revision_id: newId, revision: src.revision + 1 }, error: null, request_id: req.id });
});

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/srv/uploads';
const ALLOWED_UPLOADS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function sniffImage(buf: Buffer, mime: string): boolean {
  if (mime === 'image/png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

router.post('/uploads', async (req, res) => {
  const p = z.object({
    filename: z.string().min(1).max(120),
    mime: z.string().min(1).max(64),
    data_base64: z.string().min(60).max(4_000_000),
  }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const ext = ALLOWED_UPLOADS[p.data.mime];
  if (!ext) return fail(req, 'invalid_input', 422, res);
  let buf: Buffer;
  try {
    buf = Buffer.from(p.data.data_base64, 'base64');
  } catch {
    return fail(req, 'invalid_input', 422, res);
  }
  if (buf.length === 0 || buf.length > 2 * 1024 * 1024 || !sniffImage(buf, p.data.mime)) return fail(req, 'invalid_input', 422, res);
  const name = `${randomUUID()}.${ext}`;
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(join(UPLOAD_DIR, name), buf);
  } catch {
    return fail(req, 'server_error', 500, res);
  }
  await audit(req.user!.id, 'upload', name, 'recipe_image');
  res.status(201).json({ data: { path: `/media/${name}`, bytes: buf.length }, error: null, request_id: req.id });
});

router.post('/recipes/revisions/:revId/images', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(rev.status as string)) return fail(req, 'conflict', 409, res);
  const p = z.object({ path: z.string().regex(/^\/media\/[A-Za-z0-9-]+\.(png|jpg|webp)$/), alt: z.string().max(200).default('') }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  await query('INSERT INTO recipe_images(revision_id,path,alt,sort) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),-1)+1 FROM recipe_images WHERE revision_id=$1))',
    [req.params.revId, p.data.path, p.data.alt]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, 'image_add');
  res.status(201).json({ data: { ok: true }, error: null, request_id: req.id });
});

// M2 closeout: explicit validate + deterministic preview (no LLM arithmetic).
// Validate mirrors the same rules approve() enforces, so the editor can show
// fix-before-approval without attempting a state transition.
router.post('/recipes/revisions/:revId/validate', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  const { issues, allergens } = await validateRevision(req.params.revId);
  res.json({ data: { issues, allergens, valid: issues.length === 0 }, error: null, request_id: req.id });
});

// Preview scales ingredient quantities deterministically: qty_per_serving =
// base_qty / base_servings, scaled = qty_per_serving * requested_servings.
// Rounding only for display; server never invents nutrition figures.
router.get('/recipes/revisions/:revId/preview', async (req, res) => {
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  const locale = req.query.locale === 'es' ? 'es' : 'en';
  const servingsReq = Number(req.query.servings ?? (rev as { servings: number }).servings);
  if (!Number.isFinite(servingsReq) || servingsReq <= 0 || servingsReq > 24) return fail(req, 'invalid_input', 422, res);
  const baseServings = Number((rev as { servings: number }).servings) || 1;
  const contents = await query('SELECT locale,title,description,steps FROM recipe_contents WHERE revision_id=$1', [req.params.revId]);
  const items = await query(
    `SELECT ri.quantity,ri.unit,ri.optional,i.canonical_name,t.name
     FROM recipe_ingredients ri LEFT JOIN ingredients i ON i.id=ri.ingredient_id
     LEFT JOIN ingredient_translations t ON t.ingredient_id=ri.ingredient_id AND t.locale=$2
     WHERE ri.revision_id=$1`,
    [req.params.revId, locale],
  );
  const factor = servingsReq / baseServings;
  const scaled = items.rows.map((it) => {
    const r = it as unknown as { quantity: string; unit: string; optional: boolean; canonical_name: string | null; name: string | null };
    const base = Number(r.quantity);
    return { ...r, base_quantity: base, scaled_quantity: Math.round(base * factor * 100) / 100, servings: servingsReq, base_servings: baseServings };
  });
  res.json({ data: { revision: rev, locale, servings: servingsReq, base_servings: baseServings, contents: contents.rows, items: scaled }, error: null, request_id: req.id });
});

// M2 closeout: reviewer returns a submitted draft for corrections.
// ready_for_review -> changes_requested. Published/approved history untouched.
router.post('/recipes/revisions/:revId/request-changes', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (rev.status !== 'ready_for_review') return fail(req, 'conflict', 409, res);
  const p = z.object({ note: z.string().max(1000).default('') }).safeParse(req.body ?? {});
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  await query("UPDATE recipe_revisions SET status='changes_requested' WHERE id=$1", [req.params.revId]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, `request_changes ${p.data.note}`.slice(0, 200));
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

// M2 closeout: soft-archive an approved/published revision. Historical plan
// views keep resolving the archived revision id; it just stops being assignable
// for new slots (slots require status='published').
router.post('/recipes/revisions/:revId/archive', async (req, res) => {
  if (!req.user!.roles.includes('dietitian') && !req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const rev = await getRevision(req.params.revId);
  if (!rev) return fail(req, 'not_found', 404, res);
  if (!['approved', 'published'].includes(rev.status as string)) return fail(req, 'conflict', 409, res);
  await query("UPDATE recipe_revisions SET status='archived' WHERE id=$1", [req.params.revId]);
  await audit(req.user!.id, 'recipe_revision', req.params.revId, 'archive');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

// M2 closeout: duplicate a recipe into a brand-new draft (new slug required).
// Copies the latest revision's contents + ingredient lines verbatim.
router.post('/recipes/:id/duplicate', async (req, res) => {
  const p = z.object({ slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const src = await query<{ id: string }>('SELECT id FROM recipes WHERE id=$1', [req.params.id]);
  if (!src.rowCount) return fail(req, 'not_found', 404, res);
  const dup = await query('SELECT id FROM recipes WHERE slug=$1', [p.data.slug]);
  if (dup.rowCount) return fail(req, 'conflict', 409, res);
  const latest = await query<{ id: string }>('SELECT id FROM recipe_revisions WHERE recipe_id=$1 ORDER BY revision DESC LIMIT 1', [req.params.id]);
  if (!latest.rowCount) return fail(req, 'not_found', 404, res);
  const rec = await query<{ id: string }>('INSERT INTO recipes(slug,created_by) VALUES ($1,$2) RETURNING id', [p.data.slug, req.user!.id]);
  const newRecipeId: string = rec.rows[0].id;
  const rev = await query<{ id: string }>(
    'INSERT INTO recipe_revisions(recipe_id,revision,status,servings,active_minutes,total_minutes,difficulty,nutrition) SELECT $1,1,$2,servings,active_minutes,total_minutes,difficulty,nutrition FROM recipe_revisions WHERE id=$3 RETURNING id',
    [newRecipeId, 'draft', latest.rows[0].id],
  );
  const newRevId: string = rev.rows[0].id;
  await query('INSERT INTO recipe_contents(revision_id,locale,title,description,steps) SELECT $1,locale,title,description,steps FROM recipe_contents WHERE revision_id=$2', [newRevId, latest.rows[0].id]);
  await query('INSERT INTO recipe_ingredients(revision_id,ingredient_id,free_text,quantity,unit,optional) SELECT $1,ingredient_id,free_text,quantity,unit,optional FROM recipe_ingredients WHERE revision_id=$2', [newRevId, latest.rows[0].id]);
  await audit(req.user!.id, 'recipe', newRecipeId, `duplicate_of ${req.params.id}`);
  res.status(201).json({ data: { id: newRecipeId, revision_id: newRevId }, error: null, request_id: req.id });
});

// M2 closeout: approved substitutions (table 006 existed with no API).
// Only dietitian/administrator writes; swaps are per-recipe ingredient pairs
// with explicit unit/weight rules + constraints. Customer swap enforcement
// arrives with M4; this records the reviewed allowance.
const subBody = z.object({
  ingredient_id: z.string().uuid(),
  sub_ingredient_id: z.string().uuid(),
  rules: z.record(z.string(), z.unknown()).default({}),
});

router.get('/recipes/:id/substitutions', async (req, res) => {
  const src = await query('SELECT id FROM recipes WHERE id=$1', [req.params.id]);
  if (!src.rowCount) return fail(req, 'not_found', 404, res);
  const r = await query(
    `SELECT s.id,s.ingredient_id,s.sub_ingredient_id,s.rules,i1.canonical_name AS ingredient,i2.canonical_name AS substitute
     FROM recipe_approved_substitutions s
     JOIN ingredients i1 ON i1.id=s.ingredient_id
     JOIN ingredients i2 ON i2.id=s.sub_ingredient_id
     WHERE s.recipe_id=$1 ORDER BY s.created_at`, [req.params.id]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

router.post('/recipes/:id/substitutions', async (req, res) => {
  const src = await query('SELECT id FROM recipes WHERE id=$1', [req.params.id]);
  if (!src.rowCount) return fail(req, 'not_found', 404, res);
  const p = subBody.safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  if (p.data.ingredient_id === p.data.sub_ingredient_id) return fail(req, 'invalid_input', 422, res);
  for (const id of [p.data.ingredient_id, p.data.sub_ingredient_id]) {
    const ing = await query('SELECT id FROM ingredients WHERE id=$1', [id]);
    if (!ing.rowCount) return fail(req, 'invalid_input', 422, res);
  }
  try {
    const r = await query<{ id: string }>(
      'INSERT INTO recipe_approved_substitutions(recipe_id,ingredient_id,sub_ingredient_id,rules,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, p.data.ingredient_id, p.data.sub_ingredient_id, JSON.stringify(p.data.rules), req.user!.id]);
    await audit(req.user!.id, 'recipe', req.params.id, `substitution_add ${r.rows[0].id}`);
    res.status(201).json({ data: { id: r.rows[0].id }, error: null, request_id: req.id });
  } catch {
    return fail(req, 'conflict', 409, res);
  }
});

router.delete('/substitutions/:subId', async (req, res) => {
  const cur = await query('SELECT id FROM recipe_approved_substitutions WHERE id=$1', [req.params.subId]);
  if (!cur.rowCount) return fail(req, 'not_found', 404, res);
  await query('DELETE FROM recipe_approved_substitutions WHERE id=$1', [req.params.subId]);
  await audit(req.user!.id, 'substitution', req.params.subId, 'remove');
  res.json({ data: { ok: true }, error: null, request_id: req.id });
});

export default router;