/**
 * engine-node.js
 * Pure Node.js WebAssembly engine — drop-in replacement for the Rust engine
 * on platforms where the Rust engine cannot be compiled (e.g. Termux/Android).
 *
 * Uses Node.js built-in WebAssembly + a minimal WASI implementation.
 * No native compilation required — works anywhere Node.js 18+ runs.
 *
 * Implements the same interface as EngineProcess in engine.js so the
 * server.js layer needs zero changes.
 */

import { WASI } from 'wasi';
import { randomUUID } from 'crypto';

// ── Worker registry (in-memory + optional disk persistence) ──────────────────
class WorkerRegistry {
  constructor() {
    this.workers = new Map(); // id -> { id, name, module, bytecode, created_at, last_used }
  }

  store(id, name, bytecode) {
    const now = Date.now();
    const entry = {
      id,
      name: name || id,
      bytecode, // Uint8Array
      created_at: now,
      last_used: now,
      call_count: 0,
    };
    this.workers.set(id, entry);
    return entry;
  }

  get(id) {
    const w = this.workers.get(id);
    if (w) {
      w.last_used = Date.now();
      w.call_count++;
    }
    return w || null;
  }

  list() {
    return Array.from(this.workers.values()).map(w => ({
      id: w.id,
      name: w.name,
      created_at: w.created_at,
      last_used: w.last_used,
      call_count: w.call_count,
    }));
  }

  evict(id) {
    return this.workers.delete(id);
  }

  evictStale(maxAgeSecs) {
    const cutoff = Date.now() - maxAgeSecs * 1000;
    let count = 0;
    for (const [id, w] of this.workers) {
      if (w.last_used < cutoff) {
        this.workers.delete(id);
        count++;
      }
    }
    return count;
  }
}

// ── WASM execution ────────────────────────────────────────────────────────────

/**
 * Execute a WASM module with the given input.
 * Convention: the module exports a `run(ptr, len) -> ptr` function.
 * Input JSON is written to WASM memory; output JSON is read back.
 * Falls back to WASI stdio-based execution if no `run` export.
 */
async function executeWasm(bytecode, input, env = {}) {
  const inputJson = JSON.stringify(input ?? {});
  const inputBytes = Buffer.from(inputJson, 'utf8');

  // Compile the module
  let wasmModule;
  try {
    wasmModule = await WebAssembly.compile(bytecode);
  } catch (e) {
    throw new Error(`WASM compile error: ${e.message}`);
  }

  const exports_list = WebAssembly.Module.exports(wasmModule).map(e => e.name);
  const hasRun = exports_list.includes('run');
  const hasMemory = exports_list.includes('memory');
  const hasAlloc = exports_list.includes('alloc');

  // ── Strategy 1: run(ptr, len) -> ptr  (preferred, no WASI needed) ──────────
  if (hasRun && hasMemory && hasAlloc) {
    return await executeWithRunExport(wasmModule, inputBytes);
  }

  // ── Strategy 2: WASI stdio (stdin → stdout) ─────────────────────────────────
  return await executeWithWasi(wasmModule, inputBytes, env);
}

async function executeWithRunExport(wasmModule, inputBytes) {
  const instance = await WebAssembly.instantiate(wasmModule, {
    env: { abort: () => {} },
  });
  const { memory, alloc, run } = instance.exports;

  // Write input into WASM memory
  const ptr = alloc(inputBytes.length);
  const mem = new Uint8Array(memory.buffer);
  mem.set(inputBytes, ptr);

  // Call run(ptr, len) — returns a pointer to a null-terminated JSON string
  const resultPtr = run(ptr, inputBytes.length);

  // Read output string from WASM memory
  const view = new Uint8Array(memory.buffer);
  let end = resultPtr;
  while (view[end] !== 0 && end < view.length) end++;
  const resultBytes = view.slice(resultPtr, end);
  const resultJson = Buffer.from(resultBytes).toString('utf8');

  try {
    return JSON.parse(resultJson);
  } catch {
    return { output: resultJson };
  }
}

async function executeWithWasi(wasmModule, inputBytes, env = {}) {
  // Capture stdout/stderr via in-memory buffers
  const stdoutChunks = [];
  const stderrChunks = [];

  // Node.js WASI with piped stdio
  const wasi = new WASI({
    version: 'preview1',
    args: [],
    env: { ...env },
    stdin: 0,
    stdout: 1,
    stderr: 2,
    returnOnExit: true,
  });

  // We need to intercept stdout — use a custom approach with fd_write override
  // since Node's WASI doesn't support piped stdio directly in all versions.
  // We patch the wasi imports to capture writes to fd=1 (stdout).
  const wasiImports = wasi.getImportObject();

  // Wrap fd_write to capture stdout
  const originalFdWrite = wasiImports.wasi_snapshot_preview1.fd_write;
  wasiImports.wasi_snapshot_preview1.fd_write = (fd, iovs, iovs_len, nwritten) => {
    if (fd === 1 || fd === 2) {
      // We'll read from memory after instantiation — for now just call original
      const result = originalFdWrite(fd, iovs, iovs_len, nwritten);
      return result;
    }
    return originalFdWrite(fd, iovs, iovs_len, nwritten);
  };

  let instance;
  try {
    instance = await WebAssembly.instantiate(wasmModule, wasiImports);
  } catch (e) {
    throw new Error(`WASM instantiate error: ${e.message}`);
  }

  // Write input to memory if _start or main expects it via fd_read
  // For simple WASI modules, we capture output via a memory-mapped stdout
  const memory = instance.exports.memory;

  // Redirect stdout by intercepting fd_write at the memory level
  // Re-instantiate with proper stdout capture
  const outputBuffer = [];
  const captureImports = wasi.getImportObject();
  const origWrite = captureImports.wasi_snapshot_preview1.fd_write;

  captureImports.wasi_snapshot_preview1.fd_write = function(fd, iovs_ptr, iovs_len, nwritten_ptr) {
    if (fd === 1 && memory) {
      const mem = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = mem.getUint32(iovs_ptr + i * 8, true);
        const len  = mem.getUint32(iovs_ptr + i * 8 + 4, true);
        const chunk = new Uint8Array(memory.buffer, base, len);
        outputBuffer.push(Buffer.from(chunk));
        total += len;
      }
      mem.setUint32(nwritten_ptr, total, true);
      return 0; // ESUCCESS
    }
    return origWrite(fd, iovs_ptr, iovs_len, nwritten_ptr);
  };

  // Also handle stdin (fd=0) reads — feed inputBytes
  let stdinOffset = 0;
  captureImports.wasi_snapshot_preview1.fd_read = function(fd, iovs_ptr, iovs_len, nread_ptr) {
    if (fd === 0 && memory) {
      const mem = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = mem.getUint32(iovs_ptr + i * 8, true);
        const len  = mem.getUint32(iovs_ptr + i * 8 + 4, true);
        const available = inputBytes.length - stdinOffset;
        const toCopy = Math.min(len, available);
        if (toCopy > 0) {
          const dest = new Uint8Array(memory.buffer, base, toCopy);
          dest.set(inputBytes.slice(stdinOffset, stdinOffset + toCopy));
          stdinOffset += toCopy;
          total += toCopy;
        }
      }
      mem.setUint32(nread_ptr, total, true);
      return 0;
    }
    return 1; // EBADF for other fds
  };

  // Re-instantiate with capture imports
  const inst2 = await WebAssembly.instantiate(wasmModule, captureImports);
  const mem2 = inst2.exports.memory;
  // Update memory reference in closure
  Object.defineProperty(memory, 'buffer', { get: () => mem2.buffer });

  try {
    if (inst2.exports._start) {
      inst2.exports._start();
    } else if (inst2.exports.main) {
      inst2.exports.main(0, 0);
    }
  } catch (e) {
    // WASI exit codes are thrown as errors — that's normal
    if (!e.message?.includes('exit') && !e.message?.includes('unreachable')) {
      throw new Error(`WASM runtime error: ${e.message}`);
    }
  }

  const output = Buffer.concat(outputBuffer).toString('utf8').trim();
  try {
    return JSON.parse(output);
  } catch {
    return { output: output || '(no output)' };
  }
}

// ── NodeEngine class — same interface as EngineProcess ────────────────────────

export class NodeEngine {
  constructor(options = {}) {
    this.registry = new WorkerRegistry();
    this._dead = false;
    this._started = false;
  }

  async start() {
    this._started = true;
    // Nothing to start — pure in-process engine
  }

  stop() {
    this._dead = false;
  }

  async execute(req) {
    // req: { id?, name?, main_module, modules: { [name]: base64 }, input, env }
    const { id, name, main_module, modules, input, env } = req;

    let bytecode;

    // If an id is given, try to reuse cached worker
    if (id) {
      const cached = this.registry.get(id);
      if (cached) {
        bytecode = cached.bytecode;
      }
    }

    // If not cached, decode from request
    if (!bytecode) {
      if (!modules || !main_module || !modules[main_module]) {
        throw new Error(`Module '${main_module}' not provided and not cached`);
      }
      const b64 = modules[main_module];
      bytecode = Buffer.from(b64, 'base64');

      // Cache it if an id was given
      if (id) {
        this.registry.store(id, name || id, bytecode);
      }
    }

    const start = Date.now();
    const result = await executeWasm(bytecode, input, env || {});
    const elapsed_ms = Date.now() - start;

    return {
      ok: true,
      result,
      elapsed_ms,
      worker_id: id || null,
      cached: !!(id && this.registry.get(id)),
    };
  }

  async listWorkers() {
    return this.registry.list();
  }

  async getWorker(worker_id) {
    return this.registry.get(worker_id);
  }

  async evictWorker(worker_id) {
    return this.registry.evict(worker_id);
  }

  async evictStale(max_age_secs) {
    return this.registry.evictStale(max_age_secs);
  }
}
