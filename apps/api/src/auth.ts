import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { query } from './db.js';
import { msg } from './i18n.js';

export type Role = 'customer' | 'dietitian' | 'administrator' | 'support';
export interface SessionUser { id: string; roles: Role[] }

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
const ACCESS_TTL = '15m';

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}
export async function checkPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
export function tokenHash(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}
export function signAccess(u: SessionUser): string {
  return jwt.sign({ sub: u.id, roles: u.roles }, JWT_SECRET as string, { expiresIn: ACCESS_TTL });
}
export function verifyAccess(token: string): SessionUser | null {
  try {
    const p = jwt.verify(token, JWT_SECRET as string) as { sub: string; roles: Role[] };
    if (!p?.sub || !Array.isArray(p.roles)) return null;
    return { id: p.sub, roles: p.roles };
  } catch {
    return null;
  }
}

const ACCESS_COOKIE = 'nc_at';
const REFRESH_COOKIE = 'nc_rt';
const secure = process.env.COOKIE_SECURE !== 'false';

export function setAuthCookies(res: Response, access: string, refresh: string): void {
  res.cookie(ACCESS_COOKIE, access, { httpOnly: true, secure, sameSite: 'lax', maxAge: 15 * 60 * 1000, path: '/' });
  res.cookie(REFRESH_COOKIE, refresh, { httpOnly: true, secure, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, path: '/api/v1/auth' });
}
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
}
export function readCookies(req: Request): { access?: string; refresh?: string } {
  const c = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
  return { access: c[ACCESS_COOKIE], refresh: c[REFRESH_COOKIE] };
}

declare global {
  namespace Express {
    interface Request { user?: SessionUser }
  }
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const { access } = readCookies(req);
  const header = req.headers.authorization;
  const token = access ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (token) {
    const u = verifyAccess(token);
    if (u) req.user = u;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'unauthorized', message: msg('unauthorized', req.locale) }, request_id: req.id });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ data: null, error: { code: 'unauthorized', message: msg('unauthorized', req.locale) }, request_id: req.id });
      return;
    }
    if (!req.user.roles.some((r) => roles.includes(r))) {
      res.status(403).json({ data: null, error: { code: 'forbidden', message: msg('forbidden', req.locale) }, request_id: req.id });
      return;
    }
    next();
  };
}

export async function audit(actorId: string | null, entityType: string, entityId: string, action: string): Promise<void> {
  await query('INSERT INTO audit_events(actor_id, entity_type, entity_id, action) VALUES ($1,$2,$3,$4)', [actorId, entityType, entityId, action]);
}

// Naive in-memory rate limiter (single instance, staging scale). Replace with
// shared store before horizontal scaling.
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  h.n += 1;
  return h.n <= max;
}
