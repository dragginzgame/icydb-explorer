//! Turns a discovered `Environment` into a usable `ic_agent::Agent`.
//!
//! Building an agent means loading a pem identity from disk and — for
//! local replicas only — an extra network round-trip to fetch the root
//! key. Neither is something callers should repeat on every query, so
//! `AgentPool` builds one `Agent` per environment and reuses it.

mod identity;

pub use identity::load_identity;

use std::collections::HashMap;
use std::sync::Arc;

use ic_agent::Agent;
use tokio::sync::Mutex;

use crate::discovery::Environment;
use crate::error::AppError;

/// Caches one `ic_agent::Agent` per `Environment::name`.
pub struct AgentPool {
    agents: Mutex<HashMap<String, Arc<Agent>>>,
}

impl Default for AgentPool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentPool {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the cached agent for `env`, building and caching one on a
    /// miss.
    ///
    /// For local replicas (any host other than `ic0.app`/`icp-api.io`),
    /// this also calls `fetch_root_key`, since a local replica's root key
    /// is unknown to the agent until fetched. A failure there — the
    /// single most likely failure in daily use of this tool — is reported
    /// as `AppError::ReplicaUnreachable` naming the URL, not a generic
    /// agent error, so that someone whose replica isn't running can tell
    /// what's wrong at a glance.
    pub async fn get(&self, env: &Environment) -> Result<Arc<Agent>, AppError> {
        let mut agents = self.agents.lock().await;
        if let Some(agent) = agents.get(&env.name) {
            return Ok(Arc::clone(agent));
        }

        let identity = identity_for(env)?;

        let agent = Agent::builder()
            .with_url(&env.replica_url)
            .with_boxed_identity(identity)
            .build()
            .map_err(|e| AppError::Agent(e.to_string()))?;

        if is_local_replica(&env.replica_url) {
            agent
                .fetch_root_key()
                .await
                .map_err(|_| AppError::ReplicaUnreachable {
                    url: env.replica_url.clone(),
                })?;
        }

        let agent = Arc::new(agent);
        agents.insert(env.name.clone(), Arc::clone(&agent));
        Ok(agent)
    }
}

/// Resolves the identity to use for `env`.
///
/// An environment with no identity configured (`Environment.identity ==
/// None`) is not treated as "connect anonymously": icydb's SQL endpoints
/// are controller-gated, so an anonymous caller would only find out it's
/// rejected after a network round-trip, via a rejection message that
/// doesn't obviously point back at "you have no identity configured".
/// Failing locally and immediately, with a message that says exactly
/// what's missing, is the clearer failure for the user.
fn identity_for(env: &Environment) -> Result<Box<dyn ic_agent::Identity>, AppError> {
    match &env.identity {
        Some(identity_ref) => load_identity(identity_ref),
        None => Err(AppError::Agent(format!(
            "no identity is configured for environment \"{}\"; icydb's SQL endpoints are \
             controller-gated, so add an identity (e.g. via `dfx identity`) to this \
             environment's .icp/ configuration before connecting",
            env.name
        ))),
    }
}

/// Treats any replica whose host is not a known mainnet boundary host
/// (`ic0.app`, `icp-api.io`) as local.
///
/// This split matters because `fetch_root_key` must run for local
/// replicas (their root key isn't known to the agent until fetched) and
/// must not run against mainnet (unnecessary, and a security
/// anti-pattern: it would let a compromised or misconfigured mainnet
/// endpoint hand the agent an arbitrary root key).
fn is_local_replica(url: &str) -> bool {
    match host_of(url) {
        Some(host) => !matches!(host, "ic0.app" | "icp-api.io"),
        None => true,
    }
}

/// Extracts the host from a URL without pulling in a URL-parsing crate:
/// strip the scheme, then take everything up to the next `/`, `:`
/// (port), `?`, or `#`.
fn host_of(url: &str) -> Option<&str> {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let end = after_scheme
        .find(['/', ':', '?', '#'])
        .unwrap_or(after_scheme.len());
    let host = &after_scheme[..end];
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mainnet_boundary_hosts_are_not_local() {
        assert!(!is_local_replica("https://ic0.app"));
        assert!(!is_local_replica("https://ic0.app/"));
        assert!(!is_local_replica("https://icp-api.io"));
    }

    #[test]
    fn loopback_and_other_hosts_are_local() {
        assert!(is_local_replica("http://127.0.0.1:4943"));
        assert!(is_local_replica("http://localhost:8000"));
        // A subdomain of a mainnet host is a distinct host, and the brief
        // is explicit that only an exact match on ic0.app/icp-api.io
        // counts as mainnet.
        assert!(is_local_replica("https://boundary.icp-api.io"));
    }
}
