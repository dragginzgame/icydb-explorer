//! Turns a discovered `Environment` into a usable `ic_agent::Agent`.
//!
//! Building an agent means loading an identity (pem from disk, or a keyring
//! export) and — for local replicas only — an extra network round-trip to
//! fetch the root key. Neither is something callers should repeat on every
//! query, so `AgentPool` builds one `Agent` per `(project root, environment,
//! identity)` triple and reuses it. The project root is part of the key, not
//! just the environment and identity names, because two different projects
//! commonly declare a `local` environment with a `default` identity — an
//! agent built for one project's replica must never be handed to another
//! project's queries (see `cache_key`'s doc comment).

mod export;
mod identity;

// `export::export_pem` has no consumer outside `agent` — `identity.rs` calls
// it via `crate::agent::export::export_pem`, not through a re-export here —
// so it stays unexported. Re-exporting a function that returns raw PEM
// bytes would widen the very boundary `export.rs`'s module doc claims to
// hold (private key material never leaves this module except as the bytes
// its one legitimate caller needs).
pub use identity::load_identity;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use ic_agent::Agent;
use tokio::sync::Mutex;

use crate::discovery::{Environment, IdentityRef};
use crate::error::AppError;

/// Caches one `ic_agent::Agent` per `(project root, Environment::name,
/// IdentityRef::name)` triple — see `cache_key`. The root is part of the key
/// (not merely a redundant scoping detail) because two different projects
/// can each declare an environment and identity with the same names; without
/// the root in the key, a command for one project could be served an agent
/// built for another project's replica.
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

    /// Returns the cached agent for `(root, env, identity)`, building and
    /// caching one on a miss.
    ///
    /// Keyed by `root`, `env`, and `identity` together (see `cache_key`)
    /// rather than by environment and identity alone: once identity is
    /// user-selectable, a cache keyed only on the environment name would
    /// silently keep returning the first identity's agent for every later
    /// selection — the UI would show one identity while queries ran as
    /// another. The project root is in the key for a second, independent
    /// reason: two different projects can each declare a `local` environment
    /// with a `default` identity, and a command that snapshotted one project
    /// must never be served an agent built for another's replica — see
    /// `cache_key`'s doc comment for the exact interleaving this prevents.
    ///
    /// For local replicas (loopback/localhost/private-network hosts — see
    /// `is_local_replica`), this also calls `fetch_root_key`, since a local
    /// replica's root key is unknown to the agent until fetched. A failure
    /// there — the single most likely failure in daily use of this tool —
    /// is reported as `AppError::ReplicaUnreachable` naming the URL, not a
    /// generic agent error, so that someone whose replica isn't running can
    /// tell what's wrong at a glance.
    ///
    /// The pool-wide lock is held only for the cache-hit check and the final
    /// insert — never across `load_identity` or `fetch_root_key`. It used to
    /// be held across both, which was harmless while `load_identity` was a
    /// microsecond `fs::read`, but keyring identities now shell out to `icp
    /// identity export` under a 20-second timeout (see `export.rs`): holding
    /// a pool-wide lock across that would stall every other in-flight
    /// command in the app for up to 20 seconds whenever anyone selected a
    /// password-protected identity. Building the agent (and, for local
    /// replicas, fetching the root key) now happens with the lock released,
    /// so a slow or stuck build for one `(env, identity)` pair never blocks
    /// lookups or builds for any other pair, or even a second concurrent
    /// call for the *same* pair. The trade-off: two callers racing to build
    /// the same never-yet-cached pair for the first time can each build a
    /// redundant `Agent` before the second one's insert loses to `entry`'s
    /// `or_insert_with` and its extra `Agent` is simply dropped. That's an
    /// acceptable, rare cost (one extra identity load, once, ever, per
    /// pair) — a world away from a 20-second app-wide freeze.
    pub async fn get(
        &self,
        root: &Path,
        env: &Environment,
        identity: &IdentityRef,
    ) -> Result<Arc<Agent>, AppError> {
        let key = cache_key(root, &env.name, &identity.name);

        {
            let agents = self.agents.lock().await;
            if let Some(agent) = agents.get(&key) {
                return Ok(Arc::clone(agent));
            }
        }

        // Lock released for the slow part: `load_identity` may shell out to
        // `icp identity export` (up to `EXPORT_TIMEOUT`), and `fetch_root_key`
        // below is a network round trip. Neither should be able to block an
        // unrelated `(env, identity)` pair's lookup.
        let boxed_identity = load_identity(identity).await?;

        let agent = Agent::builder()
            .with_url(&env.replica_url)
            .with_boxed_identity(boxed_identity)
            .build()
            .map_err(|e| AppError::Agent(e.to_string()))?;

        // Local-only, as before: `fetch_root_key` must run for local
        // replicas (their root key isn't known to the agent until fetched)
        // and must not run against mainnet. Unchanged by the locking
        // rework — still gated on `is_local_replica`, and a failure here is
        // still reported as `AppError::ReplicaUnreachable` naming the URL,
        // not a generic agent error.
        if is_local_replica(&env.replica_url) {
            agent
                .fetch_root_key()
                .await
                .map_err(|_| AppError::ReplicaUnreachable {
                    url: env.replica_url.clone(),
                })?;
        }

        let agent = Arc::new(agent);

        // Re-acquire only to insert. If another caller already built and
        // inserted the same pair while this one was building (the race
        // described above), `entry().or_insert_with` keeps the winner's
        // `Agent` and this call's fresh one is dropped — every caller still
        // ends up with the single cached `Arc<Agent>` for this pair from
        // this point on.
        let mut agents = self.agents.lock().await;
        let cached = agents.entry(key).or_insert_with(|| Arc::clone(&agent));
        Ok(Arc::clone(cached))
    }

    /// Drops every cached agent. Called when the open project changes.
    ///
    /// This is **retention hygiene, not correctness**. Correctness comes from
    /// `cache_key` including the project root: a command that snapshotted the
    /// previous project and finishes after the switch inserts under that
    /// project's key, where the new project will never look it up. Clearing
    /// alone could not provide that guarantee, because such a late insert
    /// happens *after* the clear has already run.
    ///
    /// What clearing does provide is that the pool stops holding agents — and
    /// the private key material inside them — for projects the user has
    /// walked away from. The cost is that switching back re-loads identities,
    /// which may re-prompt the OS keychain.
    pub async fn clear(&self) {
        self.agents.lock().await.clear();
    }
}

/// A collision-free key for one `(project, environment, identity)` triple.
///
/// Every component is length-prefixed so no arrangement of `:` inside a
/// path, environment name, or identity name can make two different triples
/// produce the same key.
///
/// The **project root** is part of the key because clearing the pool on a
/// project switch is not sufficient on its own. Commands snapshot the open
/// project and *then* await network calls, so a command that began before a
/// switch can finish after it and insert an agent built for the previous
/// project — under a key the new project would otherwise look up. Keying by
/// root means such a late insert lands where only the project it belongs to
/// can find it.
fn cache_key(root: &Path, env: &str, identity: &str) -> String {
    // `to_string_lossy` is not injective: two roots differing only in
    // invalid UTF-8 bytes of equal length both render as the same `U+FFFD`
    // replacement-character sequence, which would make two different
    // projects' roots collide in the cache key — precisely the guarantee
    // this function exists to provide. Hex-encoding `OsStr::as_encoded_bytes`
    // (stable since Rust 1.74) instead is injective: two `OsStr`s are equal
    // iff their encoded bytes are equal, and no two distinct byte sequences
    // produce the same hex string. The length
    // prefix is still the raw byte count (not the hex string's length),
    // keeping the same length-prefixed scheme as `env` and `identity` below.
    let root_bytes = root.as_os_str().as_encoded_bytes();
    let mut root_hex = String::with_capacity(root_bytes.len() * 2);
    for byte in root_bytes {
        root_hex.push_str(&format!("{byte:02x}"));
    }
    format!(
        "{}:{root_hex}:{}:{env}:{}:{identity}",
        root_bytes.len(),
        env.len(),
        identity.len()
    )
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
        let root = Path::new("/projects/demo");
        assert_ne!(
            cache_key(root, "local", "alice"),
            cache_key(root, "local", "bob"),
            "two identities in one environment must not share an agent"
        );
        assert_ne!(
            cache_key(root, "local", "alice"),
            cache_key(root, "staging", "alice"),
            "one identity in two environments must not share an agent"
        );
        assert_eq!(
            cache_key(root, "local", "alice"),
            cache_key(root, "local", "alice")
        );
    }

    #[test]
    fn the_cache_key_cannot_be_confused_by_a_separator_in_a_name() {
        let root = Path::new("/projects/demo");
        assert_ne!(
            cache_key(root, "local:alice", "bob"),
            cache_key(root, "local", "alice:bob"),
            "a name containing the separator must not collide with another pair"
        );
    }

    /// Two projects that each declare a `local` environment with a `default`
    /// identity are the normal case, not an edge case, so the project root
    /// must be part of the key. Without it, an agent built for one project's
    /// replica can be served to another project's queries — see this task's
    /// "load-bearing correctness point" note for the exact interleaving.
    #[test]
    fn the_cache_key_distinguishes_projects_with_identical_env_and_identity() {
        let a = cache_key(Path::new("/projects/alpha"), "local", "default");
        let b = cache_key(Path::new("/projects/beta"), "local", "default");
        assert_ne!(a, b);
    }

    /// The length prefixes exist so no combination of separator characters
    /// inside a root, environment, or identity name can make two different
    /// triples collide. This pair is chosen to actually collide under naive
    /// `format!("{root}:{env}:{identity}")` concatenation — both render as
    /// `/p:local:default:x` — so the test exercises the guarantee it claims
    /// to check, rather than merely asserting two strings that were never
    /// going to be equal in the first place.
    #[test]
    fn the_cache_key_cannot_be_confused_by_a_separator_in_a_root() {
        let a = cache_key(Path::new("/p:local"), "default", "x");
        let b = cache_key(Path::new("/p"), "local:default", "x");
        assert_ne!(a, b);
    }

    /// `to_string_lossy` is not injective: two different byte sequences of
    /// equal length, each containing invalid UTF-8, can both render as the
    /// same `U+FFFD` replacement-character run. Hex-encoding
    /// `as_encoded_bytes` must keep such roots distinct where a lossy
    /// stringification would have collapsed them.
    #[cfg(unix)]
    #[test]
    fn roots_differing_only_in_invalid_utf8_bytes_still_produce_distinct_keys() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        // Both are invalid UTF-8 (a lone continuation byte), both the same
        // length, and both would lossily stringify to "/p/\u{FFFD}".
        let a = Path::new(OsStr::from_bytes(b"/p/\x80"));
        let b = Path::new(OsStr::from_bytes(b"/p/\x81"));
        assert_ne!(a.as_os_str(), b.as_os_str());

        assert_ne!(
            cache_key(a, "local", "default"),
            cache_key(b, "local", "default")
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

    /// Switching projects drops every cached agent. Correctness no longer
    /// rests on this — `cache_key` includes the project root, so a stale
    /// entry can never be served to a different project — but retention
    /// hygiene does: without it the pool keeps agents, and the private key
    /// material they hold, for projects the user has walked away from.
    #[tokio::test]
    async fn clear_empties_the_cache() {
        // `AgentBuilder::build` defaults the identity to anonymous and makes
        // no network call (`ic-agent-0.48`'s `build` is just
        // `Agent::new(self.config)`), so two throwaway agents cost nothing
        // and need no replica.
        fn agent() -> Agent {
            Agent::builder()
                .with_url("http://127.0.0.1:4943")
                .build()
                .expect("an agent with no identity should build")
        }

        let pool = AgentPool::new();
        {
            let mut agents = pool.agents.lock().await;
            agents.insert("project-a-local-default".to_string(), Arc::new(agent()));
            agents.insert("project-b-local-default".to_string(), Arc::new(agent()));
            assert_eq!(agents.len(), 2, "both entries should be cached");
        }

        pool.clear().await;

        assert!(
            pool.agents.lock().await.is_empty(),
            "clear() must remove every cached agent, not just the current environment's"
        );
    }
}
