import { Router } from 'express';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireRole, audit, rateLimit } from '../auth.js';
import { sniffImage } from './catalog.js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const router = Router();
// AI-assisted recipe import: dietitian and administrator only. Imports ALWAYS
// land as unreviewed draft proposals (never saved, never published); the normal
// submit → approve → publish flow with human review applies unchanged.
router.use(requireRole('administrator', 'dietitian'));

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

// Maps model-gateway failures to stable API codes: missing key/config → 501,
// upstream auth/entitlement refusal → 502, everything else → 500.
function aiError(req: { locale: 'en' | 'es' }, res: { status: (n: number) => { json: (b: unknown) => void } }, e: unknown) {
  const em = (e as Error).message || '';
  if (em === 'ai_not_configured') {
    res.status(501).json({ data: null, error: { code: 'ai_not_configured', message: msg('ai_not_configured', req.locale) }, request_id: (req as unknown as { id: string }).id });
    return;
  }
  if (em === 'ai_upstream_401' || em === 'ai_upstream_403') {
    res.status(502).json({ data: null, error: { code: 'ai_rejected', message: msg('ai_rejected', req.locale) }, request_id: (req as unknown as { id: string }).id });
    return;
  }
  if (em.startsWith('fetch_blocked')) {
    res.status(422).json({ data: null, error: { code: 'ai_fetch_blocked', message: msg('ai_fetch_blocked', req.locale) }, request_id: (req as unknown as { id: string }).id });
    return;
  }
  if (em.startsWith('fetch_')) {
    res.status(422).json({ data: null, error: { code: 'ai_fetch_failed', message: msg('ai_fetch_failed', req.locale) }, request_id: (req as unknown as { id: string }).id });
    return;
  }
  return fail(req, 'server_error', 500, res);
}

// ---------- SSRF-guarded fetch (page text and images) ----------
function isPrivateIp(ip: string): boolean {
  let v = ip;
  const mapped = v.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  if (v.includes(':')) {
    const l = v.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const first = l.split(':')[0] || '';
    if (first.startsWith('fc') || first.startsWith('fd')) return true; // fc00::/7
    if (/^fe[89]/.test(first)) return true; // fe80::/10
    return false;
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true; // EC2 metadata + link-local
  return false;
}

async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad url');
  if (!u.hostname || u.username || u.password) throw new Error('bad url');
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length) throw new Error('bad url');
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('bad url');
}

async function fetchPublic(
  urlStr: string,
  opts: { maxBytes: number; timeoutMs: number; expect: (ct: string) => boolean },
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let current = urlStr;
  for (let i = 0; i < 4; i++) {
    const u = new URL(current);
    await assertPublicUrl(u);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'NutriChapinaRecipeImport/1.0', Accept: opts.expect === expectHtml ? 'text/html' : 'image/*' },
      });
    } finally {
      clearTimeout(t);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location') as string, current).toString();
      continue;
    }
    if (!res.ok) throw new Error((res.status === 401 || res.status === 403 || res.status === 429 ? 'fetch_blocked:' : 'fetch_failed:') + res.status);
    const ct = res.headers.get('content-type') || '';
    if (!opts.expect(ct)) throw new Error('fetch_content');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > opts.maxBytes) throw new Error('fetch_size');
    return { buffer: buf, contentType: ct, finalUrl: current };
  }
  throw new Error('fetch_failed:redirects');
}

const expectHtml = (ct: string): boolean => ct.toLowerCase().includes('text/html');
const expectImage = (ct: string): boolean => ct.toLowerCase().startsWith('image/');

function htmlToText(html: string): { title: string; text: string; image: string | null } {
  const title = ((html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1] || '').trim();
  const image = ((html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']{1,2000})["']/i) || [])[1] || null);
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&(nbsp|amp|quot|#39|lt|gt);/g, (m) =>
    ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' })[m] || ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return { title, text: t.slice(0, 12000), image };
}

// ---------- uniform proposal schema (what the editor consumes) ----------
// Coerce the model's occasional explicit nulls (zod defaults only cover missing
// keys): optional strings become '', unknown count units become 'unit'.
const optStr = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string().max(max));
const unitStr = z.preprocess(
  (v) => (typeof v === 'string' && v.length > 0 && v.length <= 16 ? v : 'unit'),
  z.string().min(1).max(16),
);
const qtyNum = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().positive().finite().nullable().default(null),
);

const proposalItem = z.object({
  name_en: z.string().min(1).max(200),
  name_es: optStr(200),
  quantity: qtyNum,
  unit: unitStr,
  notes: optStr(200),
});

function aiImportLimit(): number {
  const v = Number(process.env.AI_IMPORT_RATE_MAX || 10);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
}

const proposalSchema = z.object({
  title_en: z.string().min(2).max(160),
  title_es: z.string().min(2).max(160),
  description_en: optStr(2000),
  description_es: optStr(2000),
  servings: z.number().int().min(1).max(24).default(1),
  active_minutes: z.number().int().min(0).max(600).nullable().default(null),
  total_minutes: z.number().int().min(0).max(1440).nullable().default(null),
  difficulty: z.enum(['easy', 'moderate', 'advanced']).nullable().default(null),
  items: z.array(proposalItem).min(1).max(60),
  steps_en: z.array(z.string().min(1).max(2000)).min(1).max(40),
  steps_es: z.array(z.string().min(1).max(2000)).min(1).max(40),
  nutrition: z.object({
    calories: z.number().nonnegative().finite().optional(),
    protein_g: z.number().nonnegative().finite().optional(),
    carbs_g: z.number().nonnegative().finite().optional(),
    fiber_g: z.number().nonnegative().finite().optional(),
    fat_g: z.number().nonnegative().finite().optional(),
  }).default({}),
  allergens_hint: z.array(z.string().max(64)).max(20).default([]),
  diet_tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  photo_url: z.string().url().max(2000).nullable().default(null),
});

const SYSTEM_PROMPT = `You extract a cooking recipe from a web page into a uniform JSON structure.
Rules:
- Return ONLY a single JSON object, no prose, no markdown fences.
- Keys exactly: title_en, title_es, description_en, description_es, servings, active_minutes, total_minutes, difficulty, items, steps_en, steps_es, nutrition, diet_tags, allergens_hint, photo_url.
- Provide BOTH English and Spanish titles, descriptions and steps (translate faithfully; keep quantities identical).
- servings: integer yield of the recipe (default 1 if unclear).
- items: array of {name_en, name_es, quantity, unit, notes}; quantity is a number or null when the page gives none; unit is a short unit like g, kg, ml, cup, tbsp, unit (default "g" is wrong for counts: use "unit", "slice" etc.).
- steps_en/steps_es: ordered instructions, one string per step.
- nutrition: include ONLY figures the page actually states (keys: calories, protein_g, carbs_g, fiber_g, fat_g); omit the whole object or leave it empty when unstated. Never invent numbers.
- diet_tags: dietary or collection labels the page EXPLICITLY states (e.g. High-Protein, Low-Calorie, Diabetes-Friendly, Mediterranean Diet, Nut-Free, Vegetarian). Transcribe only what is written; never infer or invent tags. Empty array when none are stated.
- allergens_hint: obvious allergens you notice (e.g. milk, egg, peanut, wheat, fish), empty array when unsure.
- photo_url: main recipe photo URL if clearly present, else null.
- difficulty: easy, moderate or advanced, else null.`;

const OPENCODE_GO_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions';

async function callAi(pageTitle: string, pageText: string, sessionId: string): Promise<unknown> {
  const provider = process.env.AI_PROVIDER || '';
  if (provider === 'stub') {
    if (process.env.AI_STUB_MODE === 'reject') throw new Error('ai_upstream_403');
    if (process.env.AI_STUB_MODE === 'blocked') throw new Error('fetch_blocked:403');
    if (process.env.AI_STUB_MODE === 'fail') throw new Error('fetch_failed:timeout');
    return {
      title_en: 'Stub Imported Bowl', title_es: 'Tazón importado (stub)',
      description_en: 'stub', description_es: 'stub',
      servings: 2, active_minutes: 10, total_minutes: 20, difficulty: 'easy',
      items: [
        { name_en: 'Stub chicken', name_es: 'Pollo (stub)', quantity: 500, unit: 'g', notes: '' },
        { name_en: 'Stub rice', name_es: 'Arroz (stub)', quantity: 200, unit: 'g', notes: '' },
      ],
      steps_en: ['Stub cook.', 'Stub serve.'], steps_es: ['Cocinar (stub).', 'Servir (stub).'],
      nutrition: { calories: 400 }, allergens_hint: [], photo_url: null,
      diet_tags: ['High-Protein'],
    };
  }
  if (provider === 'opencode_go') {
    // Owner's OpenCode Go subscription: OpenAI-compatible chat completions.
    // Model verified live at https://opencode.ai/inference/go/v1/models.
    const key = process.env.AI_API_KEY || '';
    const model = process.env.AI_MODEL || 'gemini-4-argon';
    if (!key) throw new Error('ai_not_configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(OPENCODE_GO_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-opencode-session': sessionId,
          'User-Agent': 'NutriChapinaRecipeImport/1.0',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nPage title: ${pageTitle}\n\nPage text:\n${pageText}` }],
        }),
      });
      if (!res.ok) throw new Error(`ai_upstream_${res.status}`);
      const j = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
      const text = j.choices?.[0]?.message?.content || '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('ai bad response');
      return JSON.parse(text.slice(start, end + 1));
    } finally {
      clearTimeout(t);
    }
  }
  if (provider !== 'anthropic') throw new Error('ai_not_configured');
  const key = process.env.AI_API_KEY || '';
  const model = process.env.AI_MODEL || '';
  if (!key || !model) throw new Error('ai_not_configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 2000, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Page title: ${pageTitle}\n\nPage text:\n${pageText}` }],
      }),
    });
    if (!res.ok) throw new Error(`ai_upstream_${res.status}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('ai bad response');
    return JSON.parse(text.slice(start, end + 1));
  } finally {
    clearTimeout(t);
  }
}

// POST /recipe-imports/extract — fetch URL, ask AI, return a DRAFT PROPOSAL.
// Nothing is saved: the editor pre-fills and staff saves via the normal path.
router.post('/recipe-imports/extract', async (req, res) => {
  if (!rateLimit(`ai-import:${req.user!.id}`, aiImportLimit(), 3600_000)) return fail(req, 'locked', 429, res);
  const p = z.object({ url: z.string().min(8).max(2000) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  let pageUrl: URL;
  try {
    pageUrl = new URL(p.data.url);
    await assertPublicUrl(pageUrl);
  } catch {
    return fail(req, 'invalid_input', 422, res);
  }
  // Stub provider (tests): URL shape + SSRF checks run for real, but nothing is
  // downloaded and a fixed fixture stands in for the model.
  if ((process.env.AI_PROVIDER || '') === 'stub') {
    let raw: unknown;
    try {
      raw = await callAi('', '', `ses_import_stub_${req.user!.id}`);
    } catch (e) {
      return aiError(req, res, e);
    }
    const v = proposalSchema.safeParse(sanitizeRaw(raw));
    if (!v.success) { console.error(req.id, 'import_schema', JSON.stringify(v.error.issues.map((i) => i.path.join('.')))); return fail(req, 'invalid_input', 422, res); }
    await audit(req.user!.id, 'recipe_import', pageUrl.toString().slice(0, 200), 'extract_proposal_stub');
    res.json({ data: { proposal: v.data, source_url: pageUrl.toString() }, error: null, request_id: req.id });
    return;
  }
  let page: { buffer: Buffer; finalUrl: string };
  try {
    const dl = await fetchPublic(p.data.url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, expect: expectHtml });
    page = { buffer: dl.buffer, finalUrl: dl.finalUrl };
  } catch (e) {
    const em = (e as Error).message || '';
    if (em.startsWith('fetch_')) return aiError(req, res, e);
    return fail(req, 'invalid_input', 422, res);
  }
  const { title, text, image } = htmlToText(page.buffer.toString('utf8'));
  if (!text) return fail(req, 'invalid_input', 422, res);
  let raw: unknown;
  try {
    raw = await callAi(title, text, `ses_import_${req.user!.id}`);
  } catch (e) {
    return aiError(req, res, e);
  }
  const v = proposalSchema.safeParse(sanitizeRaw(raw));
  if (!v.success) { console.error(req.id, 'import_schema', JSON.stringify(v.error.issues.map((i) => i.path.join('.')))); return fail(req, 'invalid_input', 422, res); }
  const proposal = v.data;
  if (!proposal.photo_url) proposal.photo_url = image && image.startsWith('http') ? image : null;
  await audit(req.user!.id, 'recipe_import', page.finalUrl.slice(0, 200), 'extract_proposal');
  res.json({ data: { proposal, source_url: page.finalUrl }, error: null, request_id: req.id });
});

// Drop junk photo URLs before schema validation (a hallucinated value must not
// sink an otherwise good proposal; files carry no page context for images anyway).
function sanitizeRaw(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.photo_url !== 'string' || !/^https?:\/\//.test(r.photo_url)) r.photo_url = null;
  }
  return raw;
}

// POST /recipe-imports/file — same as extract, but staff uploads a file
// (print-to-PDF, saved page, notes) instead of a URL. Accepted: PDF
// (text-extracted server-side), plain/markdown text, HTML files.
const FILE_MIMES = ['application/pdf', 'text/plain', 'text/markdown', 'text/html'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

router.post('/recipe-imports/file', async (req, res) => {
  if (!rateLimit(`ai-import:${req.user!.id}`, aiImportLimit(), 3600_000)) return fail(req, 'locked', 429, res);
  const p = z.object({
    filename: z.string().min(1).max(120),
    mime: z.string().min(1).max(64),
    data_base64: z.string().min(4).max(7_000_000),
  }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  if (!FILE_MIMES.includes(p.data.mime)) return fail(req, 'invalid_input', 422, res);
  let buf: Buffer;
  try {
    buf = Buffer.from(p.data.data_base64, 'base64');
  } catch {
    return fail(req, 'invalid_input', 422, res);
  }
  if (buf.length === 0 || buf.length > MAX_FILE_BYTES) return fail(req, 'invalid_input', 422, res);
  let text = '';
  try {
    if (p.data.mime === 'application/pdf') {
      if (buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) throw new Error('bad pdf');
      const parsed = (await pdfParse(buf)) as { text?: unknown };
      text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
    } else if (p.data.mime === 'text/html') {
      text = htmlToText(buf.toString('utf8')).text;
    } else {
      text = buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 12000);
    }
  } catch {
    return fail(req, 'invalid_input', 422, res);
  }
  if (!text) {
    res.status(422).json({ data: null, error: { code: 'ai_pdf_empty', message: msg('ai_pdf_empty', req.locale) }, request_id: req.id });
    return;
  }
  let raw: unknown;
  try {
    raw = await callAi(p.data.filename.replace(/\.[a-z0-9]+$/i, '').slice(0, 120), text, `ses_import_file_${req.user!.id}`);
  } catch (e) {
    return aiError(req, res, e);
  }
  const v = proposalSchema.safeParse(sanitizeRaw(raw));
  if (!v.success) { console.error(req.id, 'import_schema', JSON.stringify(v.error.issues.map((i) => i.path.join('.')))); return fail(req, 'invalid_input', 422, res); }
  const proposal = v.data;
  proposal.photo_url = null;
  await audit(req.user!.id, 'recipe_import', p.data.filename.slice(0, 200), 'extract_proposal_file');
  res.json({ data: { proposal, source_url: null }, error: null, request_id: req.id });
});

// POST /recipe-imports/photo — download a page image into our media library and
// attach it to a DRAFT revision. Same guards as staff uploads, server-fetched.
router.post('/recipe-imports/photo', async (req, res) => {
  const p = z.object({ revision_id: z.string().uuid(), url: z.string().min(8).max(2000) }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const rev = await query<{ status: string }>('SELECT status FROM recipe_revisions WHERE id=$1', [p.data.revision_id]);
  if (!rev.rowCount) return fail(req, 'not_found', 404, res);
  if (!['draft', 'changes_requested'].includes(rev.rows[0].status)) return fail(req, 'conflict', 409, res);
  let dl: { buffer: Buffer; contentType: string };
  try {
    dl = await fetchPublic(p.data.url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20000, expect: expectImage });
  } catch (e) {
    const em = (e as Error).message || '';
    if (em.startsWith('fetch_')) return aiError(req, res, e);
    return fail(req, 'invalid_input', 422, res);
  }
  const ct = dl.contentType.toLowerCase();
  const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : null;
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : '';
  if (!ext || !sniffImage(dl.buffer, mime)) return fail(req, 'invalid_input', 422, res);
  const name = `${randomUUID()}.${ext}`;
  try {
    const dir = process.env.UPLOAD_DIR ?? '/srv/uploads';
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), dl.buffer);
  } catch {
    return fail(req, 'server_error', 500, res);
  }
  await query('INSERT INTO recipe_images(revision_id,path,alt,sort) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),-1)+1 FROM recipe_images WHERE revision_id=$1))',
    [p.data.revision_id, `/media/${name}`, '']);
  await audit(req.user!.id, 'recipe_revision', p.data.revision_id, 'image_import');
  res.status(201).json({ data: { path: `/media/${name}`, bytes: dl.buffer.length }, error: null, request_id: req.id });
});

export default router;
