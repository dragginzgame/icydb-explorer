//! Discovers a canic-orchestrated fleet by walking `canic_canister_children`
//! from a root canister.
//!
//! `.icp/cache/mappings/*.ids.json` only ever names the root canister —
//! every other canister in a real fleet (hubs, shards, instances) is
//! created dynamically by canic at runtime, and their ids exist only in
//! root's live topology. So this walk is the only way to discover most of
//! a database's canisters; a flat or silently-empty result here would make
//! most of the database invisible to the user.

mod types;

pub use types::{CanicError, CanicPage, CanisterInfo, PageRequest, TreeNode};

use std::collections::{HashMap, HashSet};

use candid::{Decode, Encode, Principal};
use ic_agent::agent::AgentError;
use ic_agent::Agent;

use crate::error::AppError;

/// Assembles a flat list of `CanisterInfo` (gathered from possibly several
/// canisters' `canic_canister_children` calls) into a `TreeNode` rooted at
/// `root`.
///
/// Nodes are indexed by their declared `parent_pid` so each node's children
/// can be looked up directly rather than re-scanning the whole list at
/// every level. A node whose declared parent does not appear anywhere in
/// `infos` — including the documented case of a parent that failed to be
/// fetched — is attached directly under `root` instead of being dropped, so
/// it stays reachable in the UI. A visited-set guards the recursion: a
/// malformed topology (e.g. two canisters that declare each other as
/// parent) cannot walk the same pid twice, so the recursion always
/// terminates in at most `infos.len()` steps.
///
/// A self-parenting node, or a cluster of nodes that only ever parent each
/// other, forms a bucket that `root`'s own traversal never reaches — but
/// those pids are real, declared data, so after the root-rooted recursion
/// completes, anything still left in `children_of` is swept and attached
/// under `root` too (see the comment at the sweep below). Dropping them
/// instead would silently vanish a canister the fleet walk actually
/// returned, which is exactly the "invisible database" failure this module
/// exists to avoid — the same reasoning that makes an absent-parent orphan
/// attach to root applies equally to a present-but-unplaceable one.
pub fn build_tree(root: &str, infos: Vec<CanisterInfo>) -> TreeNode {
    let known: HashSet<String> = infos.iter().map(|info| info.pid.to_text()).collect();

    let mut children_of: HashMap<String, Vec<CanisterInfo>> = HashMap::new();
    for info in infos {
        let parent_key = match &info.parent_pid {
            // A declared parent that isn't in the list at all (including
            // "no parent") is treated as a child of the root, so it stays
            // reachable instead of vanishing.
            Some(parent) if known.contains(&parent.to_text()) => parent.to_text(),
            _ => root.to_string(),
        };
        children_of.entry(parent_key).or_default().push(info);
    }

    let mut visited = HashSet::new();
    visited.insert(root.to_string());

    let mut children = build_children(root, &mut children_of, &mut visited);

    // Anything still keyed in `children_of` at this point was never reached
    // from `root`: a self-parenting node, or a cycle of nodes that only
    // point at each other. Sweep every leftover bucket and attach it under
    // root too, reusing the same recursion and the same `visited` set —
    // termination is unaffected (each key is still consumed by `remove` at
    // most once) and every pid still appears exactly once. A cycle ends up
    // presented as a chain rooted at whichever pid the sweep reaches first,
    // rather than vanishing.
    let leftover_keys: Vec<String> = children_of.keys().cloned().collect();
    for key in leftover_keys {
        children.extend(build_children(&key, &mut children_of, &mut visited));
    }

    TreeNode {
        pid: root.to_string(),
        role: "root".to_string(),
        children,
    }
}

/// Recursively builds the child list for `parent_pid`, removing consumed
/// entries from `children_of` and recording each visited pid in `visited`
/// so a cycle (a node reachable as its own descendant) is only ever
/// expanded once — the second visit finds `children_of` already emptied
/// for that pid and returns no further children.
fn build_children(
    parent_pid: &str,
    children_of: &mut HashMap<String, Vec<CanisterInfo>>,
    visited: &mut HashSet<String>,
) -> Vec<TreeNode> {
    let Some(entries) = children_of.remove(parent_pid) else {
        return Vec::new();
    };

    entries
        .into_iter()
        .filter_map(|info| {
            let pid = info.pid.to_text();
            if !visited.insert(pid.clone()) {
                // Already visited on this walk: a cycle. Drop it rather
                // than recursing again.
                return None;
            }
            let children = build_children(&pid, children_of, visited);
            Some(TreeNode { pid, role: info.role, children })
        })
        .collect()
}

/// Fetches the full set of descendants of `canister` by walking
/// `canic_canister_children`, paging each canister's direct children to
/// exhaustion and recursing into every child found (the endpoint reports
/// only direct children, so a full fleet requires recursion).
///
/// A canister that has no `canic_*` endpoints at all is a leaf, not an
/// error — plenty of canisters in a fleet are not canic-orchestrated. A
/// canister that does expose the endpoint but whose call fails for any
/// other reason (a genuine `CanicError`, a transport failure, a decode
/// failure) is a real error and is surfaced as `AppError::Agent`, not
/// swallowed.
pub async fn fetch_children(agent: &Agent, canister: Principal) -> Result<Vec<CanisterInfo>, AppError> {
    let mut visited = HashSet::new();
    visited.insert(canister);
    fetch_descendants(agent, canister, &mut visited).await
}

async fn fetch_descendants(
    agent: &Agent,
    canister: Principal,
    visited: &mut HashSet<Principal>,
) -> Result<Vec<CanisterInfo>, AppError> {
    let direct = match fetch_direct_children(agent, canister).await? {
        Some(children) => children,
        // No canic_* endpoints on this canister: a leaf, not an error.
        None => return Ok(Vec::new()),
    };

    let mut all = Vec::new();
    for child in direct {
        if !visited.insert(child.pid) {
            // Already walked this pid on this fleet-wide traversal: a
            // cycle (or a diamond reached via two different parents).
            // Record the child itself but do not recurse into it again.
            all.push(child);
            continue;
        }
        let grandchildren = Box::pin(fetch_descendants(agent, child.pid, visited)).await?;
        all.push(child);
        all.extend(grandchildren);
    }

    Ok(all)
}

/// Pages through `canister`'s direct children via `canic_canister_children`
/// until `offset >= total`, accumulating `entries` along the way.
///
/// Returns `Ok(None)` when `canister` has no `canic_canister_children`
/// method at all (the documented leaf case). Returns `Err` for every other
/// failure: a transport error, a reject for a reason other than "method
/// not found", a `CanicError` returned by the canister itself, or a decode
/// failure.
async fn fetch_direct_children(
    agent: &Agent,
    canister: Principal,
) -> Result<Option<Vec<CanisterInfo>>, AppError> {
    const LIMIT: u64 = 100;
    let mut offset = 0u64;
    let mut entries = Vec::new();

    loop {
        let request = PageRequest { offset, limit: LIMIT };
        let arg = Encode!(&request).map_err(|e| AppError::Parse(e.to_string()))?;

        let bytes = match agent
            .query(&canister, "canic_canister_children")
            .with_arg(arg)
            .call()
            .await
        {
            Ok(bytes) => bytes,
            Err(e) => {
                return if is_no_canic_endpoint(&e) {
                    Ok(None)
                } else {
                    Err(AppError::Agent(e.to_string()))
                };
            }
        };

        let page = Decode!(bytes.as_slice(), Result<CanicPage, CanicError>)
            .map_err(|e| AppError::Parse(e.to_string()))?
            .map_err(|e| AppError::Agent(e.message))?;

        let got = page.entries.len() as u64;
        entries.extend(page.entries);
        offset += got;

        if offset >= page.total || got == 0 {
            break;
        }
    }

    Ok(Some(entries))
}

/// Distinguishes "this canister has no `canic_canister_children` method"
/// (a leaf, expected for any non-canic-orchestrated canister) from every
/// other agent failure (a real error).
///
/// The IC's reject message for calling an undeclared method names the
/// method, e.g. `"...has no query method 'canic_canister_children'"` — the
/// same shape and the same reject-message-based classification
/// `sql/transport.rs` uses to recognise a missing `icydb_query`. Query
/// calls are not certified by default, so this arrives as
/// `UncertifiedReject` in practice, but `CertifiedReject` is matched too
/// for robustness.
fn is_no_canic_endpoint(error: &AgentError) -> bool {
    match error {
        AgentError::CertifiedReject { reject, .. }
        | AgentError::UncertifiedReject { reject, .. } => reject
            .reject_message
            .contains("has no query method 'canic_canister_children'"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use ic_agent::agent::{RejectCode, RejectResponse};

    fn reject(message: &str) -> AgentError {
        AgentError::UncertifiedReject {
            reject: RejectResponse {
                reject_code: RejectCode::DestinationInvalid,
                reject_message: message.to_string(),
                error_code: None,
            },
            operation: None,
        }
    }

    #[test]
    fn missing_canic_method_is_classified_as_no_endpoint() {
        let error = reject("IC0302: Canister has no query method 'canic_canister_children'");
        assert!(is_no_canic_endpoint(&error));
    }

    #[test]
    fn a_different_reject_reason_is_not_classified_as_no_endpoint() {
        let error = reject("IC0515: canister trapped: some other failure");
        assert!(!is_no_canic_endpoint(&error));
    }

    #[test]
    fn non_reject_agent_errors_are_not_classified_as_no_endpoint() {
        let error = AgentError::TimeoutWaitingForResponse();
        assert!(!is_no_canic_endpoint(&error));
    }

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    fn info(pid: u8, role: &str, parent: Option<u8>) -> CanisterInfo {
        CanisterInfo {
            pid: principal(pid),
            role: role.into(),
            created_at: 0,
            module_hash: None,
            parent_pid: parent.map(principal),
        }
    }

    #[test]
    fn nests_children_under_their_parent() {
        let infos = vec![
            info(2, "user_hub", Some(1)),
            info(3, "user_shard", Some(2)),
        ];
        let tree = build_tree(&principal(1).to_text(), infos);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].role, "user_hub");
        assert_eq!(tree.children[0].children[0].role, "user_shard");
    }

    #[test]
    fn attaches_parentless_canisters_to_the_root() {
        let tree = build_tree(&principal(1).to_text(), vec![info(9, "orphan", None)]);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].role, "orphan");
    }

    #[test]
    fn tolerates_a_parent_that_is_not_in_the_list() {
        let tree = build_tree(&principal(1).to_text(), vec![info(9, "stray", Some(77))]);
        assert_eq!(tree.children.len(), 1, "stray should still be reachable");
    }

    #[test]
    fn empty_input_yields_a_root_with_no_children() {
        let tree = build_tree(&principal(1).to_text(), vec![]);
        assert_eq!(tree.role, "root");
        assert!(tree.children.is_empty());
    }

    /// Walks every pid in `node`'s subtree (including `node` itself), depth
    /// first, so a test can assert both that a pid is present and that it
    /// isn't duplicated.
    fn collect_pids(node: &TreeNode) -> Vec<String> {
        let mut pids = vec![node.pid.clone()];
        for child in &node.children {
            pids.extend(collect_pids(child));
        }
        pids
    }

    #[test]
    fn a_self_parenting_canister_terminates_and_stays_reachable() {
        // pid 9 declares itself as its own parent. Root's traversal never
        // reaches it (nothing under root points at it), so without the
        // sweep it would silently vanish; if the cycle guard were broken,
        // building this tree would hang instead of returning.
        let tree = build_tree(&principal(1).to_text(), vec![info(9, "loopy", Some(9))]);

        let pids = collect_pids(&tree);
        let loopy = principal(9).to_text();
        assert_eq!(
            pids.iter().filter(|pid| **pid == loopy).count(),
            1,
            "the self-parenting node should appear exactly once, got: {pids:?}"
        );
    }

    #[test]
    fn a_mutually_parenting_pair_terminates_and_both_stay_reachable() {
        // pid 10 declares pid 11 as parent and vice versa: a two-node cycle
        // disconnected from root. Both must still surface under root
        // exactly once each, not vanish and not duplicate.
        let infos = vec![info(10, "a", Some(11)), info(11, "b", Some(10))];
        let tree = build_tree(&principal(1).to_text(), infos);

        let pids = collect_pids(&tree);
        let a = principal(10).to_text();
        let b = principal(11).to_text();
        assert_eq!(pids.iter().filter(|pid| **pid == a).count(), 1, "pid 10 should appear exactly once, got: {pids:?}");
        assert_eq!(pids.iter().filter(|pid| **pid == b).count(), 1, "pid 11 should appear exactly once, got: {pids:?}");
    }
}
