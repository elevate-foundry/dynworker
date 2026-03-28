use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Network egress policy for a worker sandbox
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EgressPolicy {
    /// Block all outbound network access (default)
    Block,
    /// Allow all outbound network access
    Allow,
    /// Allow only specific hosts (whitelist)
    AllowList(Vec<String>),
    /// Block specific hosts (blacklist), allow rest
    BlockList(Vec<String>),
}

impl Default for EgressPolicy {
    fn default() -> Self {
        EgressPolicy::Block
    }
}

/// Request to load and run a dynamic worker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadRequest {
    /// Optional stable ID for caching/reuse. If None, a fresh worker is always created.
    pub id: Option<String>,
    /// The main module name (entry point key in `modules`)
    pub main_module: String,
    /// Map of module name -> base64-encoded wasm bytes
    pub modules: HashMap<String, String>,
    /// Name of the exported function to call (defaults to "_start")
    #[serde(default = "default_entrypoint")]
    pub entrypoint: String,
    /// JSON-encoded input argument passed via stdin to the function
    pub input: serde_json::Value,
    /// Environment variables available to the wasm module
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Network egress policy
    #[serde(default)]
    pub egress: EgressPolicy,
    /// Maximum execution time in milliseconds (0 = unlimited)
    #[serde(default)]
    pub timeout_ms: u64,
    /// Maximum memory in bytes (0 = default)
    #[serde(default)]
    pub memory_limit_bytes: u64,
}

fn default_entrypoint() -> String {
    "_start".to_string()
}

/// Result of executing a dynamic worker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    /// The worker ID that was used
    pub worker_id: String,
    /// Whether this was a cache hit (reused existing worker)
    pub cache_hit: bool,
    /// JSON output from the function (parsed from stdout)
    pub output: serde_json::Value,
    /// Captured stdout from the wasm module
    pub stdout: String,
    /// Captured stderr from the wasm module
    pub stderr: String,
    /// Execution time in milliseconds
    pub duration_ms: u64,
    /// Whether execution succeeded
    pub success: bool,
    /// Error message if success is false
    pub error: Option<String>,
}

/// Status of a cached worker in the registry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerStatus {
    pub id: String,
    pub created_at: u64,
    pub last_used_at: u64,
    pub invocation_count: u64,
    pub main_module: String,
}
