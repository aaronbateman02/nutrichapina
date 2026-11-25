import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { attachUser } from './auth.js';
import { pickLocale, msg } from './i18n.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import staffRoutes from './routes/staff.js';
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
  app.use(express.json({ limit: '64kb' }));
  app.use((req, _res, next) => {
    req.id = randomUUID();
    req.locale = pickLocale(req.headers['accept-language'], typeof req.query.locale === 'string' ? req.query.locale : undefined);
    next();
  });
  app.use(attachUser);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Admin shell (staging only; prod nginx never routes /admin or /api here).
  app.use('/admin', express.static('public/admin', { index: 'index.html', extensions: ['html'] }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/me', meRoutes);
  app.use('/api/v1/staff', staffRoutes);
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
