/**
 * index.js
 * DynWorker API server entry point.
 *
 * Engine selection:
 *   - Termux / Android  → NodeEngine (pure Node.js WebAssembly, zero native build)
 *   - Linux / macOS     → EngineProcess (Rust + Wasmtime, JIT-compiled, faster)
 *
 * Override with: DYNWORKER_ENGINE=node  or  DYNWORKER_ENGINE=rust
 */

import { buildServer } from './server.js';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '7777', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ── Engine detection ──────────────────────────────────────────────────────────

function isTermux() {
  return (
    process.env.TERMUX_VERSION !== undefined ||
    process.env.PREFIX?.includes('com.termux') ||
    existsSync('/data/data/com.termux')
  );
}

const engineOverride = process.env.DYNWORKER_ENGINE?.toLowerCase();
const rustBin = process.env.DYNWORKER_ENGINE_BIN ||
  resolve(__dirname, '../../engine/target/release/dynworker-engine');
const rustAvailable = existsSync(rustBin);

let engine;
let engineType;

if (engineOverride === 'node' || (!rustAvailable && isTermux()) || (!rustAvailable && engineOverride !== 'rust')) {
  // Pure Node.js engine — no native binary needed
  const { NodeEngine } = await import('./engine-node.js');
  engine = new NodeEngine();
  engineType = 'node (built-in WebAssembly)';
} else {
  // Rust/Wasmtime engine
  const { EngineProcess } = await import('./engine.js');
  engine = new EngineProcess({ binPath: rustBin });
  engineType = `rust (${rustBin})`;
}

console.log(`[dynworker] Engine: ${engineType}`);

// ── Start server ──────────────────────────────────────────────────────────────

const app = await buildServer({ engine });

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`DynWorker API listening on http://${HOST}:${PORT}`);
  console.log(`Engine type: ${engineType}`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
