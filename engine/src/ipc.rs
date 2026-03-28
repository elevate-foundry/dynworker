/// IPC protocol between the Node.js API server and this Rust engine.
/// The engine runs as a long-lived child process.
/// The API server sends JSON-encoded IpcRequest lines on stdin,
/// and the engine replies with JSON-encoded IpcResponse lines on stdout.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{error, info};

use crate::registry::WorkerRegistry;
use crate::types::{ExecutionResult, LoadRequest, WorkerStatus};

/// A request sent from the API server to the engine
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcRequest {
    /// Execute a worker (load + run)
    Execute {
        req_id: String,
        payload: LoadRequest,
    },
    /// List all cached workers
    ListWorkers {
        req_id: String,
    },
    /// Get a specific worker's status
    GetWorker {
        req_id: String,
        worker_id: String,
    },
    /// Evict a specific worker
    EvictWorker {
        req_id: String,
        worker_id: String,
    },
    /// Evict all stale workers
    EvictStale {
        req_id: String,
        max_age_secs: u64,
    },
    /// Health check
    Ping {
        req_id: String,
    },
}

/// A response sent from the engine back to the API server
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcResponse {
    ExecuteResult {
        req_id: String,
        result: ExecutionResult,
    },
    WorkerList {
        req_id: String,
        workers: Vec<WorkerStatus>,
    },
    WorkerInfo {
        req_id: String,
        worker: Option<WorkerStatus>,
    },
    EvictResult {
        req_id: String,
        evicted: bool,
    },
    EvictStaleResult {
        req_id: String,
        count: usize,
    },
    Pong {
        req_id: String,
    },
    Error {
        req_id: String,
        message: String,
    },
}

/// Run the IPC event loop: read requests from stdin, write responses to stdout
pub async fn run_ipc_loop(registry: &WorkerRegistry) -> Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut writer = tokio::io::BufWriter::new(stdout);
    let mut line = String::new();

    info!("DynWorker engine ready. Listening for IPC requests...");

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            // EOF: parent process closed stdin
            info!("Stdin closed, shutting down engine.");
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<IpcRequest>(trimmed) {
            Ok(req) => handle_request(registry, req).await,
            Err(e) => IpcResponse::Error {
                req_id: "unknown".to_string(),
                message: format!("Failed to parse IPC request: {}", e),
            },
        };

        let mut resp_line = serde_json::to_string(&response)?;
        resp_line.push('\n');
        writer.write_all(resp_line.as_bytes()).await?;
        writer.flush().await?;
    }

    Ok(())
}

async fn handle_request(registry: &WorkerRegistry, req: IpcRequest) -> IpcResponse {
    match req {
        IpcRequest::Execute { req_id, payload } => {
            match registry.execute(payload).await {
                Ok(result) => IpcResponse::ExecuteResult { req_id, result },
                Err(e) => IpcResponse::Error {
                    req_id,
                    message: e.to_string(),
                },
            }
        }
        IpcRequest::ListWorkers { req_id } => IpcResponse::WorkerList {
            req_id,
            workers: registry.list_workers(),
        },
        IpcRequest::GetWorker { req_id, worker_id } => IpcResponse::WorkerInfo {
            req_id,
            worker: registry.get_worker(&worker_id),
        },
        IpcRequest::EvictWorker { req_id, worker_id } => IpcResponse::EvictResult {
            req_id,
            evicted: registry.evict_worker(&worker_id),
        },
        IpcRequest::EvictStale { req_id, max_age_secs } => IpcResponse::EvictStaleResult {
            req_id,
            count: registry.evict_stale(max_age_secs),
        },
        IpcRequest::Ping { req_id } => IpcResponse::Pong { req_id },
    }
}
