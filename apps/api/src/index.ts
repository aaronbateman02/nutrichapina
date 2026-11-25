import { buildApp } from './app.js';
import { pool } from './db.js';

const port = Number(process.env.PORT ?? 8080);
const app = buildApp();
const server = app.listen(port, () => console.log(`api listening on ${port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}
