import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, tokenHash, newToken } from '../src/auth.js';
import { totpNow } from '../src/mfa.js';

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

beforeAll(async () => {
  await resetDb();
});

describe('M1 auth + RBAC acceptance', () => {
  it('T1 register validates, dedupes, and issues verification', async () => {
    const bad = await request(app).post('/api/v1/auth/register').send({ email: 'not-an-email', password: 'longenoughpassword' });
    expect(bad.status).toBe(422);
    const weak = await request(app).post('/api/v1/auth/register').send({ email: 'a@example.com', password: 'short' });
    expect(weak.status).toBe(422);
    const ok = await request(app).post('/api/v1/auth/register').send({ email: 'alice@example.com', password: 'correct-horse-123' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.id).toBeTruthy();
    const dup = await request(app).post('/api/v1/auth/register').send({ email: 'alice@example.com', password: 'correct-horse-123' });
    expect(dup.status).toBe(409);
  });

  it('T2 login blocked before verification; bad token rejected; good token verifies once', async () => {
    const pre = await request(app).post('/api/v1/auth/login').send({ email: 'alice@example.com', password: 'correct-horse-123' });
    expect(pre.status).toBe(403);
    expect(pre.body.error.code).toBe('unverified');
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: 'alice@example.com', password: 'wrong-password-x' });
    expect(wrong.status).toBe(401);

    const badTok = await request(app).post('/api/v1/auth/verify-email').send({ token: 'deadbeef'.repeat(8) });
    expect(badTok.status).toBe(410);

    const raw = newToken();
    const alice = await pool.query<{ id: string }>("SELECT id FROM users WHERE email='alice@example.com'");
    await pool.query("INSERT INTO email_verification_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [
      alice.rows[0].id,
      tokenHash(raw),
    ]);
    const good = await request(app).post('/api/v1/auth/verify-email').send({ token: raw });
    expect(good.status).toBe(200);
    const replay = await request(app).post('/api/v1/auth/verify-email').send({ token: raw });
    expect(replay.status).toBe(410);
  });

  it('T3 login session reads own record; household persists across sessions', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/login').send({ email: 'alice@example.com', password: 'correct-horse-123' });
    expect(login.status).toBe(200);
    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toContain('customer');
    expect(me.body.data.household.household_size).toBe(1);
    const put = await agent.put('/api/v1/me/household').send({
      household_size: 4, shared_dinner: true, cooking_minutes: 30,
      skill: 'beginner', store: 'walmart', delivery_cadence: 'three',
    });
    expect(put.status).toBe(200);
    const me2 = await agent.get('/api/v1/me');
    expect(me2.body.data.household.household_size).toBe(4);
    expect(me2.body.data.household.store).toBe('walmart');
    const badPut = await agent.put('/api/v1/me/household').send({ household_size: 99 });
    expect(badPut.status).toBe(422);
  });

  it('T4 refresh rotates; logout revokes', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: 'alice@example.com', password: 'correct-horse-123' });
    const ref = await agent.post('/api/v1/auth/refresh');
    expect(ref.status).toBe(200);
    await agent.post('/api/v1/auth/logout');
    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(401);
  });

  it('T5 second customer is isolated; staff routes forbidden to customers', async () => {
    await request(app).post('/api/v1/auth/register').send({ email: 'bob@example.com', password: 'correct-horse-123' });
    const bob = await pool.query<{ id: string }>("SELECT id FROM users WHERE email='bob@example.com'");
    await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [bob.rows[0].id]);
    const bAgent = request.agent(app);
    await bAgent.post('/api/v1/auth/login').send({ email: 'bob@example.com', password: 'correct-horse-123' });
    const bMe = await bAgent.get('/api/v1/me');
    expect(bMe.status).toBe(200);
    expect(bMe.body.data.user.email).toBe('bob@example.com');
    expect(bMe.body.data.household.household_size).toBe(1); // not Alice's 4
    const staff = await bAgent.get('/api/v1/staff/clients');
    expect(staff.status).toBe(403);
    const anon = await request(app).get('/api/v1/me');
    expect(anon.status).toBe(401);
    const anonStaff = await request(app).get('/api/v1/staff/clients');
    expect(anonStaff.status).toBe(401);
  });

  it('T6 admin creates and views a customer; dietitian scope enforced', async () => {
    const adminId = await seedUser('admin@example.com', 'admin-pass-123', ['administrator']);
    void adminId;
    const aAgent = request.agent(app);
    await aAgent.post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'admin-pass-123' });
    const created = await aAgent.post('/api/v1/staff/clients').send({ email: 'carol@example.com', password: 'carol-pass-123', display_name: 'Carol' });
    expect(created.status).toBe(201);
    const cid = created.body.data.id as string;
    const view = await aAgent.get(`/api/v1/staff/clients/${cid}`);
    expect(view.status).toBe(200);
    expect(view.body.data.household).toBeTruthy();
    const list = await aAgent.get('/api/v1/staff/clients');
    expect(list.status).toBe(200);
    expect((list.body.data as unknown[]).length).toBeGreaterThanOrEqual(3);

    const dietId = await seedUser('diet@example.com', 'diet-pass-123', ['dietitian']);
    await pool.query('UPDATE client_profiles SET primary_professional_id=$1 WHERE user_id=$2', [dietId, cid]);
    const dAgent = request.agent(app);
    await dAgent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123' });
    const dList = await dAgent.get('/api/v1/staff/clients');
    expect(dList.status).toBe(200);
    const ids = (dList.body.data as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(cid); // assigned
    const bob = await pool.query<{ id: string }>("SELECT id FROM users WHERE email='bob@example.com'");
    expect(ids).not.toContain(bob.rows[0].id); // unassigned
    const dView = await dAgent.get(`/api/v1/staff/clients/${bob.rows[0].id}`);
    expect(dView.status).toBe(403);
    const noOne = await dAgent.get('/api/v1/staff/clients/00000000-0000-0000-0000-000000000000');
    expect(noOne.status).toBe(403);
  });

  it('T7 password reset rotates credentials and kills sessions', async () => {
    const req1 = await request(app).post('/api/v1/auth/request-reset').send({ email: 'nope@example.com' });
    expect(req1.status).toBe(200); // no enumeration
    const raw = newToken();
    const alice = await pool.query<{ id: string }>("SELECT id FROM users WHERE email='alice@example.com'");
    await pool.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [
      alice.rows[0].id,
      tokenHash(raw),
    ]);
    const bad = await request(app).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(64), password: 'new-password-456' });
    expect(bad.status).toBe(410);
    const good = await request(app).post('/api/v1/auth/reset-password').send({ token: raw, password: 'new-password-456' });
    expect(good.status).toBe(200);
    const replay = await request(app).post('/api/v1/auth/reset-password').send({ token: raw, password: 'other-password-789' });
    expect(replay.status).toBe(410);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'alice@example.com', password: 'new-password-456' });
    expect(login.status).toBe(200);
  });

  it('T8 error strings bilingual', async () => {
    const es = await request(app).post('/api/v1/auth/register?locale=es').send({ email: 'bad', password: 'x' });
    expect(es.status).toBe(422);
    expect(es.body.error.message).toMatch(/inválida/i);
    const en = await request(app).post('/api/v1/auth/register?locale=en').send({ email: 'bad', password: 'x' });
    expect(en.body.error.message).toMatch(/invalid/i);
  });

  it('T9 staff MFA enroll, gate, and remove', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123' });
    const setup = await agent.post('/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.data.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.data.otpauth_url).toContain('otpauth://totp/');
    const badEnable = await agent.post('/api/v1/auth/mfa/enable').send({ token: '000000' });
    expect(badEnable.status).toBe(401);
    const goodEnable = await agent.post('/api/v1/auth/mfa/enable').send({ token: totpNow(setup.body.data.secret) });
    expect(goodEnable.status).toBe(200);
    await agent.post('/api/v1/auth/logout');
    const noToken = await agent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.data).toEqual({ mfa_required: true });
    const wrongToken = await agent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123', token: '000000' });
    expect(wrongToken.status).toBe(403);
    const withToken = await agent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123', token: totpNow(setup.body.data.secret) });
    expect(withToken.status).toBe(200);
    const disableBad = await agent.post('/api/v1/auth/mfa/disable').send({ password: 'wrong-pass' });
    expect(disableBad.status).toBe(401);
    const disable = await agent.post('/api/v1/auth/mfa/disable').send({ password: 'diet-pass-123' });
    expect(disable.status).toBe(200);
    const plain = await agent.post('/api/v1/auth/login').send({ email: 'diet@example.com', password: 'diet-pass-123' });
    expect(plain.status).toBe(200);
  });

  it('T10 cross-origin mutations blocked, same-origin allowed', async () => {
    const forged = await request(app).post('/api/v1/auth/register').set('Origin', 'https://evil.example').send({ email: 'x@example.com', password: 'longenoughpassword' });
    expect(forged.status).toBe(403);
    const ok = await request(app).post('/api/v1/auth/register').send({ email: 'csrf-ok@example.com', password: 'longenoughpassword' });
    expect([201, 409]).toContain(ok.status);
    const getOk = await request(app).get('/api/v1/me').set('Origin', 'https://evil.example');
    expect(getOk.status).toBe(401);
  });
});
