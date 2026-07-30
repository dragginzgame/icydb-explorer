//! Turns a discovered `Environment` into a usable `ic_agent::Agent`.
//!
//! Building an agent means loading an identity (pem from disk, or a keyring
//! export) and — for local replicas only — an extra network round-trip to
//! fetch the root key. Neither is something callers should repeat on every
//! query, so `AgentPool` builds one `Agent` per `(environment, identity)`
//! pair and reuses it.

mod export;
mod identity;

pub use export::export_pem;
pub use identity::load_identity;

use std::collections::HashMap;
use std::sync::Arc;

use ic_agent::Agent;
use tokio::sync::Mutex;

use crate::discovery::{Environment, IdentityRef};
use crate::error::AppError;

/// Caches one `ic_agent::Agent` per `(Environment::name, IdentityRef::name)`
/// pair — see `cache_key`.
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

    /// Returns the cached agent for `(env, identity)`, building and caching
    /// one on a miss.
    ///
    /// Keyed by both `env` and `identity` (see `cache_key`) rather than by
    /// environment alone: once identity is user-selectable, a cache keyed
    /// only on the environment name would silently keep returning the first
    /// identity's agent for every later selection — the UI would show one
    /// identity while queries ran as another.
    ///
    /// For local replicas (loopback/localhost/private-network hosts — see
    /// `is_local_replica`), this also calls `fetch_root_key`, since a local
    /// replica's root key is unknown to the agent until fetched. A failure
    /// there — the single most likely failure in daily use of this tool —
    /// is reported as `AppError::ReplicaUnreachable` naming the URL, not a
    /// generic agent error, so that someone whose replica isn't running can
    /// tell what's wrong at a glance.
    pub async fn get(
        &self,
        env: &Environment,
        identity: &IdentityRef,
    ) -> Result<Arc<Agent>, AppError> {
        let key = cache_key(&env.name, &identity.name);
        let mut agents = self.agents.lock().await;
        if let Some(agent) = agents.get(&key) {
            return Ok(Arc::clone(agent));
        }

        let boxed_identity = load_identity(identity).await?;

        let agent = Agent::builder()
            .with_url(&env.replica_url)
            .with_boxed_identity(boxed_identity)
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
        agents.insert(key, Arc::clone(&agent));
        Ok(agent)
    }
}

/// Builds the pool's cache key.
///
/// Length-prefixed rather than joined with a separator, so an environment or
/// identity name containing the separator cannot collide with a different
/// pair.
fn cache_key(env: &str, identity: &str) -> String {
    format!("{}:{env}:{}:{identity}", env.len(), identity.len())
}

/// Treats a replica as local only if its host is `localhost` or an IP in a
/// loopback/private/link-local range — a fail-safe allowlist, not a
/// mainnet-hostname denylist.
///
/// This split matters because `fetch_root_key` must run for local
/// replicas (their root key isn't known to the agent until fetched) and
/// must not run against mainnet (unnecessary, and a security
/// anti-pattern: it would let a compromised or misconfigured mainnet
/// endpoint hand the agent an arbitrary root key). An earlier version of
/// this function only excluded the two known mainnet boundary hostnames
/// (`ic0.app`, `icp-api.io`) and treated everything else — including
/// `icp0.io`, itself a canonical mainnet boundary host — as local, which is
/// fail-*open*: any host this function had never heard of, mainnet or not,
/// was trusted. Allowlisting loopback/private/link-local addresses and
/// `localhost` instead means an unrecognized public hostname is treated as
/// remote (no `fetch_root_key`) by default, which is the safe direction to
/// be wrong in.
fn is_local_replica(url: &str) -> bool {
    match host_of(url) {
        Some(host) => is_local_host(host),
        // A URL with no parseable host can't be a real mainnet endpoint
        // either; treated as local so `fetch_root_key` still runs rather
        // than silently skipping it.
        None => true,
    }
}

/// Whether `host` is `localhost` or an IP literal in a loopback, private,
/// or link-local range. A hostname that isn't `localhost` and doesn't parse
/// as an IP literal at all (any real DNS name, mainnet or not) is *not*
/// local — this is the allowlist half of `is_local_replica`'s fail-safe
/// design.
fn is_local_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
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
    fn the_cache_key_distinguishes_identities_within_one_environment() {
        assert_ne!(
            cache_key("local", "alice"),
            cache_key("local", "bob"),
            "two identities in one environment must not share an agent"
        );
        assert_ne!(
            cache_key("local", "alice"),
            cache_key("staging", "alice"),
            "one identity in two environments must not share an agent"
        );
        assert_eq!(cache_key("local", "alice"), cache_key("local", "alice"));
    }

    #[test]
    fn the_cache_key_cannot_be_confused_by_a_separator_in_a_name() {
        assert_ne!(
            cache_key("local:alice", "bob"),
            cache_key("local", "alice:bob"),
            "a name containing the separator must not collide with another pair"
        );
    }

    #[test]
    fn mainnet_boundary_hosts_are_not_local() {
        assert!(!is_local_replica("https://ic0.app"));
        assert!(!is_local_replica("https://ic0.app/"));
        assert!(!is_local_replica("https://icp-api.io"));
        // `icp0.io` is itself a canonical mainnet boundary host — the
        // review's finding — and was misclassified as local under the old
        // denylist (it matched neither `ic0.app` nor `icp-api.io`
        // literally). The fail-safe allowlist gets it right without
        // needing to know its name at all: it's a real DNS hostname, not
        // `localhost` or an IP literal, so it's simply not in the allowed
        // set.
        assert!(!is_local_replica("https://icp0.io"));
    }

    #[test]
    fn loopback_and_private_hosts_are_local() {
        assert!(is_local_replica("http://127.0.0.1:4943"));
        assert!(is_local_replica("http://localhost:8000"));
        assert!(
            is_local_replica("http://LOCALHOST:8000"),
            "localhost match is case-insensitive"
        );
        assert!(
            is_local_replica("http://192.168.1.10:4943"),
            "RFC 1918 private range is local"
        );
        assert!(
            is_local_replica("http://10.0.0.5:4943"),
            "RFC 1918 private range is local"
        );
    }

    /// `is_local_host`'s IPv6-loopback branch is exercised directly rather
    /// than through `is_local_replica`: `host_of`'s naive URL parsing (strip
    /// the scheme, cut at the next `/`, `:`, `?`, or `#`) predates this fix
    /// and doesn't understand bracketed IPv6 host literals (`http://[::1]`)
    /// — it would cut at the first colon *inside* the brackets. That's a
    /// pre-existing `host_of` limitation, not something this fail-safe
    /// rewrite introduces or is scoped to fix; every real `.icp/` replica
    /// URL this app has ever seen uses a plain IPv4 gateway ip.
    #[test]
    fn ipv6_loopback_literal_is_local() {
        assert!(is_local_host("::1"));
    }

    /// Enshrines the fix directly: a subdomain of a mainnet host is a real,
    /// resolvable DNS hostname — not `localhost`, not an IP literal — so
    /// the fail-safe allowlist correctly treats it as remote. The old
    /// denylist test asserted the opposite (`is_local_replica` returning
    /// `true` for it) as a *documented* consequence of matching only two
    /// exact hostnames; that was the fail-open behavior this fix removes.
    #[test]
    fn an_unrecognized_public_hostname_is_not_local() {
        assert!(!is_local_replica("https://boundary.icp-api.io"));
        assert!(!is_local_replica(
            "https://some-canister-gateway.example.com"
        ));
    }
}
