use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tracing::{info, warn};
use wasmtime::*;
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::{pipe::MemoryInputPipe, pipe::MemoryOutputPipe, WasiCtxBuilder};

use crate::types::{ExecutionResult, LoadRequest};

/// Host state threaded through every Wasm store.
/// Uses WASIp1 (snapshot_preview1) which works with core (non-component) modules.
pub struct WorkerState {
    pub wasi: WasiP1Ctx,
    pub stdout_pipe: MemoryOutputPipe,
    pub stderr_pipe: MemoryOutputPipe,
}

/// The core sandbox executor. One Engine is shared across all workers.
pub struct SandboxEngine {
    engine: Engine,
}

impl SandboxEngine {
    /// Create a new sandbox engine with optimised settings
    pub fn new() -> Result<Self> {
        let mut config = Config::new();
        config.async_support(true);
        config.cranelift_opt_level(OptLevel::Speed);
        config.memory_init_cow(true);

        // Enable pooling allocator for fast instantiation (sub-millisecond cold starts)
        let mut pool = PoolingAllocationConfig::default();
        pool.total_memories(256);
        pool.total_tables(256);
        pool.total_core_instances(256);
        config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool));

        let engine = Engine::new(&config)?;
        Ok(Self { engine })
    }

    /// Execute a wasm module from a LoadRequest, returning an ExecutionResult
    pub async fn execute(
        &self,
        req: &LoadRequest,
        worker_id: &str,
        cache_hit: bool,
    ) -> Result<ExecutionResult> {
        let start = Instant::now();

        // Get the main module bytes (base64-decode)
        let main_b64 = req
            .modules
            .get(&req.main_module)
            .ok_or_else(|| anyhow!("Main module '{}' not found in modules map", req.main_module))?;
        let main_bytes = STANDARD
            .decode(main_b64)
            .with_context(|| format!("Failed to base64-decode module '{}'", req.main_module))?;

        // Compile the main module
        let module = Module::new(&self.engine, &main_bytes)
            .with_context(|| "Failed to compile WebAssembly module")?;

        // Set up capture pipes (capacity: 4MB each)
        let stdout_pipe = MemoryOutputPipe::new(4 * 1024 * 1024);
        let stderr_pipe = MemoryOutputPipe::new(4 * 1024 * 1024);

        // Build WASI context using preview1 (WasiP1Ctx)
        let mut wasi_builder = WasiCtxBuilder::new();

        // Set environment variables
        for (k, v) in &req.env {
            wasi_builder.env(k, v);
        }

        // Attach capture pipes for stdout/stderr
        wasi_builder.stdout(stdout_pipe.clone());
        wasi_builder.stderr(stderr_pipe.clone());

        // Pass the JSON input as stdin
        let input_bytes = serde_json::to_vec(&req.input)?;
        wasi_builder.stdin(MemoryInputPipe::new(input_bytes));

        // Build a WasiP1Ctx (preview1 context, compatible with core Linker)
        let wasi_ctx = wasi_builder.build_p1();

        // Build store with host state
        let state = WorkerState {
            wasi: wasi_ctx,
            stdout_pipe: stdout_pipe.clone(),
            stderr_pipe: stderr_pipe.clone(),
        };

        let mut store = Store::new(&self.engine, state);

        // Build core Linker with WASI preview1
        let mut linker: Linker<WorkerState> = Linker::new(&self.engine);
        preview1::add_to_linker_async(&mut linker, |s: &mut WorkerState| &mut s.wasi)?;

        // Instantiate
        let instance = linker
            .instantiate_async(&mut store, &module)
            .await
            .with_context(|| "Failed to instantiate WebAssembly module")?;

        // Execute with optional timeout
        let exec_result = if req.timeout_ms > 0 {
            let dur = Duration::from_millis(req.timeout_ms);
            timeout(
                dur,
                Self::call_entrypoint(&mut store, &instance, &req.entrypoint),
            )
            .await
            .map_err(|_| anyhow!("Worker execution timed out after {}ms", req.timeout_ms))?
        } else {
            Self::call_entrypoint(&mut store, &instance, &req.entrypoint).await
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        // Collect captured output
        let stdout = String::from_utf8_lossy(&stdout_pipe.contents()).to_string();
        let stderr = String::from_utf8_lossy(&stderr_pipe.contents()).to_string();

        match exec_result {
            Ok(output) => {
                info!(worker_id, duration_ms, cache_hit, "Worker executed successfully");
                Ok(ExecutionResult {
                    worker_id: worker_id.to_string(),
                    cache_hit,
                    output,
                    stdout,
                    stderr,
                    duration_ms,
                    success: true,
                    error: None,
                })
            }
            Err(e) => {
                warn!(worker_id, error = %e, "Worker execution failed");
                Ok(ExecutionResult {
                    worker_id: worker_id.to_string(),
                    cache_hit,
                    output: serde_json::Value::Null,
                    stdout,
                    stderr,
                    duration_ms,
                    success: false,
                    error: Some(e.to_string()),
                })
            }
        }
    }

    /// Call the named export function. Reads JSON output from stdout.
    async fn call_entrypoint(
        store: &mut Store<WorkerState>,
        instance: &Instance,
        entrypoint: &str,
    ) -> Result<serde_json::Value> {
        // Try the requested entrypoint, then fall back to _start (WASI main)
        let func = instance
            .get_func(&mut *store, entrypoint)
            .or_else(|| instance.get_func(&mut *store, "_start"))
            .ok_or_else(|| anyhow!("Export '{}' not found in wasm module", entrypoint))?;

        // Call with no args (WASI convention: input via stdin, output via stdout)
        func.call_async(&mut *store, &[], &mut []).await?;

        // Read JSON output from captured stdout
        let stdout_bytes = store.data().stdout_pipe.contents();
        if stdout_bytes.is_empty() {
            return Ok(serde_json::Value::Null);
        }

        // Try to parse as JSON; fall back to plain string
        match serde_json::from_slice::<serde_json::Value>(&stdout_bytes) {
            Ok(v) => Ok(v),
            Err(_) => Ok(serde_json::Value::String(
                String::from_utf8_lossy(&stdout_bytes).trim().to_string(),
            )),
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }
}

impl Default for SandboxEngine {
    fn default() -> Self {
        Self::new().expect("Failed to create sandbox engine")
    }
}
