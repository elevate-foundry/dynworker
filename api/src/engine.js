/**
 * engine.js
 * Manages the Rust dynworker-engine child process.
 * Communicates via newline-delimited JSON over stdin/stdout (IPC protocol).
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default path to the compiled Rust engine binary
const DEFAULT_ENGINE_BIN = path.resolve(
  __dirname,
  '../../engine/target/release/dynworker-engine'
);

export class EngineProcess {
  constructor(options = {}) {
    this.binPath = options.binPath || process.env.DYNWORKER_ENGINE_BIN || DEFAULT_ENGINE_BIN;
    this.proc = null;
    this.rl = null;
    this.pending = new Map(); // req_id -> { resolve, reject, timer }
    this.requestTimeout = options.requestTimeout || 30_000; // ms
    this._started = false;
    this._dead = false;
  }

  /** Start the engine process */
  async start() {
    if (this._started) return;
    this._started = true;

    this.proc = spawn(this.binPath, [], {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin/stdout piped, stderr inherited
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'info' },
    });

    this.proc.on('error', (err) => {
      console.error('[engine] Failed to start engine process:', err.message);
      this._rejectAll(err);
      this._dead = true;
    });

    this.proc.on('exit', (code, signal) => {
      console.error(`[engine] Engine process exited (code=${code}, signal=${signal})`);
      this._rejectAll(new Error(`Engine process exited unexpectedly (code=${code})`));
      this._dead = true;
    });

    // Read newline-delimited JSON responses from engine stdout
    this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._handleResponse(line));

    // Verify the engine is alive with a ping
    await this._ping();
  }

  /** Stop the engine process */
  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
    }
  }

  /** Send a request to the engine and await its response */
  async send(type, payload = {}) {
    if (this._dead) throw new Error('Engine process is not running');

    const req_id = randomUUID();
    const request = JSON.stringify({ type, req_id, ...payload });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Engine request timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      this.pending.set(req_id, { resolve, reject, timer });
      this.proc.stdin.write(request + '\n');
    });
  }

  // ── Typed request helpers ──────────────────────────────────────────────────

  async execute(loadRequest) {
    const resp = await this.send('execute', { payload: loadRequest });
    if (resp.type === 'execute_result') return resp.result;
    throw new Error(resp.message || 'Unknown engine error');
  }

  async listWorkers() {
    const resp = await this.send('list_workers');
    if (resp.type === 'worker_list') return resp.workers;
    throw new Error(resp.message || 'Unknown engine error');
  }

  async getWorker(worker_id) {
    const resp = await this.send('get_worker', { worker_id });
    if (resp.type === 'worker_info') return resp.worker;
    throw new Error(resp.message || 'Unknown engine error');
  }

  async evictWorker(worker_id) {
    const resp = await this.send('evict_worker', { worker_id });
    if (resp.type === 'evict_result') return resp.evicted;
    throw new Error(resp.message || 'Unknown engine error');
  }

  async evictStale(max_age_secs) {
    const resp = await this.send('evict_stale', { max_age_secs });
    if (resp.type === 'evict_stale_result') return resp.count;
    throw new Error(resp.message || 'Unknown engine error');
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _handleResponse(line) {
    let resp;
    try {
      resp = JSON.parse(line);
    } catch {
      console.error('[engine] Failed to parse response:', line);
      return;
    }

    const entry = this.pending.get(resp.req_id);
    if (!entry) {
      console.warn('[engine] Received response for unknown req_id:', resp.req_id);
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(resp.req_id);

    if (resp.type === 'error') {
      entry.reject(new Error(resp.message));
    } else {
      entry.resolve(resp);
    }
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  async _ping() {
    const resp = await this.send('ping');
    if (resp.type !== 'pong') throw new Error('Engine ping failed');
  }
}
