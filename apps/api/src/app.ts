import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { attachUser } from './auth.js';
import { pickLocale, msg } from './i18n.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import staffRoutes from './routes/staff.js';
import catalogRoutes from './routes/catalog.js';
import programRoutes from './routes/programs.js';
import importRoutes from './routes/imports.js';
import { billingRouter, webhookRouter } from './routes/billing.js';
import debugRoutes from './routes/debug.js';

declare global {
  namespace Express {
    interface Request { id: string; locale: 'en' | 'es' }
  }
}

export function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cookieParser());
  // Import/upload routes accept file payloads (base64); scoped here so the
  // tight 64kb default still protects auth and form endpoints. body-parser
  // skips re-parsing (req._body) when the global parser runs after these.
  app.use('/api/v1/staff/recipe-imports/file', express.json({ limit: '8mb' }));
  app.use('/api/v1/staff/uploads', express.json({ limit: '4mb' }));
  // Webhook keeps raw bytes for signature verification (real Stripe mode).
  app.use('/api/v1/webhooks/stripe', express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
  app.use(express.json({ limit: '64kb' }));
  app.use((req, _res, next) => {
    req.id = randomUUID();
    req.locale = pickLocale(req.headers['accept-language'], typeof req.query.locale === 'string' ? req.query.locale : undefined);
    next();
  });
  app.use(attachUser);

  // CSRF: mutations require same-origin. Browsers always send Origin/Referer on
  // fetch POST; missing headers (curl, tests, same-origin navigations) are allowed.
  // SameSite=Lax cookies + no cross-origin API access complete the posture.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const host = req.headers.host;
    const sameSite = (v: string | undefined): boolean => {
      if (!v) return true;
      try {
        return new URL(v).host === host;
      } catch {
        return false;
      }
    };
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!sameSite(origin) || (!origin && !sameSite(referer))) {
      res.status(403).json({ data: null, error: { code: 'forbidden', message: msg('forbidden', req.locale) }, request_id: req.id });
      return;
    }
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Admin shell (staging only; prod nginx never routes /admin or /api here).
  app.use('/admin', express.static('public/admin', { index: 'index.html', extensions: ['html'] }));
  // Recipe photos uploaded by staff. Approved images are public content;
  // per-record access control for sensitive media arrives with later modules.
  app.use('/media', express.static(process.env.UPLOAD_DIR ?? '/srv/uploads', { index: false, maxAge: '7d' }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/me', meRoutes);
  app.use('/api/v1/staff', staffRoutes);
  app.use('/api/v1/staff', catalogRoutes);
  app.use('/api/v1/staff', programRoutes);
  app.use('/api/v1/staff', importRoutes);
  app.use('/api/v1', billingRouter);
  app.use('/api/v1', webhookRouter);
  if (process.env.ALLOW_DEBUG_OUTBOX === 'true') app.use('/api/v1/_debug', debugRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ data: null, error: { code: 'not_found', message: msg('not_found', req.locale) }, request_id: req.id });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Never log request bodies: they may contain credentials on parse failure.
    const e = err as { status?: number; message?: string };
    console.error(req.id, e?.status ?? 500, e?.message ?? 'error');
    res.status(500).json({ data: null, error: { code: 'server_error', message: msg('server_error', req.locale) }, request_id: req.id });
  });
  return app;
}
