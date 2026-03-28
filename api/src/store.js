/**
 * store.js
 * Durable worker definition store.
 *
 * Persists named worker definitions (id + LoadRequest template) to a JSON file
 * so they survive server restarts. On startup, all stored workers are
 * re-registered with the engine.
 *
 * This is the "persistence as a primitive" layer.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DEFAULT_STORE_PATH = process.env.DYNWORKER_STORE_PATH
  || path.resolve(process.cwd(), '.dynworker', 'workers.json');

export class WorkerStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    /** @type {Map<string, object>} id -> LoadRequest template */
    this.workers = new Map();
    this._dirty = false;
    this._flushTimer = null;
  }

  /** Load persisted workers from disk */
  async load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = await readFile(this.storePath, 'utf8');
      const data = JSON.parse(raw);
      for (const [id, def] of Object.entries(data)) {
        this.workers.set(id, def);
      }
      console.log(`[store] Loaded ${this.workers.size} worker(s) from ${this.storePath}`);
    } catch (err) {
      console.warn(`[store] Could not load worker store: ${err.message}`);
    }
  }

  /** Flush workers to disk (debounced) */
  async flush() {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const data = Object.fromEntries(this.workers.entries());
    await writeFile(this.storePath, JSON.stringify(data, null, 2), 'utf8');
    this._dirty = false;
  }

  /** Schedule a debounced flush */
  _scheduledFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this.flush().catch(console.error), 500);
  }

  /** Register or update a named worker definition */
  set(id, loadRequestTemplate) {
    // Strip the per-call input field before storing the template
    const template = { ...loadRequestTemplate, input: null };
    this.workers.set(id, template);
    this._scheduledFlush();
  }

  /** Get a stored worker template by ID */
  get(id) {
    return this.workers.get(id) || null;
  }

  /** Check if a worker ID is registered */
  has(id) {
    return this.workers.has(id);
  }

  /** Delete a worker definition */
  delete(id) {
    const existed = this.workers.delete(id);
    if (existed) this._scheduledFlush();
    return existed;
  }

  /** List all stored worker IDs and their metadata */
  list() {
    return Array.from(this.workers.entries()).map(([id, def]) => ({
      id,
      main_module: def.main_module,
      entrypoint: def.entrypoint,
      egress: def.egress,
    }));
  }

  /** Restore all stored workers into the engine on startup */
  async warmUp(engine) {
    if (this.workers.size === 0) return;
    console.log(`[store] Warming up ${this.workers.size} stored worker(s)...`);
    for (const [id, template] of this.workers.entries()) {
      try {
        // Send a lightweight ping-style execute to register the worker in the
        // engine's in-memory registry (input is null, will be a no-op)
        await engine.execute({
          ...template,
          id,
          input: null,
        });
      } catch (err) {
        console.warn(`[store] Warm-up failed for worker '${id}': ${err.message}`);
      }
    }
    console.log('[store] Warm-up complete');
  }
}
