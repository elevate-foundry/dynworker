/**
 * index.js
 * DynWorker API server entry point.
 */

import { buildServer } from './server.js';

const PORT = parseInt(process.env.PORT || '7777', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = await buildServer();

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`DynWorker API listening on http://${HOST}:${PORT}`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
