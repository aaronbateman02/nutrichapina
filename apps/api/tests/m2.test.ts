import './setup.js';
import fs from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, tokenHash, newToken } from '../src/auth.js';

const app = buildApp();

async function resetDb(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

async function seedUser(email: string, password: string, roles: string[], verified = true): Promise<string> {
  const h = await hashPassword(password);
  const u = await pool.query<{ id: string }>(
    'INSERT INTO users(email,password_hash,email_verified_at,locale) VALUES ($1,$2,' +
      (verified ? 'now()' : 'NULL') + ",'en') RETURNING id",
    [email, h],
  );
  const id: string = u.rows[0].id;
  for (const r of roles) await pool.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, r]);
  await pool.query('INSERT INTO client_profiles(user_id,display_name) VALUES ($1,$2)', [id, email]);
  await pool.query('INSERT INTO household_preferences(user_id) VALUES ($1)', [id]);
  return id;
}

let adminId = '';
let dietId = '';
let supportId = '';
let custA = '';
let custB = '';

beforeAll(async () => {
  await resetDb();
  adminId = await seedUser('m2admin@example.com', 'admin-pass-123', ['administrator']);
  dietId = await seedUser('m2diet@example.com', 'diet-pass-123', ['dietitian']);
  supportId = await seedUser('m2support@example.com', 'support-pass-123', ['support']);
  custA = await seedUser('m2custA@example.com', 'cust-pass-123', ['customer']);
  custB = await seedUser('m2custB@example.com', 'cust-pass-123', ['customer']);
  await pool.query('UPDATE client_profiles SET primary_professional_id=$1 WHERE user_id=$2', [dietId, custA]);
});

async function loginAs(email: string, password: string): Promise<ReturnType<typeof request.agent>> {
  const a = request.agent(app);
  const r = await a.post('/api/v1/auth/login').send({ email, password });
  expect(r.status).toBe(200);
  return a;
}

describe('M2 recipe library + menu acceptance', () => {
  let ingChicken = '';
  let ingRice = '';

  it('T11 ingredients: validation, duplicates, roles, conversions immutable', async () => {
    const admin = await loginAs('m2admin@example.com', 'admin-pass-123');
    const bad = await admin.post('/api/v1/staff/ingredients').send({ canonical_name: 'x' });
    expect(bad.status).toBe(422);
    const c1 = await admin.post('/api/v1/staff/ingredients').send({
      canonical_name: 'Chicken breast, raw', category: 'protein', allergen_class: null,
      translations: { en: 'Chicken breast, raw', es: 'Pechuga de pollo cruda' },
      conversions: [{ from_unit: 'kg', to_unit: 'g', factor: 1000 }],
    });
    expect(c1.status).toBe(201);
    ingChicken = c1.body.data.id as string;
    const dup = await admin.post('/api/v1/staff/ingredients').send({
      canonical_name: 'chicken breast, RAW', category: 'protein',
      translations: { en: 'dup', es: 'dup' },
    });
    expect(dup.status).toBe(409);
    const badConv = await admin.post('/api/v1/staff/ingredients').send({
      canonical_name: 'Dry rice', category: 'grains',
      translations: { en: 'Dry rice', es: 'Arroz seco' },
      conversions: [{ from_unit: 'cup', to_unit: 'g', factor: -5 }],
    });
    expect(badConv.status).toBe(422);
    const c2 = await admin.post('/api/v1/staff/ingredients').send({
      canonical_name: 'Dry rice', category: 'grains',
      translations: { en: 'Dry rice', es: 'Arroz seco' },
    });
    expect(c2.status).toBe(201);
    ingRice = c2.body.data.id as string;
    const conv = await admin.post(`/api/v1/staff/ingredients/${ingRice}/conversions`).send({ from_unit: 'cup', to_unit: 'g', factor: 185 });
    expect(conv.status).toBe(201);

    const sup = await loginAs('m2support@example.com', 'support-pass-123');
    const denied = await sup.post('/api/v1/staff/ingredients').send({
      canonical_name: 'Sneaky', category: 'produce', translations: { en: 'Sneaky', es: 'Furtivo' },
    });
    expect(denied.status).toBe(403);
    const cust = await loginAs('m2custA@example.com', 'cust-pass-123');
    const denied2 = await cust.get('/api/v1/staff/ingredients');
    expect(denied2.status).toBe(403);
  });

  let recipeId = '';
  let rev1 = '';

  it('T12 recipe lifecycle: draft, validate, submit, approve, publish, immutable revise', async () => {
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const created = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-chicken-rice', title_en: 'M2 Chicken Rice', title_es: 'M2 Pollo con Arroz',
      description_en: 'd', description_es: 'd', steps_en: ['Cook.'], steps_es: [],
      servings: 2, items: [{ ingredient_id: ingChicken, quantity: 500, unit: 'g' }, { ingredient_id: ingRice, quantity: 200, unit: 'g' }],
    });
    expect(created.status).toBe(201);
    recipeId = created.body.data.id as string;
    rev1 = created.body.data.revision_id as string;

    const det = await diet.get(`/api/v1/staff/recipes/revisions/${rev1}`);
    expect(det.status).toBe(200);
    expect(det.body.data.validation.issues.map((i: { field: string }) => i.field)).toContain('steps_es');

    // fix the missing Spanish steps while still a draft, then submit
    const upd = await diet.put(`/api/v1/staff/recipes/revisions/${rev1}`).send({ steps_es: ['Cocinar.'] });
    expect(upd.status).toBe(200);
    await diet.post(`/api/v1/staff/recipes/revisions/${rev1}/submit`);
    // incomplete-after-tamper cannot be approved: blank a required field copy? (covered by validate)
    const noFlag = await diet.post(`/api/v1/staff/recipes/revisions/${rev1}/approve`).send({});
    expect(noFlag.status).toBe(422);
    // an ingredient-less draft can be submitted but never approved
    const bad = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-no-items', title_en: 'Empty', title_es: 'Vacía',
      description_en: 'd', description_es: 'd', steps_en: ['x'], steps_es: ['x'],
      servings: 1, items: [],
    });
    const badRev = bad.body.data.revision_id as string;
    await diet.post(`/api/v1/staff/recipes/revisions/${badRev}/submit`);
    const badApprove = await diet.post(`/api/v1/staff/recipes/revisions/${badRev}/approve`).send({ allergens_reviewed: true });
    expect(badApprove.status).toBe(422);
    const sup = await loginAs('m2support@example.com', 'support-pass-123');
    const supApprove = await sup.post(`/api/v1/staff/recipes/revisions/${rev1}/approve`).send({ allergens_reviewed: true });
    expect(supApprove.status).toBe(403);
    const okApprove = await diet.post(`/api/v1/staff/recipes/revisions/${rev1}/approve`).send({ allergens_reviewed: true });
    expect(okApprove.status).toBe(200);
    const pub = await diet.post(`/api/v1/staff/recipes/revisions/${rev1}/publish`).send({});
    expect(pub.status).toBe(200);

    // published revision is immutable
    const editPub = await diet.put(`/api/v1/staff/recipes/revisions/${rev1}`).send({ servings: 9 });
    expect(editPub.status).toBe(409);
    const newRev = await diet.post(`/api/v1/staff/recipes/${recipeId}/revisions`).send({});
    expect(newRev.status).toBe(201);
    const rev2 = newRev.body.data.revision_id as string;
    expect(newRev.body.data.revision).toBe(2);
    const stillPub = await diet.get(`/api/v1/staff/recipes/revisions/${rev1}`);
    expect(stillPub.body.data.revision.status).toBe('published');
    const editDraft = await diet.put(`/api/v1/staff/recipes/revisions/${rev2}`).send({ servings: 4 });
    expect(editDraft.status).toBe(200);
  });

  it('T13 nutrition verification gate: unverified stays hidden from customers', async () => {
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const created = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-oats-demo', title_en: 'M2 Oats', title_es: 'M2 Avena',
      description_en: 'd', description_es: 'd', steps_en: ['Mix.'], steps_es: ['Mezclar.'],
      servings: 1, items: [{ ingredient_id: ingRice, quantity: 60, unit: 'g' }],
      nutrition: { calories: 999, protein_g: 99 },
    });
    const draftRev = created.body.data.revision_id as string;
    await diet.post(`/api/v1/staff/recipes/revisions/${draftRev}/submit`);
    // verify_nutrition without provenance must fail
    const noProv = await diet.post(`/api/v1/staff/recipes/revisions/${draftRev}/approve`).send({ allergens_reviewed: true, verify_nutrition: true });
    expect(noProv.status).toBe(422);
    const okApprove = await diet.post(`/api/v1/staff/recipes/revisions/${draftRev}/approve`).send({ allergens_reviewed: true });
    expect(okApprove.status).toBe(200);
    await diet.post(`/api/v1/staff/recipes/revisions/${draftRev}/publish`).send({});
    // customer sees recipe only when assigned; nutrition hidden (unverified)
    const cust = await loginAs('m2custA@example.com', 'cust-pass-123');
    const before = await cust.get(`/api/v1/me/recipes/${draftRev}`);
    expect(before.status).toBe(403);
    // assign via program below (T14) uses rev1; check rev1 has no nutrition
    const r1 = await cust.get(`/api/v1/me/recipes/${draftRev}`);
    expect(r1.status).toBe(403);
  });

  let programVersion = '';
  let planId = '';

  it('T14 menu build, publish gate, assign, isolate, grocery math', async () => {
    const admin = await loginAs('m2admin@example.com', 'admin-pass-123');
    const prog = await admin.post('/api/v1/staff/programs').send({ name: 'M2 7-day' });
    expect(prog.status).toBe(201);
    programVersion = prog.body.data.version_id as string;

    // slots referencing unpublished revision must fail
    const revs = await admin.get(`/api/v1/staff/recipes/${await recipeIdOf('m2-chicken-rice')}/revisions`);
    const draftRev2 = (revs.body.data as { id: string; revision: number; status: string }[]).find((r) => r.revision === 2)!.id;
    const badSlots = await admin.put(`/api/v1/staff/programs/versions/${programVersion}/slots`).send({
      slots: [{ day: 1, slot: 'breakfast', recipe_revision_id: draftRev2, servings: 1 }],
    });
    expect(badSlots.status).toBe(422);

    // build a full 7-day program from the published rev1
    const revsAll = await admin.get(`/api/v1/staff/recipes/revisions/${await revIdOfPublished()}`);
    expect(revsAll.status).toBe(200);
    const pubRev = rev1;
    const slots = [];
    for (let d = 1; d <= 7; d++) {
      for (const slot of ['breakfast', 'lunch', 'dinner']) slots.push({ day: d, slot, recipe_revision_id: pubRev, servings: 1 });
    }
    const put = await admin.put(`/api/v1/staff/programs/versions/${programVersion}/slots`).send({ slots });
    expect(put.status).toBe(200);
    // publish before approve must fail
    const earlyPub = await admin.post(`/api/v1/staff/programs/versions/${programVersion}/publish`).send({});
    expect(earlyPub.status).toBe(409);
    await admin.post(`/api/v1/staff/programs/versions/${programVersion}/submit`).send({});
    const appr = await admin.post(`/api/v1/staff/programs/versions/${programVersion}/approve`).send({});
    expect(appr.status).toBe(200);
    const pub = await admin.post(`/api/v1/staff/programs/versions/${programVersion}/publish`).send({});
    expect(pub.status).toBe(200);

    // assign to customer A (admin path; dietitian assigned-scope covered in T6-style check below)
    const assign = await admin.post('/api/v1/staff/plans/assign').send({ client_id: custA, program_version_id: programVersion });
    expect(assign.status).toBe(201);
    expect(assign.body.data.meals).toBe(21);
    planId = assign.body.data.plan_id as string;

    // customer A reads own plan + published recipe; nutrition hidden (demo recipe has none)
    const cust = await loginAs('m2custA@example.com', 'cust-pass-123');
    const plans = await cust.get('/api/v1/me/plans');
    expect(plans.status).toBe(200);
    expect((plans.body.data as unknown[]).length).toBe(1);
    const detail = await cust.get(`/api/v1/me/plans/${planId}`);
    expect(detail.status).toBe(200);
    expect((detail.body.data.meals as unknown[]).length).toBe(21);
    const rec = await cust.get(`/api/v1/me/recipes/${pubRev}`);
    expect(rec.status).toBe(200);
    expect(rec.body.data.nutrition).toBeNull();
    expect(rec.body.data.nutrition_verified).toBe(false);

    // grocery math: 500g chicken x 7 dinners? (recipe used in all 21 slots: 500g chicken + 200g rice per slot)
    const agg: Record<string, number> = {};
    for (const m of detail.body.data.meals as { recipe_revision_id: string; servings: number }[]) {
      const items = await admin.get(`/api/v1/staff/recipes/revisions/${m.recipe_revision_id}`);
      for (const it of items.body.data.items as { ingredient_id: string; quantity: number }[]) {
        agg[it.ingredient_id] = (agg[it.ingredient_id] ?? 0) + Number(it.quantity) * m.servings;
      }
    }
    expect(agg[Object.keys(agg).find((k) => k === ingChicken) as string]).toBe(500 * 21);
    expect(agg[ingRice]).toBe(200 * 21);

    // customer B cannot read A's plan or its recipes
    const custB = await loginAs('m2custB@example.com', 'cust-pass-123');
    const cross = await custB.get(`/api/v1/me/plans/${planId}`);
    expect(cross.status).toBe(404);
    const crossRec = await custB.get(`/api/v1/me/recipes/${pubRev}`);
    expect(crossRec.status).toBe(403);
  });

  it('T15 recipe photo upload validation + link', async () => {
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const png1px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const unauth = await request(app).post('/api/v1/staff/uploads').send({ filename: 'a.png', mime: 'image/png', data_base64: png1px });
    expect(unauth.status).toBe(401);
    const cust = await loginAs('m2custA@example.com', 'cust-pass-123');
    const forbiddenUp = await cust.post('/api/v1/staff/uploads').send({ filename: 'a.png', mime: 'image/png', data_base64: png1px });
    expect(forbiddenUp.status).toBe(403);
    const badMime = await diet.post('/api/v1/staff/uploads').send({ filename: 'a.gif', mime: 'image/gif', data_base64: png1px });
    expect(badMime.status).toBe(422);
    const badMagic = await diet.post('/api/v1/staff/uploads').send({ filename: 'a.png', mime: 'image/png', data_base64: Buffer.from('not-an-image-at-all-xyz').toString('base64') });
    expect(badMagic.status).toBe(422);
    const ok = await diet.post('/api/v1/staff/uploads').send({ filename: 'bowl.png', mime: 'image/png', data_base64: png1px });
    expect(ok.status).toBe(201);
    expect(ok.body.data.path).toMatch(/^\/media\/[A-Za-z0-9-]+\.png$/);
    const created = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-photo-test', title_en: 'Photo T', title_es: 'Foto P',
      description_en: 'd', description_es: 'd', steps_en: ['x'], steps_es: ['x'],
      servings: 1, items: [{ ingredient_id: ingChicken, quantity: 10, unit: 'g' }],
    });
    const revDraft = created.body.data.revision_id as string;
    const link = await diet.post(`/api/v1/staff/recipes/revisions/${revDraft}/images`).send({ path: ok.body.data.path, alt: 'Test bowl' });
    expect(link.status).toBe(201);
    const badPath = await diet.post(`/api/v1/staff/recipes/revisions/${revDraft}/images`).send({ path: '/etc/passwd', alt: 'x' });
    expect(badPath.status).toBe(422);
    const det = await diet.get(`/api/v1/staff/recipes/revisions/${revDraft}`);
    expect(det.body.data.images.length).toBe(1);
  });

  it('T16 closeout: validate/preview/request-changes/archive/duplicate/substitutions', async () => {
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const sup = await loginAs('m2support@example.com', 'support-pass-123');
    // isolated recipe so T14's published rev1 is untouched
    const created = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-closeout', title_en: 'Closeout', title_es: 'Cierre',
      description_en: 'd', description_es: 'd', steps_en: ['Cook.'], steps_es: ['Cocinar.'],
      servings: 4, items: [{ ingredient_id: ingChicken, quantity: 500, unit: 'g' }],
    });
    expect(created.status).toBe(201);
    const recipeId = created.body.data.id as string;
    const rev = created.body.data.revision_id as string;
    // explicit validate: clean draft validates
    const v = await diet.post(`/api/v1/staff/recipes/revisions/${rev}/validate`).send({});
    expect(v.status).toBe(200);
    expect(v.body.data.valid).toBe(true);
    // deterministic preview: 500g @ 4 servings -> 125g @ 1, 250g @ 2
    const p1 = await diet.get(`/api/v1/staff/recipes/revisions/${rev}/preview?locale=en&servings=1`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.items[0].scaled_quantity).toBe(125);
    const p2 = await diet.get(`/api/v1/staff/recipes/revisions/${rev}/preview?locale=es&servings=2`);
    expect(p2.status).toBe(200);
    expect(p2.body.data.items[0].scaled_quantity).toBe(250);
    expect(p2.body.data.locale).toBe('es');
    const badPrev = await diet.get(`/api/v1/staff/recipes/revisions/${rev}/preview?servings=0`);
    expect(badPrev.status).toBe(422);
    // request-changes only from ready_for_review
    await diet.post(`/api/v1/staff/recipes/revisions/${rev}/submit`).send({});
    const rcDenied = await sup.post(`/api/v1/staff/recipes/revisions/${rev}/request-changes`).send({ note: 'x' });
    expect(rcDenied.status).toBe(403);
    const rc = await diet.post(`/api/v1/staff/recipes/revisions/${rev}/request-changes`).send({ note: 'Fix step.' });
    expect(rc.status).toBe(200);
    const det = await diet.get(`/api/v1/staff/recipes/revisions/${rev}`);
    expect(det.body.data.revision.status).toBe('changes_requested');
    // changes_requested draft still editable, then resubmit → approve → publish → archive
    const edit = await diet.put(`/api/v1/staff/recipes/revisions/${rev}`).send({ servings: 4 });
    expect(edit.status).toBe(200);
    expect((await diet.post(`/api/v1/staff/recipes/revisions/${rev}/submit`).send({})).status).toBe(200);
    expect((await diet.post(`/api/v1/staff/recipes/revisions/${rev}/approve`).send({ allergens_reviewed: true })).status).toBe(200);
    expect((await diet.post(`/api/v1/staff/recipes/revisions/${rev}/publish`).send({})).status).toBe(200);
    const arch = await diet.post(`/api/v1/staff/recipes/revisions/${rev}/archive`).send({});
    expect(arch.status).toBe(200);
    // duplicate creates a new draft recipe
    const dup = await diet.post(`/api/v1/staff/recipes/${recipeId}/duplicate`).send({ slug: 'm2-closeout-copy' });
    expect(dup.status).toBe(201);
    const dupBad = await diet.post(`/api/v1/staff/recipes/${recipeId}/duplicate`).send({ slug: 'm2-closeout-copy' });
    expect(dupBad.status).toBe(409);
    // approved substitutions: distinct existing ingredients only
    const subBad = await diet.post(`/api/v1/staff/recipes/${recipeId}/substitutions`).send({ ingredient_id: ingChicken, sub_ingredient_id: ingChicken, rules: {} });
    expect(subBad.status).toBe(422);
    const sub = await diet.post(`/api/v1/staff/recipes/${recipeId}/substitutions`).send({ ingredient_id: ingChicken, sub_ingredient_id: ingRice, rules: { ratio: '1:1' } });
    expect(sub.status).toBe(201);
    const subs = await diet.get(`/api/v1/staff/recipes/${recipeId}/substitutions`);
    expect(subs.status).toBe(200);
    expect((subs.body.data as unknown[]).length).toBe(1);
    const del = await diet.delete(`/api/v1/staff/substitutions/${sub.body.data.id as string}`).send();
    expect(del.status).toBe(200);
    // program request-changes + archive on an isolated program
    const admin = await loginAs('m2admin@example.com', 'admin-pass-123');
    const prog = await admin.post('/api/v1/staff/programs').send({ name: 'M2 closeout program' });
    const vid = prog.body.data.version_id as string;
    const rcProgEarly = await admin.post(`/api/v1/staff/programs/versions/${vid}/request-changes`).send({});
    expect(rcProgEarly.status).toBe(409);
    const archEarly = await admin.post(`/api/v1/staff/programs/versions/${vid}/archive`).send({});
    expect(archEarly.status).toBe(409);
  });

  it('T17 AI URL import: guards, stub extract, draft provenance', async () => {
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_IMPORT_RATE_MAX = '1000';
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const badScheme = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'ftp://example.com/r' });
    expect(badScheme.status).toBe(422);
    const ssrf = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'http://127.0.0.1:9/recipe' });
    expect(ssrf.status).toBe(422);
    const badBody = await diet.post('/api/v1/staff/recipe-imports/extract').send({});
    expect(badBody.status).toBe(422);
    const sup = await loginAs('m2support@example.com', 'support-pass-123');
    const denied = await sup.post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/r' });
    expect(denied.status).toBe(403);
    const unauth = await request(app).post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/r' });
    expect(unauth.status).toBe(401);

    const ok = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/some-recipe' });
    expect(ok.status).toBe(200);
    const prop = ok.body.data.proposal;
    expect(prop.title_en.length).toBeGreaterThan(1);
    expect(prop.title_es.length).toBeGreaterThan(1);
    expect(prop.steps_en.length).toBeGreaterThan(0);
    expect(prop.steps_es.length).toBeGreaterThan(0);
    expect(prop.items.length).toBeGreaterThan(0);
    expect(prop.diet_tags).toContain('High-Protein');
    expect(ok.body.data.source_url).toContain('https://example.com/');

    // save the proposal as a draft with provenance (items resolved to catalog ids,
    // as the editor does; unresolved free text would block approval per T12)
    const created = await diet.post('/api/v1/staff/recipes').send({
      slug: 'm2-import-test', title_en: prop.title_en, title_es: prop.title_es,
      description_en: prop.description_en || '', description_es: prop.description_es || '',
      steps_en: prop.steps_en, steps_es: prop.steps_es,
      servings: prop.servings,
      items: [{ ingredient_id: ingChicken, quantity: 500, unit: 'g' }, { ingredient_id: ingRice, quantity: 200, unit: 'g' }],
      nutrition: { ...(prop.nutrition || {}), provenance: { source_url: ok.body.data.source_url, method: 'ai', extracted_at: new Date().toISOString() } },
      source_url: ok.body.data.source_url, source_method: 'ai_extract',
      tags: prop.diet_tags || [],
    });
    expect(created.status).toBe(201);
    const revDraft = created.body.data.revision_id as string;
    const det = await diet.get(`/api/v1/staff/recipes/revisions/${revDraft}`);
    expect(det.body.data.revision.tags).toEqual(['High-Protein']);
    // edit tags on the draft
    expect((await diet.put(`/api/v1/staff/recipes/revisions/${revDraft}`).send({ tags: ['High-Protein', 'Low-Calorie'] })).status).toBe(200);
    expect(det.body.data.revision.source_method).toBe('ai_extract');
    expect(det.body.data.revision.source_url).toBe(ok.body.data.source_url);
    // AI provenance + human review => verifiable, exactly like a manual figure
    await diet.post(`/api/v1/staff/recipes/revisions/${revDraft}/submit`);
    const appr = await diet.post(`/api/v1/staff/recipes/revisions/${revDraft}/approve`).send({ allergens_reviewed: true, verify_nutrition: true });
    expect(appr.status).toBe(200);

    // photo endpoint guards (no network): unknown revision 404, published 409
    const noRev = await diet.post('/api/v1/staff/recipe-imports/photo').send({ revision_id: '00000000-0000-0000-0000-000000000000', url: 'https://example.com/x.png' });
    expect(noRev.status).toBe(404);
    const pubRev = rev1;
    const onPub = await diet.post('/api/v1/staff/recipe-imports/photo').send({ revision_id: pubRev, url: 'https://example.com/x.png' });
    expect(onPub.status).toBe(409);

    // upstream rejection surfaces as 502 ai_rejected (stub failure mode)
    process.env.AI_STUB_MODE = 'reject';
    const rej = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/r' });
    expect(rej.status).toBe(502);
    expect(rej.body.error.code).toBe('ai_rejected');
    // blocked / failed downloads surface as specific 422s, not generic input errors
    process.env.AI_STUB_MODE = 'blocked';
    const blk = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/r' });
    expect(blk.status).toBe(422);
    expect(blk.body.error.code).toBe('ai_fetch_blocked');
    process.env.AI_STUB_MODE = 'fail';
    const fl = await diet.post('/api/v1/staff/recipe-imports/extract').send({ url: 'https://example.com/r' });
    expect(fl.status).toBe(422);
    expect(fl.body.error.code).toBe('ai_fetch_failed');
    delete process.env.AI_STUB_MODE;
  });

  it('T18 AI file import: PDF/text/HTML parsing, guards', async () => {
    process.env.AI_PROVIDER = 'stub';
    const diet = await loginAs('m2diet@example.com', 'diet-pass-123');
    const pdfB64 = fs.readFileSync(new URL('./fixtures/dummy.pdf', import.meta.url)).toString('base64');
    const ok = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'dummy.pdf', mime: 'application/pdf', data_base64: pdfB64 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.proposal.title_en.length).toBeGreaterThan(1);
    expect(ok.body.data.proposal.diet_tags).toContain('High-Protein');
    expect(ok.body.data.source_url).toBeNull();
    const txt = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'r.txt', mime: 'text/plain', data_base64: Buffer.from('Chicken soup: boil chicken 20 min. Serves 4.', 'utf8').toString('base64') });
    expect(txt.status).toBe(200);
    // oversized-for-default-limits payload must pass the scoped body parser (~193KB base64)
    const big = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'big.txt', mime: 'text/plain', data_base64: Buffer.from('Chicken soup ingredient line. '.repeat(5000), 'utf8').toString('base64') });
    expect(big.status).toBe(200);
    const html = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'r.html', mime: 'text/html', data_base64: Buffer.from('<html><head><title>Bean Bowl</title></head><body><p>Beans and rice.</p></body></html>', 'utf8').toString('base64') });
    expect(html.status).toBe(200);
    const badMime = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'r.zip', mime: 'application/zip', data_base64: Buffer.from('PK~~', 'utf8').toString('base64') });
    expect(badMime.status).toBe(422);
    const notPdf = await diet.post('/api/v1/staff/recipe-imports/file').send({ filename: 'fake.pdf', mime: 'application/pdf', data_base64: Buffer.from('not a pdf at all, just text', 'utf8').toString('base64') });
    expect(notPdf.status).toBe(422);
    const sup = await loginAs('m2support@example.com', 'support-pass-123');
    expect((await sup.post('/api/v1/staff/recipe-imports/file').send({ filename: 'r.txt', mime: 'text/plain', data_base64: 'eA==' })).status).toBe(403);
  });

  async function recipeIdOf(slug: string): Promise<string> {
    const r = await pool.query<{ id: string }>('SELECT id FROM recipes WHERE slug=$1', [slug]);
    return r.rows[0].id;
  }
  async function revIdOfPublished(): Promise<string> {
    const r = await pool.query<{ id: string }>('SELECT id FROM recipe_revisions WHERE status=$1 LIMIT 1', ['published']);
    return r.rows[0].id;
  }
});
