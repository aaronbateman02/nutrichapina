import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

const app = buildApp();

async function resetDb(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

async function seedUser(email: string, password: string, roles: string[]): Promise<string> {
  const h = await hashPassword(password);
  const u = await pool.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,email_verified_at,locale) VALUES ($1,$2,now(),'en') RETURNING id",
    [email, h],
  );
  const id: string = u.rows[0].id;
  for (const r of roles) await pool.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, r]);
  await pool.query('INSERT INTO client_profiles(user_id,display_name) VALUES ($1,$2)', [id, email]);
  await pool.query('INSERT INTO household_preferences(user_id) VALUES ($1)', [id]);
  return id;
}

async function seedPackage(opts: { price: number | null; status: string; credits?: number; days?: number }): Promise<string> {
  const t = await pool.query<{ id: string }>('INSERT INTO service_packages DEFAULT VALUES RETURNING id');
  const v = await pool.query<{ id: string }>(
    `INSERT INTO package_versions(package_id,locale_data,product_type,duration_days,credit_grant,price_minor,currency,sale_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t.rows[0].id, JSON.stringify({ en: { name: 'M3 Test' } }), 'one_time', opts.days ?? 28, opts.credits ?? 0, opts.price, 'USD', opts.status],
  );
  return v.rows[0].id;
}

let custId = '';

beforeAll(async () => {
  await resetDb();
  await seedUser('m3admin@example.com', 'admin-pass-123', ['administrator']);
  custId = await seedUser('m3cust@example.com', 'cust-pass-123', ['customer']);
  await seedUser('m3support@example.com', 'support-pass-123', ['support']);
  process.env.STRIPE_MODE = 'mock';
});

async function loginAs(email: string, password: string): Promise<ReturnType<typeof request.agent>> {
  const a = request.agent(app);
  const r = await a.post('/api/v1/auth/login').send({ email, password });
  expect(r.status).toBe(200);
  return a;
}

describe('M3 mock checkout + entitlements', () => {
  it('T20 checkout creates mock session and order; unpublished/missing price rejected', async () => {
    const cust = await loginAs('m3cust@example.com', 'cust-pass-123');
    const bad = await cust.post('/api/v1/billing/checkout').send({});
    expect(bad.status).toBe(422);
    const draft = await seedPackage({ price: 1900, status: 'draft' });
    expect((await cust.post('/api/v1/billing/checkout').send({ package_version_id: draft })).status).toBe(404);
    const noprice = await seedPackage({ price: null, status: 'published' });
    expect((await cust.post('/api/v1/billing/checkout').send({ package_version_id: noprice })).status).toBe(422);
    const pub = await seedPackage({ price: 1900, status: 'published' });
    const ok = await cust.post('/api/v1/billing/checkout').send({ package_version_id: pub });
    expect(ok.status).toBe(201);
    expect(ok.body.data.session_id).toMatch(/^mock_cs_/);
    expect(ok.body.data.amount_minor).toBe(1900);
    const orders = await cust.get('/api/v1/billing/orders');
    expect(orders.status).toBe(200);
    expect((orders.body.data as { state: string }[]).some((o) => o.state === 'awaiting_payment')).toBe(true);
    const unauth = await request(app).post('/api/v1/billing/checkout').send({ package_version_id: pub });
    expect(unauth.status).toBe(401);
  });

  it('T21 webhook fulfills once; duplicates grant nothing twice; failures grant nothing', async () => {
    const cust = await loginAs('m3cust@example.com', 'cust-pass-123');
    const pub = await seedPackage({ price: 10900, status: 'published', credits: 6, days: 180 });
    const co = await cust.post('/api/v1/billing/checkout').send({ package_version_id: pub });
    const orderId = co.body.data.order_id as string;
    const sessionId = co.body.data.session_id as string;
    const evt = { id: 'evt_test_001', type: 'checkout.session.completed', data: { object: { id: sessionId, metadata: { order_id: orderId } } } };
    const w1 = await request(app).post('/api/v1/webhooks/stripe').send(evt);
    expect(w1.status).toBe(200);
    expect(w1.body.data.duplicate).toBe(false);
    const count = async (sql: string, ...params: unknown[]): Promise<string> => {
      const r = await pool.query<{ n: string }>(sql, params);
      return r.rows[0].n;
    };
    expect(await count('SELECT COUNT(*) AS n FROM entitlements WHERE client_id=$1 AND kind=$2', custId, 'program_access')).toBe('1');
    expect(await count("SELECT COALESCE(SUM(delta),0)::text AS n FROM credit_ledger_entries WHERE client_id=$1 AND kind='grant'", custId)).toBe('6');
    expect(await count('SELECT COUNT(*) AS n FROM intro_entitlements WHERE client_id=$1', custId)).toBe('1');
    expect(await count('SELECT COUNT(*) AS n FROM invoices WHERE client_id=$1', custId)).toBe('1');
    const o = await pool.query<{ state: string }>('SELECT state FROM orders WHERE id=$1', [orderId]);
    expect(o.rows[0].state).toBe('paid');
    // duplicate delivery: no double grants
    const w2 = await request(app).post('/api/v1/webhooks/stripe').send(evt);
    expect(w2.status).toBe(200);
    expect(w2.body.data.duplicate).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM entitlements WHERE client_id=$1 AND kind=$2', custId, 'program_access')).toBe('1');
    expect(await count("SELECT COALESCE(SUM(delta),0)::text AS n FROM credit_ledger_entries WHERE client_id=$1 AND kind='grant'", custId)).toBe('6');
    // failed payment grants nothing
    const co2 = await cust.post('/api/v1/billing/checkout').send({ package_version_id: pub });
    const order2 = co2.body.data.order_id as string;
    const wf = await request(app).post('/api/v1/webhooks/stripe').send({
      id: 'evt_test_002', type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_x', metadata: { order_id: order2 } } },
    });
    expect(wf.status).toBe(200);
    const o2 = await pool.query<{ state: string }>('SELECT state FROM orders WHERE id=$1', [order2]);
    expect(o2.rows[0].state).toBe('failed');
    expect(await count('SELECT COUNT(*) AS n FROM invoices WHERE client_id=$1', custId)).toBe('1');
  });

  it('T22 refunds default to manual review with no auto-revoke', async () => {
    const admin = await loginAs('m3admin@example.com', 'admin-pass-123');
    const cust = await loginAs('m3cust@example.com', 'cust-pass-123');
    const paid = await pool.query<{ id: string }>("SELECT id FROM orders WHERE client_id=$1 AND state='paid' LIMIT 1", [custId]);
    const orderId = paid.rows[0].id;
    // customer cannot file (admin-only), over-refund rejected
    expect((await cust.post('/api/v1/billing/refunds').send({ order_id: orderId, amount_minor: 100, reason: 'x' })).status).toBe(403);
    expect((await admin.post('/api/v1/billing/refunds').send({ order_id: orderId, amount_minor: 99999999, reason: 'x' })).status).toBe(422);
    const r = await admin.post('/api/v1/billing/refunds').send({ order_id: orderId, amount_minor: 1000, reason: 'changed mind' });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('requested');
    const rid = r.body.data.id as string;
    const no = await admin.post(`/api/v1/billing/refunds/${rid}/decide`).send({ approve: false });
    expect(no.status).toBe(200);
    expect(no.body.data.status).toBe('rejected');
    // decided refunds cannot be re-decided
    expect((await admin.post(`/api/v1/billing/refunds/${rid}/decide`).send({ approve: true })).status).toBe(409);
    // entitlements untouched by the whole flow (manual review = human handles consequences)
    const ent = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM entitlements WHERE client_id=$1', [custId]);
    expect(Number(ent.rows[0].n)).toBeGreaterThan(0);
    const inv = await cust.get('/api/v1/billing/invoices');
    expect(inv.status).toBe(200);
    expect((inv.body.data as unknown[]).length).toBeGreaterThan(0);
  });
});
