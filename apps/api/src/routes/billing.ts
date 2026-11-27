import { Router } from 'express';
import { z } from 'zod';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';
import { msg } from '../i18n.js';
import { requireAuth, requireRole, audit, rateLimit } from '../auth.js';

// M3 mock-first billing. STRIPE_MODE=mock (default) simulates Checkout + webhooks
// with zero money movement; swapping the real key in later is config-only and the
// fulfillment path (idempotent grants) is identical in both modes.
type BillMode = 'mock' | 'test' | 'live';
function billMode(): BillMode {
  const m = (process.env.STRIPE_MODE || 'mock').toLowerCase();
  return m === 'test' || m === 'live' ? m : 'mock';
}

const fail = (req: { locale: 'en' | 'es' }, code: string, status: number, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(status).json({ data: null, error: { code, message: msg(code, req.locale) }, request_id: (req as unknown as { id: string }).id });

async function getOrCreateCustomer(clientId: string): Promise<string> {
  const cur = await query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM stripe_customers WHERE client_id=$1', [clientId]);
  if (cur.rowCount) return cur.rows[0].stripe_customer_id;
  const id = `mock_cus_${clientId.replace(/-/g, '').slice(0, 12)}`;
  await query('INSERT INTO stripe_customers(client_id,stripe_customer_id) VALUES ($1,$2) ON CONFLICT (client_id) DO NOTHING', [clientId, id]);
  return (await query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM stripe_customers WHERE client_id=$1', [clientId])).rows[0].stripe_customer_id;
}

async function fulfillOrder(orderId: string): Promise<void> {
  const o = await query<{ id: string; client_id: string; package_version_id: string | null; state: string; total_minor: number; currency: string }>(
    'SELECT id,client_id,package_version_id,state,total_minor,currency FROM orders WHERE id=$1', [orderId]);
  if (!o.rowCount || o.rows[0].state === 'paid') return;
  const order = o.rows[0];
  const pv = order.package_version_id
    ? (await query<{ duration_days: number | null; credit_grant: number }>('SELECT duration_days,credit_grant FROM package_versions WHERE id=$1', [order.package_version_id])).rows[0]
    : null;
  await query("UPDATE orders SET state='paid' WHERE id=$1", [orderId]);
  await query(
    `INSERT INTO entitlements(client_id,kind,source_order_id,valid_from,valid_to)
     VALUES ($1,'program_access',$2,now(),now() + make_interval(days => $3::int))
     ON CONFLICT (client_id,kind,source_order_id) DO NOTHING`,
    [order.client_id, orderId, pv?.duration_days ?? null],
  );
  if ((pv?.credit_grant ?? 0) > 0) {
    await query('INSERT INTO credit_grants(client_id,source,amount,policy_snapshot) VALUES ($1,$2,$3,$4)',
      [order.client_id, `order:${orderId}`, pv!.credit_grant, JSON.stringify({ minutes_per_credit: 30 })]);
    await query('INSERT INTO credit_ledger_entries(client_id,delta,kind,idempotency_key) VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING',
      [order.client_id, pv!.credit_grant, 'grant', `order:${orderId}:credits`]);
  }
  const hasIntro = await query('SELECT 1 FROM intro_entitlements WHERE client_id=$1 LIMIT 1', [order.client_id]);
  if (!hasIntro.rowCount) await query('INSERT INTO intro_entitlements(client_id) VALUES ($1)', [order.client_id]);
  await query('INSERT INTO invoices(order_id,client_id,amount_minor,currency,status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [orderId, order.client_id, order.total_minor, order.currency, 'paid']);
  await audit(order.client_id, 'order', orderId, 'fulfilled');
}

export const billingRouter = Router();

billingRouter.post('/billing/checkout', requireAuth, async (req, res) => {
  if (!rateLimit(`billing:${req.user!.id}`, 20, 3600_000)) return fail(req, 'locked', 429, res);
  const p = z.object({ package_version_id: z.string().uuid() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const pv = await query<{ id: string; price_minor: number | null; currency: string; product_type: string; sale_status: string }>(
    'SELECT id,price_minor,currency,product_type,sale_status FROM package_versions WHERE id=$1', [p.data.package_version_id]);
  if (!pv.rowCount || pv.rows[0].sale_status !== 'published') return fail(req, 'not_found', 404, res);
  if (pv.rows[0].price_minor == null) return fail(req, 'invalid_input', 422, res);
  const mode = billMode();
  if (mode !== 'mock') return fail(req, 'billing_unavailable', 501, res);
  const customerId = await getOrCreateCustomer(req.user!.id);
  const sessionId = `mock_cs_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const order = await query<{ id: string }>(
    "INSERT INTO orders(client_id,package_version_id,state,total_minor,currency,stripe_checkout_session_id) VALUES ($1,$2,'awaiting_payment',$3,$4,$5) RETURNING id",
    [req.user!.id, p.data.package_version_id, pv.rows[0].price_minor, pv.rows[0].currency, sessionId],
  );
  await query('INSERT INTO stripe_price_mappings(package_version_id,stripe_price_id,stripe_product_id,mode) VALUES ($1,$2,$3,$4) ON CONFLICT (package_version_id) DO NOTHING',
    [p.data.package_version_id, `mock_price_${sessionId.slice(-8)}`, `mock_prod_${sessionId.slice(-8)}`, 'mock']);
  await audit(req.user!.id, 'order', order.rows[0].id, `checkout_create ${customerId}`);
  res.status(201).json({
    data: { order_id: order.rows[0].id, session_id: sessionId, url: `mock://checkout/${sessionId}`, amount_minor: pv.rows[0].price_minor, currency: pv.rows[0].currency, mode },
    error: null, request_id: req.id,
  });
});

billingRouter.get('/billing/orders', requireAuth, async (req, res) => {
  const r = await query('SELECT id,package_version_id,state,total_minor,currency,stripe_checkout_session_id,created_at FROM orders WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user!.id]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

billingRouter.get('/billing/invoices', requireAuth, async (req, res) => {
  const r = await query('SELECT id,order_id,amount_minor,currency,status,created_at FROM invoices WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user!.id]);
  res.json({ data: r.rows, error: null, request_id: req.id });
});

// Refunds default to manual owner review (D07): records only, never auto-revoke.
billingRouter.post('/billing/refunds', async (req, res) => {
  if (!req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const p = z.object({ order_id: z.string().uuid(), amount_minor: z.number().int().positive(), reason: z.string().max(500).default('') }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const o = await query<{ id: string; client_id: string; state: string; total_minor: number }>('SELECT id,client_id,state,total_minor FROM orders WHERE id=$1', [p.data.order_id]);
  if (!o.rowCount || o.rows[0].state !== 'paid') return fail(req, 'invalid_input', 422, res);
  const prior = await query<{ s: string }>("SELECT COALESCE(SUM(amount_minor),0)::text AS s FROM refunds WHERE order_id=$1 AND status IN ('requested','approved','succeeded')", [p.data.order_id]);
  if (Number(prior.rows[0].s) + p.data.amount_minor > (o.rows[0].total_minor ?? 0)) return fail(req, 'invalid_input', 422, res);
  const r = await query<{ id: string }>('INSERT INTO refunds(order_id,client_id,amount_minor,reason,status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [p.data.order_id, o.rows[0].client_id, p.data.amount_minor, p.data.reason, 'requested']);
  await audit(req.user!.id, 'refund', r.rows[0].id, `requested ${p.data.amount_minor}`);
  res.status(201).json({ data: { id: r.rows[0].id, status: 'requested' }, error: null, request_id: req.id });
});

billingRouter.post('/billing/refunds/:id/decide', async (req, res) => {
  if (!req.user!.roles.includes('administrator')) return fail(req, 'forbidden', 403, res);
  const p = z.object({ approve: z.boolean() }).safeParse(req.body);
  if (!p.success) return fail(req, 'invalid_input', 422, res);
  const cur = await query<{ status: string }>('SELECT status FROM refunds WHERE id=$1', [req.params.id]);
  if (!cur.rowCount) return fail(req, 'not_found', 404, res);
  if (cur.rows[0].status !== 'requested') return fail(req, 'conflict', 409, res);
  const next = p.data.approve ? 'approved' : 'rejected';
  await query('UPDATE refunds SET status=$1,decided_by=$2 WHERE id=$3', [next, req.user!.id, req.params.id]);
  await audit(req.user!.id, 'refund', req.params.id, next);
  res.json({ data: { ok: true, status: next }, error: null, request_id: req.id });
});

function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((s) => s.trim().split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  try {
    const expected = createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
    return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}

export const webhookRouter = Router();

webhookRouter.post('/webhooks/stripe', async (req, res) => {
  const mode = billMode();
  let evt: { id: string; type: string; data?: { object?: Record<string, unknown> } };
  if (mode === 'mock') {
    const p = z.object({ id: z.string().min(1).max(120), type: z.string().min(1).max(120), data: z.object({ object: z.record(z.string(), z.unknown()) }).optional() }).safeParse(req.body);
    if (!p.success) return fail(req, 'invalid_input', 422, res);
    evt = { id: p.data.id, type: p.data.type, data: p.data.data as { object: Record<string, unknown> } | undefined };
  } else {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sigHeader = req.headers['stripe-signature'];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!secret || !verifyStripeSignature(raw, sig, secret)) {
      res.status(400).json({ data: null, error: { code: 'invalid_input', message: msg('invalid_input', req.locale) }, request_id: req.id });
      return;
    }
    try {
      evt = JSON.parse(raw.toString('utf8')) as typeof evt;
    } catch {
      return fail(req, 'invalid_input', 422, res);
    }
    if (!evt?.id || !evt?.type) return fail(req, 'invalid_input', 422, res);
  }
  const ins = await query('INSERT INTO payment_events(stripe_event_id,type,status) VALUES ($1,$2,$3) ON CONFLICT (stripe_event_id) DO NOTHING RETURNING stripe_event_id',
    [evt.id, evt.type, 'received']);
  if (!ins.rowCount) {
    res.json({ data: { received: true, duplicate: true }, error: null, request_id: req.id });
    return;
  }
  try {
    const obj = evt.data?.object ?? {};
    if (evt.type === 'checkout.session.completed') {
      const orderId = obj.metadata && typeof obj.metadata === 'object'
        ? (obj.metadata as Record<string, unknown>).order_id as string | undefined
        : undefined;
      const sessionId = obj.id as string | undefined;
      const order = orderId
        ? await query<{ id: string }>('SELECT id FROM orders WHERE id=$1', [orderId])
        : await query<{ id: string }>('SELECT id FROM orders WHERE stripe_checkout_session_id=$1', [sessionId ?? '']);
      if (order.rowCount) {
        await fulfillOrder(order.rows[0].id);
        await query("UPDATE payment_events SET status='processed',processed_at=now(),order_id=$2 WHERE stripe_event_id=$1", [evt.id, order.rows[0].id]);
      } else {
        await query("UPDATE payment_events SET status='failed',processed_at=now() WHERE stripe_event_id=$1", [evt.id]);
      }
    } else if (evt.type === 'checkout.session.expired' || evt.type === 'payment_intent.payment_failed' || evt.type === 'charge.failed') {
      const objId = obj.id as string | undefined;
      const meta = obj.metadata as Record<string, unknown> | undefined;
      const order = meta?.order_id
        ? await query<{ id: string }>('SELECT id FROM orders WHERE id=$1', [meta.order_id as string])
        : await query<{ id: string }>('SELECT id FROM orders WHERE stripe_checkout_session_id=$1', [objId ?? '']);
      if (order.rowCount) {
        await query("UPDATE orders SET state='failed',failure_code=$2 WHERE id=$1 AND state='awaiting_payment'", [order.rows[0].id, evt.type]);
        await query("UPDATE payment_events SET status='processed',processed_at=now(),order_id=$2 WHERE stripe_event_id=$1", [evt.id, order.rows[0].id]);
      } else {
        await query("UPDATE payment_events SET status='failed',processed_at=now() WHERE stripe_event_id=$1", [evt.id]);
      }
    } else {
      await query("UPDATE payment_events SET status='processed',processed_at=now() WHERE stripe_event_id=$1", [evt.id]);
    }
  } catch {
    await query("UPDATE payment_events SET status='failed',processed_at=now() WHERE stripe_event_id=$1", [evt.id]);
  }
  res.json({ data: { received: true, duplicate: false }, error: null, request_id: req.id });
});
