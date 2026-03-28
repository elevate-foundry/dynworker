/**
 * api/tests/server.test.js
 *
 * Unit tests for the DynWorker API server.
 * Uses a mock engine so no Rust binary is required.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { WorkerStore } from '../src/store.js';

// ── Mock engine ───────────────────────────────────────────────────────────────

class MockEngine {
  constructor() {
    this._dead = false;
    this._workers = new Map();
    this._callCount = 0;
  }

  async start() {}
  stop() {}

  async execute(req) {
    this._callCount++;
    const id = req.id || `anon-${this._callCount}`;
    const existing = this._workers.has(id);
    if (req.id) this._workers.set(id, req);
    return {
      worker_id: id,
      cache_hit: existing,
      output: { echo: req.input },
      stdout: JSON.stringify({ echo: req.input }) + '\n',
      stderr: '',
      duration_ms: 1,
      success: true,
      error: null,
    };
  }

  async listWorkers() {
    return Array.from(this._workers.entries()).map(([id, w]) => ({
      id,
      main_module: w.main_module,
      created_at: 0,
      last_used_at: 0,
      invocation_count: 1,
    }));
  }

  async getWorker(id) {
    const w = this._workers.get(id);
    if (!w) return null;
    return { id, main_module: w.main_module, created_at: 0, last_used_at: 0, invocation_count: 1 };
  }

  async evictWorker(id) {
    return this._workers.delete(id);
  }

  async evictStale(_maxAge) {
    return 0;
  }
}

// ── In-memory store ───────────────────────────────────────────────────────────

class MemoryStore extends WorkerStore {
  constructor() {
    super('/tmp/dynworker-test-store.json');
  }
  async load() {}
  async flush() {}
  async warmUp() {}
}

// ── Test setup ────────────────────────────────────────────────────────────────

let app;
let engine;

before(async () => {
  engine = new MockEngine();
  const store = new MemoryStore();
  app = await buildServer({ engine, store, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /v1/health', () => {
  test('returns status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.engine, 'running');
  });
});

describe('POST /v1/execute', () => {
  test('executes a one-shot worker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        main_module: 'main.wasm',
        modules: { 'main.wasm': 'AAAA' },
        input: { hello: 'world' },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.deepEqual(body.output, { echo: { hello: 'world' } });
  });

  test('executes a persistent worker and returns cache hit on second call', async () => {
    const payload = {
      id: 'test-persistent',
      main_module: 'main.wasm',
      modules: { 'main.wasm': 'AAAA' },
      input: { x: 1 },
    };

    const res1 = await app.inject({ method: 'POST', url: '/v1/execute', payload });
    assert.equal(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.cache_hit, false);

    const res2 = await app.inject({ method: 'POST', url: '/v1/execute', payload: { ...payload, input: { x: 2 } } });
    assert.equal(res2.statusCode, 200);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.cache_hit, true);
  });

  test('returns 422 for failed worker execution', async () => {
    // Override engine to simulate failure
    const origExecute = engine.execute.bind(engine);
    engine.execute = async () => ({
      worker_id: 'fail-worker',
      cache_hit: false,
      output: null,
      stdout: '',
      stderr: 'error: something went wrong',
      duration_ms: 1,
      success: false,
      error: 'something went wrong',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { main_module: 'bad.wasm', modules: { 'bad.wasm': 'AAAA' } },
    });
    assert.equal(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);

    engine.execute = origExecute;
  });
});

describe('POST /v1/workers', () => {
  test('registers a named worker without executing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workers',
      payload: {
        id: 'my-worker',
        main_module: 'main.wasm',
        modules: { 'main.wasm': 'AAAA' },
      },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.id, 'my-worker');
    assert.equal(body.registered, true);
  });
});

describe('GET /v1/workers', () => {
  test('lists workers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/workers' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.engine_workers));
    assert.ok(Array.isArray(body.stored_workers));
  });
});

describe('DELETE /v1/workers/:id', () => {
  test('evicts an existing worker', async () => {
    // First register it
    await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { id: 'to-evict', main_module: 'main.wasm', modules: { 'main.wasm': 'AAAA' } },
    });

    const res = await app.inject({ method: 'DELETE', url: '/v1/workers/to-evict' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.evicted, true);
  });

  test('returns 404 for unknown worker', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/workers/does-not-exist' });
    assert.equal(res.statusCode, 404);
  });
});
