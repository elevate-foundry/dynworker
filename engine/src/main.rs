use anyhow::Result;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

use dynworker_engine::{ipc, registry::WorkerRegistry, sandbox::SandboxEngine};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialise structured logging (to stderr so it doesn't pollute IPC stdout)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    info!("Starting DynWorker engine v{}", env!("CARGO_PKG_VERSION"));

    // Create the shared Wasmtime engine
    let sandbox = Arc::new(SandboxEngine::new()?);
    info!("Wasmtime sandbox engine initialised");

    // Create the worker registry
    let registry = WorkerRegistry::new(sandbox);

    // Run the JSON IPC loop (reads from stdin, writes to stdout)
    ipc::run_ipc_loop(&registry).await?;

    Ok(())
}
