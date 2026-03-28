/// network.rs
/// Network egress policy enforcement for DynWorker sandboxes.
///
/// WASI Preview 1 (wasi_snapshot_preview1) does NOT expose raw socket syscalls —
/// the wasm module cannot open TCP/UDP sockets directly. This means the default
/// WASI sandbox already provides strong network isolation out of the box.
///
/// This module provides:
///   1. A policy checker that can be called from host-function hooks to enforce
///      allow/block lists when wasm code tries to use WASI networking extensions.
///   2. A `NetworkGuard` that wraps the egress policy and is stored in WorkerState.
///   3. Utility functions for IP/hostname matching.

use crate::types::EgressPolicy;
use std::net::IpAddr;
use std::str::FromStr;

/// Decides whether an outbound connection to `host` is permitted under `policy`.
pub fn is_allowed(policy: &EgressPolicy, host: &str) -> bool {
    match policy {
        EgressPolicy::Block => false,
        EgressPolicy::Allow => true,
        EgressPolicy::AllowList(allowed) => {
            allowed.iter().any(|pattern| host_matches(host, pattern))
        }
        EgressPolicy::BlockList(blocked) => {
            !blocked.iter().any(|pattern| host_matches(host, pattern))
        }
    }
}

/// Match a host against a pattern.
/// Supports:
///   - Exact hostname match:  "example.com"
///   - Wildcard subdomain:    "*.example.com"
///   - CIDR block:            "192.168.0.0/16"
///   - Exact IP:              "1.2.3.4"
pub fn host_matches(host: &str, pattern: &str) -> bool {
    // Wildcard subdomain: *.example.com
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return host.ends_with(suffix)
            && host.len() > suffix.len()
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.';
    }

    // CIDR match
    if pattern.contains('/') {
        if let (Ok(ip), Ok(cidr)) = (IpAddr::from_str(host), parse_cidr(pattern)) {
            return cidr_contains(cidr, ip);
        }
        return false;
    }

    // Exact match (case-insensitive)
    host.eq_ignore_ascii_case(pattern)
}

/// Parse a CIDR string into (network_addr, prefix_len)
fn parse_cidr(cidr: &str) -> Result<(IpAddr, u8), ()> {
    let parts: Vec<&str> = cidr.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(());
    }
    let addr = IpAddr::from_str(parts[0]).map_err(|_| ())?;
    let prefix: u8 = parts[1].parse().map_err(|_| ())?;
    Ok((addr, prefix))
}

/// Check whether `ip` falls within the CIDR block `(network, prefix_len)`
fn cidr_contains((network, prefix_len): (IpAddr, u8), ip: IpAddr) -> bool {
    match (network, ip) {
        (IpAddr::V4(net), IpAddr::V4(addr)) => {
            if prefix_len == 0 {
                return true;
            }
            let shift = 32u32.saturating_sub(prefix_len as u32);
            let net_u32 = u32::from(net) >> shift;
            let addr_u32 = u32::from(addr) >> shift;
            net_u32 == addr_u32
        }
        (IpAddr::V6(net), IpAddr::V6(addr)) => {
            if prefix_len == 0 {
                return true;
            }
            let shift = 128u32.saturating_sub(prefix_len as u32);
            let net_u128 = u128::from(net) >> shift;
            let addr_u128 = u128::from(addr) >> shift;
            net_u128 == addr_u128
        }
        _ => false, // IPv4 vs IPv6 mismatch
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EgressPolicy;

    #[test]
    fn block_policy_denies_all() {
        assert!(!is_allowed(&EgressPolicy::Block, "example.com"));
        assert!(!is_allowed(&EgressPolicy::Block, "1.2.3.4"));
    }

    #[test]
    fn allow_policy_permits_all() {
        assert!(is_allowed(&EgressPolicy::Allow, "example.com"));
        assert!(is_allowed(&EgressPolicy::Allow, "evil.com"));
    }

    #[test]
    fn allow_list_exact_match() {
        let policy = EgressPolicy::AllowList(vec!["api.example.com".to_string()]);
        assert!(is_allowed(&policy, "api.example.com"));
        assert!(!is_allowed(&policy, "evil.com"));
        assert!(!is_allowed(&policy, "example.com"));
    }

    #[test]
    fn allow_list_wildcard() {
        let policy = EgressPolicy::AllowList(vec!["*.example.com".to_string()]);
        assert!(is_allowed(&policy, "api.example.com"));
        assert!(is_allowed(&policy, "sub.api.example.com"));
        assert!(!is_allowed(&policy, "example.com")); // root not matched by *.
        assert!(!is_allowed(&policy, "evil.com"));
    }

    #[test]
    fn block_list_excludes_specific() {
        let policy = EgressPolicy::BlockList(vec!["evil.com".to_string()]);
        assert!(is_allowed(&policy, "good.com"));
        assert!(!is_allowed(&policy, "evil.com"));
    }

    #[test]
    fn cidr_matching() {
        let policy = EgressPolicy::AllowList(vec!["192.168.0.0/16".to_string()]);
        assert!(is_allowed(&policy, "192.168.1.100"));
        assert!(is_allowed(&policy, "192.168.255.255"));
        assert!(!is_allowed(&policy, "10.0.0.1"));
        assert!(!is_allowed(&policy, "192.169.0.1"));
    }
}
