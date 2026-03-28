use anyhow::Result;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, info};
use uuid::Uuid;

use crate::sandbox::SandboxEngine;
use crate::types::{ExecutionResult, LoadRequest, WorkerStatus};

/// A cached worker entry in the registry
#[derive(Debug, Clone)]
struct CachedWorker {
    pub id: String,
    pub main_module: String,
    pub created_at: u64,
    pub last_used_at: Arc<std::sync::Mutex<u64>>,
    pub invocation_count: Arc<std::sync::atomic::AtomicU64>,
    /// The original load request (minus input, which changes per call)
    pub template: LoadRequest,
}

/// The worker registry: manages worker identity, caching, and lifecycle
pub struct WorkerRegistry {
    engine: Arc<SandboxEngine>,
    /// Map of worker_id -> CachedWorker
    workers: DashMap<String, CachedWorker>,
}

impl WorkerRegistry {
    pub fn new(engine: Arc<SandboxEngine>) -> Self {
        Self {
            engine,
            workers: DashMap::new(),
        }
    }

    /// Execute a worker. If `req.id` is set, reuse cached worker if available.
    /// Otherwise create a fresh one-shot worker.
    pub async fn execute(&self, mut req: LoadRequest) -> Result<ExecutionResult> {
        match &req.id {
            Some(id) => {
                let id = id.clone();
                // Check if we have a cached worker
                if let Some(cached) = self.workers.get(&id) {
                    let now = now_secs();
                    *cached.last_used_at.lock().unwrap() = now;
                    cached.invocation_count
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    debug!(worker_id = %id, "Cache hit: reusing existing worker");
                    // Execute using the cached template merged with new input
                    let mut exec_req = cached.template.clone();
                    exec_req.input = req.input.clone();
                    drop(cached);
                    return self.engine.execute(&exec_req, &id, true).await;
                }

                // Cache miss: create and register new worker
                info!(worker_id = %id, "Cache miss: creating new worker");
                let cached = CachedWorker {
                    id: id.clone(),
                    main_module: req.main_module.clone(),
                    created_at: now_secs(),
                    last_used_at: Arc::new(std::sync::Mutex::new(now_secs())),
                    invocation_count: Arc::new(std::sync::atomic::AtomicU64::new(1)),
                    template: req.clone(),
                };
                self.workers.insert(id.clone(), cached);
                self.engine.execute(&req, &id, false).await
            }
            None => {
                // One-shot: generate a fresh ID, do not cache
                let id = Uuid::new_v4().to_string();
                debug!(worker_id = %id, "One-shot worker execution");
                self.engine.execute(&req, &id, false).await
            }
        }
    }

    /// List all cached workers
    pub fn list_workers(&self) -> Vec<WorkerStatus> {
        self.workers
            .iter()
            .map(|entry| {
                let w = entry.value();
                WorkerStatus {
                    id: w.id.clone(),
                    created_at: w.created_at,
                    last_used_at: *w.last_used_at.lock().unwrap(),
                    invocation_count: w
                        .invocation_count
                        .load(std::sync::atomic::Ordering::Relaxed),
                    main_module: w.main_module.clone(),
                }
            })
            .collect()
    }

    /// Get status of a specific worker
    pub fn get_worker(&self, id: &str) -> Option<WorkerStatus> {
        self.workers.get(id).map(|w| WorkerStatus {
            id: w.id.clone(),
            created_at: w.created_at,
            last_used_at: *w.last_used_at.lock().unwrap(),
            invocation_count: w
                .invocation_count
                .load(std::sync::atomic::Ordering::Relaxed),
            main_module: w.main_module.clone(),
        })
    }

    /// Evict (delete) a worker from the registry
    pub fn evict_worker(&self, id: &str) -> bool {
        self.workers.remove(id).is_some()
    }

    /// Evict all workers older than `max_age_secs` seconds since last use
    pub fn evict_stale(&self, max_age_secs: u64) -> usize {
        let now = now_secs();
        let mut evicted = 0;
        self.workers.retain(|_, w| {
            let last = *w.last_used_at.lock().unwrap();
            if now - last > max_age_secs {
                evicted += 1;
                false
            } else {
                true
            }
        });
        evicted
    }

    /// Total number of cached workers
    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
