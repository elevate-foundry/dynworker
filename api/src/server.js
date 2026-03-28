/**
 * server.js
 * DynWorker REST API server built on Fastify.
 *
 * Routes:
 *   POST   /v1/execute              - Execute a worker (one-shot or persistent)
 *   POST   /v1/workers              - Register a named worker definition
 *   GET    /v1/workers              - List all cached/registered workers
 *   GET    /v1/workers/:id          - Get status of a specific worker
 *   DELETE /v1/workers/:id          - Evict a specific worker
 *   POST   /v1/workers/evict-stale  - Evict all stale workers
 *   GET    /v1/health               - Health check
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EngineProcess } from './engine.js';
import { WorkerStore } from './store.js';

export async function buildServer(options = {}) {
  const engine = options.engine || new EngineProcess(options.engineOptions || {});
  const store  = options.store  || new WorkerStore(options.storePath);

  const app = Fastify({
    logger: options.logger !== false
      ? {
          level: process.env.LOG_LEVEL || 'info',
          transport: process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        }
      : false,
  });

  await app.register(cors, { origin: true });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/v1/health', async () => ({
    status: 'ok',
    engine: !engine._dead ? 'running' : 'dead',
    stored_workers: store.workers.size,
  }));

  // ── Execute ────────────────────────────────────────────────────────────────
  /**
   * Execute a worker.
   *
   * If `id` is provided:
   *   - If the worker is registered in the store, its template is merged with
   *     the incoming `input` and executed (cache hit path).
   *   - If not yet registered, the full definition is stored and executed.
   * If no `id`, a one-shot anonymous worker is executed.
   */
  app.post('/v1/execute', {
    schema: {
      body: {
        type: 'object',
        required: ['main_module', 'modules'],
        properties: {
          id:                  { type: 'string' },
          main_module:         { type: 'string' },
          modules:             { type: 'object', additionalProperties: { type: 'string' } },
          entrypoint:          { type: 'string', default: '_start' },
          input:               {},
          env:                 { type: 'object', additionalProperties: { type: 'string' } },
          egress:              { default: 'block' },
          timeout_ms:          { type: 'integer', minimum: 0, default: 0 },
          memory_limit_bytes:  { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const egress = normaliseEgress(body.egress);

    const loadRequest = {
      id:                 body.id ?? null,
      main_module:        body.main_module,
      modules:            body.modules,
      entrypoint:         body.entrypoint ?? '_start',
      input:              body.input ?? null,
      env:                body.env ?? {},
      egress,
      timeout_ms:         body.timeout_ms ?? 0,
      memory_limit_bytes: body.memory_limit_bytes ?? 0,
    };

    // Persist named workers
    if (body.id) {
      store.set(body.id, loadRequest);
    }

    try {
      const result = await engine.execute(loadRequest);
      return reply.code(result.success ? 200 : 422).send(result);
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Register a named worker (without executing) ────────────────────────────
  app.post('/v1/workers', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'main_module', 'modules'],
        properties: {
          id:                 { type: 'string' },
          main_module:        { type: 'string' },
          modules:            { type: 'object', additionalProperties: { type: 'string' } },
          entrypoint:         { type: 'string', default: '_start' },
          env:                { type: 'object', additionalProperties: { type: 'string' } },
          egress:             { default: 'block' },
          timeout_ms:         { type: 'integer', minimum: 0, default: 0 },
          memory_limit_bytes: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const egress = normaliseEgress(body.egress);

    const template = {
      id:                 body.id,
      main_module:        body.main_module,
      modules:            body.modules,
      entrypoint:         body.entrypoint ?? '_start',
      input:              null,
      env:                body.env ?? {},
      egress,
      timeout_ms:         body.timeout_ms ?? 0,
      memory_limit_bytes: body.memory_limit_bytes ?? 0,
    };

    store.set(body.id, template);
    return reply.code(201).send({ id: body.id, registered: true });
  });

  // ── Worker registry ────────────────────────────────────────────────────────
  app.get('/v1/workers', async (request, reply) => {
    try {
      const [engineWorkers, storedWorkers] = await Promise.all([
        engine.listWorkers(),
        Promise.resolve(store.list()),
      ]);
      return { engine_workers: engineWorkers, stored_workers: storedWorkers };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get('/v1/workers/:id', async (request, reply) => {
    try {
      const [engineStatus, storedDef] = await Promise.all([
        engine.getWorker(request.params.id),
        Promise.resolve(store.get(request.params.id)),
      ]);
      if (!engineStatus && !storedDef) {
        return reply.code(404).send({ error: 'Worker not found' });
      }
      return { engine: engineStatus, stored: storedDef };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.delete('/v1/workers/:id', async (request, reply) => {
    try {
      const [evicted, deleted] = await Promise.all([
        engine.evictWorker(request.params.id),
        Promise.resolve(store.delete(request.params.id)),
      ]);
      if (!evicted && !deleted) {
        return reply.code(404).send({ error: 'Worker not found' });
      }
      return { evicted: true };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post('/v1/workers/evict-stale', {
    schema: {
      body: {
        type: 'object',
        properties: {
          max_age_secs: { type: 'integer', minimum: 1, default: 3600 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const count = await engine.evictStale(request.body?.max_age_secs ?? 3600);
      return { evicted_count: count };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Lifecycle hooks ────────────────────────────────────────────────────────
  app.addHook('onReady', async () => {
    await store.load();
    await engine.start();
    await store.warmUp(engine);
    app.log.info('DynWorker engine started and store warmed up');
  });

  app.addHook('onClose', async () => {
    await store.flush();
    engine.stop();
  });

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseEgress(egress) {
  if (!egress || egress === 'block') return 'block';
  if (egress === 'allow') return 'allow';
  if (egress?.allow_list) return { allow_list: egress.allow_list };
  if (egress?.block_list) return { block_list: egress.block_list };
  return 'block';
}
