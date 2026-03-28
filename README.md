# DynWorker

**DynWorker** is an open-source, self-hosted dynamic WebAssembly worker runtime — a drop-in alternative to Cloudflare Dynamic Workers. It lets you load, execute, and cache WebAssembly modules on demand with sub-millisecond cold starts, full network isolation, and durable worker persistence.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Application                                               │
│  (Node.js SDK  ─or─  direct HTTP / curl)                        │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP REST  (port 7777)
┌────────────────────────────▼────────────────────────────────────┐
│  API Server  (Node.js / Fastify)                                │
│  • POST /v1/execute          Execute a worker                   │
│  • POST /v1/workers          Register a named worker            │
│  • GET  /v1/workers          List workers                       │
│  • GET  /v1/workers/:id      Worker status                      │
│  • DELETE /v1/workers/:id    Evict a worker                     │
│  • WorkerStore  →  .dynworker/workers.json  (durable)           │
└────────────────────────────┬────────────────────────────────────┘
                             │ JSON-over-stdin/stdout IPC
┌────────────────────────────▼────────────────────────────────────┐
│  Rust Engine  (Wasmtime + WASI Preview 1)                       │
│  • Pooling allocator  →  sub-ms instantiation                   │
│  • WorkerRegistry     →  in-memory ID-keyed cache               │
│  • Network isolation  →  WASI blocks raw sockets by default     │
│  • Egress policies    →  block / allow / allowList / blockList  │
└─────────────────────────────────────────────────────────────────┘
```

### Key design decisions

| Concern | Choice | Rationale |
|---|---|---|
| Execution engine | Rust + Wasmtime | Best-in-class Wasm performance; pooling allocator gives sub-ms cold starts |
| WASI interface | Preview 1 (snapshot_preview1) | Widest toolchain compatibility (Rust, Go, C, AssemblyScript) |
| API server | Node.js + Fastify | Fast HTTP layer; easy to extend; same ecosystem as SDK |
| IPC | Newline-delimited JSON over stdin/stdout | Zero-dependency, language-agnostic, no network port needed |
| Persistence | JSON file on disk | Simple, portable, survives restarts; swap for SQLite/Redis easily |
| Network isolation | WASI (no raw sockets) + egress policy layer | Defence-in-depth; wasm cannot open TCP/UDP without explicit host permission |

---

## Requirements

- **Linux** (Ubuntu 22.04+ recommended) or **Android** with Ubuntu (Termux/proot)
- **Rust** 1.70+ (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- **Node.js** 22+ and **pnpm** 10+
- **gcc** / **binutils** (for Rust linking: `sudo apt install gcc binutils`)

---

## Quick Start

### 1. Build the Rust engine

```bash
cd engine
cargo build --release
# Binary: engine/target/release/dynworker-engine
```

### 2. Install API server dependencies

```bash
cd api
pnpm install
```

### 3. Start the server

```bash
cd api
node src/index.js
# DynWorker API listening on http://0.0.0.0:7777
```

### 4. Execute a worker via curl

```bash
# Base64-encode your .wasm file
WASM=$(base64 -w0 examples/hello-worker/hello.wasm)

curl -X POST http://localhost:7777/v1/execute \
  -H "Content-Type: application/json" \
  -d "{
    \"main_module\": \"hello.wasm\",
    \"modules\": { \"hello.wasm\": \"$WASM\" },
    \"input\": { \"name\": \"world\" }
  }"
```

**Response:**
```json
{
  "worker_id": "7c4cb6a6-...",
  "cache_hit": false,
  "output": { "greeting": "Hello from DynWorker!", "runtime": "wasmtime" },
  "stdout": "{\"greeting\":\"Hello from DynWorker!\",\"runtime\":\"wasmtime\"}",
  "stderr": "",
  "duration_ms": 13,
  "success": true,
  "error": null
}
```

---

## REST API Reference

### `POST /v1/execute`

Execute a WebAssembly worker. If `id` is provided, the worker is cached and reused on subsequent calls.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `main_module` | string | ✓ | Key in `modules` that is the entry point |
| `modules` | `{name: base64}` | ✓ | Map of module name → base64-encoded `.wasm` bytes |
| `id` | string | — | Stable worker ID for caching/reuse |
| `entrypoint` | string | — | Exported function name (default: `_start`) |
| `input` | any JSON | — | Passed to the worker via stdin |
| `env` | `{key: value}` | — | Environment variables |
| `egress` | string\|object | — | Network policy (see below) |
| `timeout_ms` | integer | — | Execution timeout in ms (0 = unlimited) |
| `memory_limit_bytes` | integer | — | Memory cap in bytes (0 = default) |

**Egress policy values:**

| Value | Behaviour |
|---|---|
| `"block"` (default) | All outbound network access blocked |
| `"allow"` | All outbound network access allowed |
| `{"allow_list": ["*.api.com"]}` | Only listed hosts allowed |
| `{"block_list": ["evil.com"]}` | Listed hosts blocked, rest allowed |

Patterns support exact hostnames, `*.subdomain` wildcards, and CIDR blocks (`192.168.0.0/16`).

---

### `POST /v1/workers`

Register a named worker definition without executing it. The definition is persisted to disk and survives server restarts.

### `GET /v1/workers`

List all workers (both engine-cached and disk-stored).

### `GET /v1/workers/:id`

Get the status and definition of a specific worker.

### `DELETE /v1/workers/:id`

Evict a worker from both the engine cache and the persistent store.

### `POST /v1/workers/evict-stale`

Evict all workers not used in the last `max_age_secs` seconds (default: 3600).

### `GET /v1/health`

Health check. Returns engine status and stored worker count.

---

## Node.js SDK

```bash
# From your project root:
pnpm add /path/to/dynworker/sdk
# or link locally:
pnpm link /path/to/dynworker/sdk
```

### One-shot execution

```js
import { DynWorker } from 'dynworker';
import { readFile } from 'fs/promises';

const dw = new DynWorker({ baseUrl: 'http://localhost:7777' });

const wasmB64 = (await readFile('my-worker.wasm')).toString('base64');

const result = await dw.execute({
  mainModule: 'my-worker.wasm',
  modules: { 'my-worker.wasm': wasmB64 },
  input: { name: 'Alice' },
  egress: 'block',
  timeoutMs: 5000,
});

console.log(result.output);   // parsed JSON from stdout
console.log(result.duration_ms);
```

### Persistent worker (`get` + `run`)

This mirrors the Cloudflare Dynamic Workers `get(id, callback)` primitive. The factory is called only once; subsequent calls reuse the cached worker.

```js
const worker = await dw.get('my-worker-v1', async () => ({
  mainModule: 'my-worker.wasm',
  modules: { 'my-worker.wasm': wasmB64 },
  egress: { allowList: ['api.example.com'] },
}));

// First call: cold start (compiles + instantiates wasm)
const r1 = await worker.run({ userId: 42 });

// Second call: warm (sub-ms, cache hit)
const r2 = await worker.run({ userId: 99 });

console.log(r1.cache_hit); // false
console.log(r2.cache_hit); // true
```

### Loading wasm from disk

```js
const wasmB64 = await DynWorker.loadWasm('./path/to/module.wasm');
```

---

## Writing Workers

Workers are standard WASI Preview 1 modules. They receive JSON input via **stdin** and must write JSON output to **stdout**.

### Rust worker example

```rust
// src/main.rs
use std::io::{self, Read, Write};
use serde_json::Value;

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let v: Value = serde_json::from_str(&input).unwrap_or(Value::Null);

    let output = serde_json::json!({
        "echo": v,
        "message": "Hello from Rust WASM!"
    });

    io::stdout().write_all(output.to_string().as_bytes()).unwrap();
}
```

Compile to WASI:
```bash
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release
# Output: target/wasm32-wasip1/release/my_worker.wasm
```

### AssemblyScript worker example

```typescript
import { Console } from "as-wasi/assembly";

export function _start(): void {
  Console.log(JSON.stringify({ greeting: "Hello from AssemblyScript!" }));
}
```

### WAT (WebAssembly Text) example

See [`examples/hello-worker/hello.wat`](examples/hello-worker/hello.wat) for a minimal hand-written WAT worker.

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PORT` | `7777` | API server port |
| `HOST` | `0.0.0.0` | API server bind address |
| `DYNWORKER_ENGINE_BIN` | `../engine/target/release/dynworker-engine` | Path to the Rust engine binary |
| `DYNWORKER_STORE_PATH` | `.dynworker/workers.json` | Path to the worker persistence file |
| `RUST_LOG` | `info` | Rust engine log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `LOG_LEVEL` | `info` | Node.js API server log level |

---

## Running Tests

### Rust engine unit tests (network policy, etc.)

```bash
cd engine
cargo test
```

### API server unit tests

```bash
cd api
node --test tests/
```

### Live end-to-end test

```bash
# Terminal 1: start the server
cd api && node src/index.js

# Terminal 2: run the example
cd examples/hello-worker && node run.js
```

---

## Project Structure

```
dynworker/
├── engine/                  Rust Wasmtime sandbox engine
│   └── src/
│       ├── main.rs          Binary entry point (IPC loop)
│       ├── lib.rs           Module declarations
│       ├── sandbox.rs       Core Wasm execution (Wasmtime + WASI)
│       ├── registry.rs      In-memory worker cache (ID-keyed)
│       ├── ipc.rs           JSON IPC protocol (stdin/stdout)
│       ├── network.rs       Egress policy enforcement
│       └── types.rs         Shared data types
│
├── api/                     Node.js REST API server
│   └── src/
│       ├── index.js         Entry point
│       ├── server.js        Fastify routes
│       ├── engine.js        IPC bridge to Rust engine
│       └── store.js         Durable worker persistence
│
├── sdk/                     Node.js client SDK
│   └── src/
│       ├── index.js         Public exports
│       └── client.js        DynWorker, WorkerHandle, DynWorkerError
│
└── examples/
    └── hello-worker/
        ├── hello.wat        Hand-written WAT worker
        ├── hello.wasm       Compiled binary
        └── run.js           SDK usage example
```

---

## Licence

Apache 2.0
