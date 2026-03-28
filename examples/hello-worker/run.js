/**
 * examples/hello-worker/run.js
 *
 * Demonstrates the DynWorker SDK:
 *   1. One-shot execution
 *   2. Persistent worker with get() + run()
 *
 * Run with:
 *   node run.js
 *
 * (Requires the DynWorker API server to be running on localhost:7777)
 */

import { DynWorker } from '../../sdk/src/index.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dw = new DynWorker({ baseUrl: 'http://localhost:7777' });

// Load and base64-encode the wasm module
const wasmBytes = await readFile(path.join(__dirname, 'hello.wasm'));
const wasmB64 = wasmBytes.toString('base64');

console.log('\n── Example 1: One-shot execution ──────────────────────────────');
const result1 = await dw.execute({
  mainModule: 'hello.wasm',
  modules: { 'hello.wasm': wasmB64 },
  input: { name: 'world' },
});
console.log('Success:', result1.success);
console.log('Output:', result1.output);
console.log('Duration:', result1.duration_ms + 'ms');
console.log('Cache hit:', result1.cache_hit);

console.log('\n── Example 2: Persistent worker (get + run) ───────────────────');
const worker = await dw.get('hello-v1', async () => ({
  mainModule: 'hello.wasm',
  modules: { 'hello.wasm': wasmB64 },
}));

console.log('Worker ID:', worker.id);

// First call — cold start
const result2 = await worker.run({ name: 'Alice' });
console.log('Run 1 — Cache hit:', result2.cache_hit, '| Duration:', result2.duration_ms + 'ms');

// Second call — warm (cache hit)
const result3 = await worker.run({ name: 'Bob' });
console.log('Run 2 — Cache hit:', result3.cache_hit, '| Duration:', result3.duration_ms + 'ms');

console.log('\n── Worker status ───────────────────────────────────────────────');
const status = await worker.status();
console.log('Invocations:', status?.engine?.invocation_count ?? 'n/a');

console.log('\n── Health check ────────────────────────────────────────────────');
const health = await dw.health();
console.log(health);

console.log('\nDone.');
