/**
 * client.js
 * DynWorker SDK — HTTP client for the DynWorker REST API.
 *
 * Usage:
 *   import { DynWorker } from 'dynworker';
 *   const dw = new DynWorker({ baseUrl: 'http://localhost:7777' });
 *
 *   // One-shot execution
 *   const result = await dw.execute({ mainModule: 'main.wasm', modules: { 'main.wasm': wasmB64 }, input: { name: 'world' } });
 *
 *   // Persistent worker (cached by ID)
 *   const worker = await dw.get('my-worker', async () => ({
 *     mainModule: 'main.wasm',
 *     modules: { 'main.wasm': wasmB64 },
 *   }));
 *   const result = await worker.run({ name: 'world' });
 */

import { readFile } from 'fs/promises';
import fetch from 'node-fetch';

export class DynWorker {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]  Base URL of the DynWorker API server (default: http://localhost:7777)
   * @param {number} [options.timeout]  Request timeout in ms (default: 30000)
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'http://localhost:7777').replace(/\/$/, '');
    this.timeout = options.timeout || 30_000;
  }

  // ── Core execute ───────────────────────────────────────────────────────────

  /**
   * Execute a WebAssembly worker.
   *
   * @param {ExecuteOptions} opts
   * @returns {Promise<ExecutionResult>}
   */
  async execute(opts) {
    const body = buildExecuteBody(opts);
    return this._post('/v1/execute', body);
  }

  // ── Persistent worker pattern ──────────────────────────────────────────────

  /**
   * Get-or-create a persistent worker by ID.
   * If the worker is not yet registered, the `factory` function is called to
   * produce its definition. Subsequent calls with the same ID reuse the cached
   * worker (no re-upload of wasm bytes needed).
   *
   * This mirrors the Cloudflare Dynamic Workers `get(id, callback)` primitive.
   *
   * @param {string} id           Stable worker ID
   * @param {() => Promise<WorkerDefinition>} factory  Called only on first use
   * @returns {Promise<WorkerHandle>}
   */
  async get(id, factory) {
    // Check if already registered
    try {
      const status = await this._get(`/v1/workers/${encodeURIComponent(id)}`);
      if (status?.stored) {
        return new WorkerHandle(this, id, status.stored);
      }
    } catch {
      // Not found — fall through to register
    }

    // Call factory to get the definition
    const def = await factory();
    const body = buildExecuteBody({ id, ...def });

    // Register without executing
    await this._post('/v1/workers', {
      id,
      main_module:        body.main_module,
      modules:            body.modules,
      entrypoint:         body.entrypoint,
      env:                body.env,
      egress:             body.egress,
      timeout_ms:         body.timeout_ms,
      memory_limit_bytes: body.memory_limit_bytes,
    });

    return new WorkerHandle(this, id, body);
  }

  // ── Worker management ──────────────────────────────────────────────────────

  /** List all workers (engine-cached + stored) */
  async listWorkers() {
    return this._get('/v1/workers');
  }

  /** Get status of a specific worker */
  async getWorker(id) {
    return this._get(`/v1/workers/${encodeURIComponent(id)}`);
  }

  /** Evict a specific worker */
  async evictWorker(id) {
    return this._delete(`/v1/workers/${encodeURIComponent(id)}`);
  }

  /** Evict all workers not used in the last `maxAgeSecs` seconds */
  async evictStale(maxAgeSecs = 3600) {
    return this._post('/v1/workers/evict-stale', { max_age_secs: maxAgeSecs });
  }

  /** Health check */
  async health() {
    return this._get('/v1/health');
  }

  // ── Utility: load wasm file from disk and base64-encode it ─────────────────

  /**
   * Load a .wasm file from disk and return its base64-encoded contents.
   * @param {string} filePath  Absolute or relative path to the .wasm file
   * @returns {Promise<string>}
   */
  static async loadWasm(filePath) {
    const buf = await readFile(filePath);
    return buf.toString('base64');
  }

  // ── Internal HTTP helpers ──────────────────────────────────────────────────

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const json = await res.json();
    if (!res.ok && json.error) throw new DynWorkerError(json.error, res.status);
    return json;
  }

  async _get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (res.status === 404) return null;
    const json = await res.json();
    if (!res.ok && json.error) throw new DynWorkerError(json.error, res.status);
    return json;
  }

  async _delete(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.timeout),
    });
    const json = await res.json();
    if (!res.ok && json.error) throw new DynWorkerError(json.error, res.status);
    return json;
  }
}

// ── WorkerHandle ─────────────────────────────────────────────────────────────

/**
 * A handle to a persistent named worker.
 * Call `.run(input)` to execute it with a new input.
 */
export class WorkerHandle {
  constructor(client, id, definition) {
    this.client = client;
    this.id = id;
    this._definition = definition;
  }

  /**
   * Execute this worker with the given input.
   * @param {*} input  JSON-serialisable input
   * @returns {Promise<ExecutionResult>}
   */
  async run(input = null) {
    return this.client.execute({
      id: this.id,
      mainModule:  this._definition.main_module,
      modules:     this._definition.modules,
      entrypoint:  this._definition.entrypoint,
      env:         this._definition.env,
      egress:      this._definition.egress,
      timeoutMs:   this._definition.timeout_ms,
      memoryLimit: this._definition.memory_limit_bytes,
      input,
    });
  }

  /** Evict this worker from the cache and store */
  async evict() {
    return this.client.evictWorker(this.id);
  }

  /** Get current status of this worker */
  async status() {
    return this.client.getWorker(this.id);
  }
}

// ── Error class ───────────────────────────────────────────────────────────────

export class DynWorkerError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'DynWorkerError';
    this.statusCode = statusCode;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise SDK-style camelCase options to the API's snake_case body.
 */
function buildExecuteBody(opts) {
  return {
    id:                 opts.id ?? undefined,
    main_module:        opts.mainModule,
    modules:            opts.modules,
    entrypoint:         opts.entrypoint ?? '_start',
    input:              opts.input ?? null,
    env:                opts.env ?? {},
    egress:             normaliseEgress(opts.egress),
    timeout_ms:         opts.timeoutMs ?? 0,
    memory_limit_bytes: opts.memoryLimit ?? 0,
  };
}

function normaliseEgress(egress) {
  if (!egress || egress === 'block') return 'block';
  if (egress === 'allow') return 'allow';
  if (egress?.allowList) return { allow_list: egress.allowList };
  if (egress?.blockList) return { block_list: egress.blockList };
  return 'block';
}

/**
 * @typedef {object} ExecuteOptions
 * @property {string}  [id]           Stable worker ID for caching
 * @property {string}  mainModule     Key in `modules` that is the entry point
 * @property {Object.<string,string>} modules  Map of name -> base64 wasm bytes
 * @property {string}  [entrypoint]   Exported function name (default: '_start')
 * @property {*}       [input]        JSON input passed to the worker via stdin
 * @property {Object}  [env]          Environment variables
 * @property {string|object} [egress] Egress policy: 'block'|'allow'|{allowList}|{blockList}
 * @property {number}  [timeoutMs]    Execution timeout in ms (0 = unlimited)
 * @property {number}  [memoryLimit]  Memory limit in bytes (0 = default)
 *
 * @typedef {object} WorkerDefinition
 * @property {string}  mainModule
 * @property {Object.<string,string>} modules
 * @property {string}  [entrypoint]
 * @property {Object}  [env]
 * @property {string|object} [egress]
 * @property {number}  [timeoutMs]
 * @property {number}  [memoryLimit]
 *
 * @typedef {object} ExecutionResult
 * @property {string}  worker_id
 * @property {boolean} cache_hit
 * @property {*}       output
 * @property {string}  stdout
 * @property {string}  stderr
 * @property {number}  duration_ms
 * @property {boolean} success
 * @property {string|null} error
 */
