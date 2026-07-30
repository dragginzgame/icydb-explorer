use crate::error::AppError;

use super::types::{CanisterArtifact, Environment, IdentityRef, NamedCanister, Project};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Read a project's `.icp/` layout and build up its `Project` description:
/// which environments (networks) exist, what replica each points at, the
/// named canisters deployed to it (a forest of mapping entries, not a
/// single root — see `types::Environment`), the default identity, and the
/// canister artifacts (`.did` files) available locally.
///
/// **The layout varies between projects.** icp-cli's own project-local
/// `cli-home/` (identities, port-descriptors) is present in some projects
/// (verified against `dragginz/toko`) and entirely absent in others
/// (verified against this repo, whose `.icp/` has only `cache/`). Both
/// shapes are handled here: `.icp/cache/networks/<network>/descriptor.json`
/// is the primary source of an environment's replica URL, with
/// `.icp/cli-home/port-descriptors/*.json` as a fallback for networks not
/// already found that way; identity resolution likewise prefers a
/// project-local `cli-home/identity/` store and falls back to the
/// user-level one icp-cli keeps outside any project.
pub fn discover(project_root: &Path) -> Result<Project, AppError> {
    let icp_dir = project_root.join(".icp");
    if !icp_dir.is_dir() {
        return Err(AppError::Io(format!(
            "{} is not a directory; expected an .icp project layout at {}",
            icp_dir.display(),
            project_root.display()
        )));
    }

    let identity = read_default_identity(&icp_dir)?;
    let identities = read_all_identities_for_project(&icp_dir)?;
    let networks = read_networks(&icp_dir)?;
    // Only allow `read_canisters`'s "just use the only mapping file, whatever
    // it's named" fallback when there is exactly one network in this
    // project. With several networks and only one mapping file that
    // matches none of them by name, there is no way to tell which network
    // that file belongs to — guessing would risk attaching one network's
    // canisters to another, which is worse than the honest "no canisters
    // found yet" this falls back to instead. See `read_canisters`'s doc
    // comment for why the fallback exists at all.
    let allow_mapping_fallback = networks.len() == 1;

    let mut environments = Vec::with_capacity(networks.len());
    for network in networks {
        let canisters = read_canisters(&icp_dir, &network.name, allow_mapping_fallback)?;
        let artifacts = read_artifacts(&icp_dir, &network.name)?;
        environments.push(Environment {
            name: network.name,
            replica_url: network.replica_url,
            canisters,
            identity: identity.clone(),
            identities: identities.clone(),
            artifacts,
        });
    }

    Ok(Project {
        root: project_root.to_path_buf(),
        environments,
        error: None,
    })
}

/// Parse a JSON file, mapping any IO failure to `AppError::Io` and any
/// malformed-JSON failure to `AppError::Parse`.
fn read_json(path: &Path) -> Result<Value, AppError> {
    let text = fs::read_to_string(path)
        .map_err(|e| AppError::Io(format!("failed to read {}: {e}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::Parse(format!("failed to parse {} as JSON: {e}", path.display())))
}

/// List the entries of a directory, treating a missing directory as "no
/// entries" rather than an error (a project need not have deployed
/// canisters, custom ports, or identities yet). Any other IO failure
/// (permissions, etc) is propagated.
fn list_dir(dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let read_dir = match fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::Io(format!(
                "failed to read {}: {e}",
                dir.display()
            )))
        }
    };

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry
            .map_err(|e| AppError::Io(format!("failed to read entry in {}: {e}", dir.display())))?;
        entries.push(entry.path());
    }
    entries.sort();
    Ok(entries)
}

/// One network's replica connection details, parsed from either a
/// `cache/networks/<network>/descriptor.json` or a
/// `cli-home/port-descriptors/<port>.json` file — both carry the same JSON
/// shape (`network`, `gateway.{ip,port}`).
struct NetworkDescriptor {
    name: String,
    replica_url: String,
}

/// Finds every environment (network) this project's `.icp/` layout
/// declares.
///
/// Primary source: one `descriptor.json` per subdirectory of
/// `.icp/cache/networks/`, keyed by the network name recorded inside it (in
/// practice, also the subdirectory's own name). Fallback:
/// `.icp/cli-home/port-descriptors/*.json`, same shape, used only for
/// networks not already found via the primary source — `cli-home/` is
/// present in some projects (toko) and absent in others (this repo).
fn read_networks(icp_dir: &Path) -> Result<Vec<NetworkDescriptor>, AppError> {
    let mut networks = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let cache_networks_dir = icp_dir.join("cache").join("networks");
    for entry in list_dir(&cache_networks_dir)? {
        if !entry.is_dir() {
            continue;
        }
        let descriptor_path = entry.join("descriptor.json");
        if !descriptor_path.is_file() {
            continue;
        }
        let descriptor = parse_descriptor(&descriptor_path)?;
        seen.insert(descriptor.name.clone());
        networks.push(descriptor);
    }

    let port_descriptors_dir = icp_dir.join("cli-home").join("port-descriptors");
    for path in list_dir(&port_descriptors_dir)? {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let descriptor = parse_descriptor(&path)?;
        if seen.insert(descriptor.name.clone()) {
            networks.push(descriptor);
        }
    }

    networks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(networks)
}

/// Parses the JSON shape shared by `cache/networks/<network>/descriptor.json`
/// and `cli-home/port-descriptors/<port>.json`: `network` (string) and
/// `gateway.{ip,port}`.
fn parse_descriptor(path: &Path) -> Result<NetworkDescriptor, AppError> {
    let value = read_json(path)?;
    let name = value
        .get("network")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing a \"network\" string field",
                path.display()
            ))
        })?
        .to_string();

    let gateway = value.get("gateway").ok_or_else(|| {
        AppError::Parse(format!(
            "{} is missing a \"gateway\" object",
            path.display()
        ))
    })?;
    let ip = gateway.get("ip").and_then(Value::as_str).ok_or_else(|| {
        AppError::Parse(format!(
            "{} gateway is missing an \"ip\" string field",
            path.display()
        ))
    })?;
    let port = gateway.get("port").and_then(Value::as_u64).ok_or_else(|| {
        AppError::Parse(format!(
            "{} gateway is missing a \"port\" number field",
            path.display()
        ))
    })?;

    Ok(NetworkDescriptor {
        name,
        replica_url: format!("http://{ip}:{port}"),
    })
}

/// Reads a `.icp/cache/mappings/*.ids.json` file as the name→canister-id
/// map it is: every entry is a distinct named canister (a forest of tree
/// roots — see `types::Environment`'s doc comment), not a single hardcoded
/// `root`. A project with no mapping file yet (undeployed) yields an empty
/// list rather than an error.
///
/// **The mapping filename's own naming convention is not fully settled.**
/// This repo's real mapping file is `local.ids.json` — keyed by the
/// *network* name, as this app's design intends. But a real `dragginz/toko`
/// checkout's mapping file is `toko.ids.json` — keyed by the *project
/// directory name* (`toko`), even though its network is also `local`,
/// directly contradicting a network-name-only rule. Nothing else in either
/// tree (no `icp.yaml` field, no descriptor value) explains the difference;
/// the most likely cause is a naming-convention change across icp-cli
/// versions between when each `.icp/` was created, but that could not be
/// confirmed. So this tries `<network>.ids.json` first, and — since every
/// real project observed so far has exactly one mapping file regardless of
/// what it's named — falls back to the lexicographically-first
/// `*.ids.json` file in the mappings directory if that exact name isn't
/// there — but *only* when `allow_fallback` says this is safe (the caller
/// passes `true` only when the project has exactly one network at all, so
/// there's no ambiguity about which network a misnamed lone mapping file
/// belongs to). A project with several genuinely distinct mapping files and
/// no exact network-name match would see none of them via the fallback;
/// that's a real limitation, disclosed rather than silently resolved by a
/// guess that happens to work for both known trees but would misattribute
/// canisters in a multi-network project.
fn read_canisters(
    icp_dir: &Path,
    network: &str,
    allow_fallback: bool,
) -> Result<Vec<NamedCanister>, AppError> {
    let mappings_dir = icp_dir.join("cache").join("mappings");
    let exact = mappings_dir.join(format!("{network}.ids.json"));

    let path = if exact.is_file() {
        exact
    } else if allow_fallback {
        let mut candidates: Vec<PathBuf> = list_dir(&mappings_dir)?
            .into_iter()
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".ids.json"))
            })
            .collect();
        candidates.sort();
        match candidates.into_iter().next() {
            Some(path) => path,
            None => return Ok(Vec::new()),
        }
    } else {
        return Ok(Vec::new());
    };

    let value = read_json(&path)?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Parse(format!("{} is not a JSON object", path.display())))?;

    let mut canisters: Vec<NamedCanister> = object
        .iter()
        .filter_map(|(name, id)| {
            id.as_str().map(|id| NamedCanister {
                name: name.clone(),
                id: id.to_string(),
            })
        })
        .collect();
    canisters.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(canisters)
}

/// Resolves which identity store this project's identities come from.
///
/// Prefers a project-local `.icp/cli-home/identity/` store when present
/// (verified against toko); falls back to icp-cli's user-level store
/// (`~/Library/Application Support/org.dfinity.icp-cli/identity/` on
/// macOS, derived from `$HOME` rather than hardcoded) when no project-local
/// store exists (this repo's actual shape). `None` when neither exists — a
/// project need not have deployed anything yet.
///
/// Both `read_default_identity` and `read_all_identities_for_project`
/// resolve through this one function, so the default identity and the full
/// identity list can never come from two different stores.
fn resolve_identity_store(icp_dir: &Path) -> Option<PathBuf> {
    let project_local = icp_dir.join("cli-home").join("identity");
    if identity_store_present(&project_local) {
        return Some(project_local);
    }

    let user_level = user_level_identity_dir()?;
    if identity_store_present(&user_level) {
        return Some(user_level);
    }

    None
}

/// Resolves the default identity to use across this project's environments.
/// See `resolve_identity_store` for which store this reads from.
fn read_default_identity(icp_dir: &Path) -> Result<Option<IdentityRef>, AppError> {
    match resolve_identity_store(icp_dir) {
        Some(store) => read_identity_from_store(&store),
        None => Ok(None),
    }
}

/// icp-cli's user-level identity store: the one this app falls back to when
/// no project-local `cli-home/identity/` exists (see `resolve_identity_store`
/// above). Unlike that internal resolver, this always resolves to the
/// user-level store specifically (never a project-local one) and reports an
/// error rather than `None` when it isn't actually present — added for
/// `tests/integration.rs`'s live export test, which needs to know
/// definitively whether *the* real store this machine's `icp` CLI uses
/// exists, not just "no project-local override was found".
pub fn user_level_identity_store() -> Result<PathBuf, AppError> {
    let dir = user_level_identity_dir().ok_or_else(|| {
        AppError::Io(
            "no user-level icp identity store location is known on this platform".to_string(),
        )
    })?;
    if identity_store_present(&dir) {
        Ok(dir)
    } else {
        Err(AppError::Io(format!(
            "no icp identity store found at {} (missing identity_list.json or \
             identity_defaults.json)",
            dir.display()
        )))
    }
}

/// Reads just the configured default identity's *name* out of
/// `store/identity_defaults.json`, without resolving it against
/// `read_all_identities` the way `read_identity_from_store` does — split out
/// so a caller (the live export test) can read the name and look it up
/// itself, distinguishing "no default configured" from "default configured
/// but not found in the list" the same way `read_identity_from_store` does
/// internally.
pub fn read_default_identity_name(store: &Path) -> Result<String, AppError> {
    let defaults_path = store.join("identity_defaults.json");
    let defaults = read_json(&defaults_path)?;
    defaults
        .get("default")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing a \"default\" string field",
                defaults_path.display()
            ))
        })
}

/// Reads the `principal` recorded for identity `name` directly out of
/// `store/identity_list.json`, bypassing `IdentityRef` entirely.
///
/// Added for `tests/integration.rs`'s live export test, which needs
/// something to check an exported identity's *derived* principal against.
/// `IdentityRef` deliberately does not carry `principal` itself (see its doc
/// comment): the UI has no use for it, so widening that serialised type
/// would add surface with no consumer — a test-only reader here is
/// preferable.
pub fn recorded_principal(store: &Path, name: &str) -> Result<String, AppError> {
    let list_path = store.join("identity_list.json");
    let list = read_json(&list_path)?;
    list.get("identities")
        .and_then(Value::as_object)
        .and_then(|identities| identities.get(name))
        .and_then(|entry| entry.get("principal"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} records no \"principal\" for identity \"{name}\"",
                list_path.display()
            ))
        })
}

/// Reads every identity declared by the resolved store (see
/// `resolve_identity_store`), for `Environment::identities`. An unresolved
/// store (no identities configured yet) yields an empty list rather than an
/// error, matching `read_default_identity`'s degradation for the same case.
fn read_all_identities_for_project(icp_dir: &Path) -> Result<Vec<IdentityRef>, AppError> {
    match resolve_identity_store(icp_dir) {
        Some(store) => read_all_identities(&store),
        None => Ok(Vec::new()),
    }
}

fn identity_store_present(identity_dir: &Path) -> bool {
    identity_dir.join("identity_defaults.json").is_file()
        && identity_dir.join("identity_list.json").is_file()
}

/// icp-cli's own identity store, kept outside any project. Verified present
/// on this machine at exactly this path, with the same
/// `identity_defaults.json`/`identity_list.json` shape as a project-local
/// `cli-home/identity/` — but its default identity's `kind` was `"keyring"`,
/// not `"pem"` (this repo has no project-local identity at all, so this is
/// the path actually exercised for it). `IdentityRef` can represent a
/// keyring identity directly now (see `types::IdentityRef`), so this no
/// longer needs to be treated as "no identity to load".
#[cfg(target_os = "macos")]
fn user_level_identity_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("org.dfinity.icp-cli")
            .join("identity"),
    )
}

#[cfg(not(target_os = "macos"))]
fn user_level_identity_dir() -> Option<PathBuf> {
    // icp-cli's user-level store location on Linux/Windows was not
    // available to verify against a real installation; rather than guess
    // at a path, this app simply finds no user-level identity there. A
    // project-local `cli-home/identity/` still works on every platform.
    None
}

/// Builds one `IdentityRef` from its `identity_list.json` entry. Used by
/// both `read_all_identities` and `read_identity_from_store` so the two
/// cannot disagree about `kind` or `pem_path` — see `IdentityRef::new`,
/// which this always goes through.
///
/// `kind` is required: an entry with none is `AppError::Parse` naming the
/// identity. `algorithm` defaults to `"secp256k1"` when absent, since
/// `anonymous` entries carry no algorithm and must not fail the whole read.
/// `pem_path` is `Some(<identity_dir>/keys/<name>.pem)` only when
/// `kind == "pem"`.
fn identity_ref_from_entry(
    name: &str,
    entry: &Value,
    identity_dir: &Path,
) -> Result<IdentityRef, AppError> {
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Parse(format!("identity \"{name}\" is missing a \"kind\" field")))?
        .to_string();

    let algorithm = entry
        .get("algorithm")
        .and_then(Value::as_str)
        .unwrap_or("secp256k1")
        .to_string();

    let pem_path =
        (kind == "pem").then(|| identity_dir.join("keys").join(format!("{name}.pem")));

    Ok(IdentityRef::new(name.to_string(), algorithm, kind, pem_path))
}

/// Reads every identity `identity_dir/identity_list.json` declares, usable
/// or not — see `types::Environment::identities`. `name` is the map key;
/// see `identity_ref_from_entry` for how the rest of each entry converts.
/// Sorted by name for deterministic output, matching `read_networks` and
/// `read_canisters` in this file.
pub fn read_all_identities(identity_dir: &Path) -> Result<Vec<IdentityRef>, AppError> {
    let list_path = identity_dir.join("identity_list.json");
    let list = read_json(&list_path)?;
    let identities = list
        .get("identities")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing an \"identities\" object",
                list_path.display()
            ))
        })?;

    let mut result = Vec::with_capacity(identities.len());
    for (name, entry) in identities {
        result.push(identity_ref_from_entry(name, entry, identity_dir)?);
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Reads the default identity's name from `identity_dir/identity_defaults.json`
/// and finds it among `read_all_identities`'s entries — the same per-entry
/// conversion `read_all_identities` uses, so the default identity and the
/// full list can never disagree about `kind` or `pem_path`.
///
/// A default identity whose `kind` isn't `"pem"` (e.g. `"anonymous"`, or
/// icp-cli's user-level `"keyring"` default) now resolves to `Some` too,
/// with `unusable_reason` set rather than being hidden behind `None`:
/// `IdentityRef` can represent it honestly, so there is no reason left to
/// pretend it doesn't exist.
fn read_identity_from_store(identity_dir: &Path) -> Result<Option<IdentityRef>, AppError> {
    let default_name = read_default_identity_name(identity_dir)?;

    let identities = read_all_identities(identity_dir)?;
    match identities.into_iter().find(|i| i.name == default_name) {
        Some(identity) => Ok(Some(identity)),
        None => Err(AppError::Parse(format!(
            "{} names \"{default_name}\" as the default identity, but it is not listed in {}",
            identity_dir.join("identity_defaults.json").display(),
            identity_dir.join("identity_list.json").display()
        ))),
    }
}

/// Each subdirectory of `.icp/<env>/canisters/` is one locally built
/// canister artifact, named for its role, holding `<role>.did`. Not every
/// project builds per-role artifacts this way (this repo's fixture does
/// not), so a missing directory yields an empty list rather than an error.
fn read_artifacts(icp_dir: &Path, env_name: &str) -> Result<Vec<CanisterArtifact>, AppError> {
    let canisters_dir = icp_dir.join(env_name).join("canisters");

    let mut artifacts = Vec::new();
    for path in list_dir(&canisters_dir)? {
        if !path.is_dir() {
            continue;
        }
        let role = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        let did_path = path.join(format!("{role}.did"));
        artifacts.push(CanisterArtifact { role, did_path });
    }

    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// This repo's own real project layout: `.icp/cache/` only, no
    /// `cli-home/` at all. Modeled on it directly (not hand-authored to fit
    /// the code) — see `tests/fixtures/icp_project_no_cli_home/`.
    fn no_cli_home_fixture() -> Project {
        discover(Path::new("tests/fixtures/icp_project_no_cli_home"))
            .expect("discovery should succeed")
    }

    /// toko's real project layout: `cache/networks/<n>/descriptor.json`
    /// *and* a project-local `cli-home/` (port-descriptors + identity) —
    /// see `tests/fixtures/icp_project/`.
    fn with_cli_home_fixture() -> Project {
        discover(Path::new("tests/fixtures/icp_project")).expect("discovery should succeed")
    }

    #[test]
    fn finds_the_local_environment_with_no_cli_home() {
        let project = no_cli_home_fixture();
        let names: Vec<&str> = project
            .environments
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(names, vec!["local"]);
    }

    #[test]
    fn builds_replica_url_from_cache_networks_descriptor() {
        let env = &no_cli_home_fixture().environments[0];
        assert_eq!(env.replica_url, "http://127.0.0.1:4943");
    }

    #[test]
    fn reads_every_mapping_entry_with_no_hardcoded_root() {
        let env = &no_cli_home_fixture().environments[0];
        let names: Vec<&str> = env.canisters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["fixture"]);
        assert_eq!(env.canisters[0].id, "4caro-hl777-77775-aaaba-cai");
    }

    #[test]
    fn no_cli_home_means_no_error() {
        // Deliberately does NOT assert on `env.identity` here: this
        // fixture has no `cli-home/`, so `read_default_identity` falls
        // through to the *developer's real* user-level icp-cli store
        // (derived from `$HOME`), which this test does not and cannot
        // control. Reproduced live: with `HOME` pointed at any real store
        // (pem- or keyring-default), `env.identity` resolves `Some` — a
        // keyring default is now a representable, usable `IdentityRef` (see
        // `types::IdentityRef`), not the `None` an older version of this
        // code produced for it. With `HOME` unset or pointed at no store at
        // all, it resolves `None`. Any of these is correct behavior —
        // asserting a specific outcome here would make this test's result
        // depend on whoever runs it, not on this fixture. The two cases
        // that ARE fixture-controlled —
        // `keyring_default_identity_resolves_to_a_usable_identity_ref` and
        // `user_level_shaped_store_with_pem_identity_still_resolves` —
        // exercise `read_identity_from_store` directly against synthetic
        // stores instead, and are hermetic. This test only checks that
        // falling through to the user-level path (present or not) is not
        // itself an error.
        assert!(discover(Path::new("tests/fixtures/icp_project_no_cli_home")).is_ok());
    }

    #[test]
    fn with_cli_home_builds_replica_url_from_gateway() {
        let env = &with_cli_home_fixture().environments[0];
        assert_eq!(env.replica_url, "http://127.0.0.1:8000");
    }

    #[test]
    fn with_cli_home_reads_the_root_mapping_entry() {
        let env = &with_cli_home_fixture().environments[0];
        assert_eq!(env.canisters.len(), 1);
        assert_eq!(env.canisters[0].name, "root");
        assert_eq!(env.canisters[0].id, "igqk7-g3777-77774-qaaba-cai");
    }

    #[test]
    fn with_cli_home_resolves_default_identity_with_algorithm_and_pem_path() {
        let env = &with_cli_home_fixture().environments[0];
        let identity = env.identity.as_ref().expect("identity should resolve");
        assert_eq!(identity.name, "demo-local");
        assert_eq!(identity.algorithm, "secp256k1");
        assert!(identity
            .pem_path
            .as_ref()
            .expect("pem identity should have a pem_path")
            .ends_with("keys/demo-local.pem"));
    }

    /// The fixture's `staging` network exists only as
    /// `cli-home/port-descriptors/9000.json` — there is no matching
    /// `cache/networks/staging/descriptor.json` — so finding it proves the
    /// fallback source is actually consulted, not just the primary one.
    #[test]
    fn finds_a_network_known_only_via_the_port_descriptor_fallback() {
        let project = with_cli_home_fixture();
        let staging = project
            .environments
            .iter()
            .find(|e| e.name == "staging")
            .expect("staging network should be found via the port-descriptor fallback");
        assert_eq!(staging.replica_url, "http://127.0.0.1:9000");
        assert!(
            staging.canisters.is_empty(),
            "staging has no mapping file yet"
        );
    }

    #[test]
    fn with_cli_home_lists_canister_artifacts_by_role() {
        let env = &with_cli_home_fixture().environments[0];
        let mut roles: Vec<&str> = env.artifacts.iter().map(|a| a.role.as_str()).collect();
        roles.sort_unstable();
        assert_eq!(roles, vec!["root", "user_hub"]);
    }

    /// Models toko's real, observed shape directly (see `read_canisters`'s
    /// doc comment): a mapping file whose name matches neither the network
    /// nor any project directory name this test controls. The exact-match
    /// path (`<network>.ids.json`) misses, so this proves the
    /// lexicographic-first fallback is actually reached, not just declared.
    #[test]
    fn falls_back_to_the_only_mapping_file_when_its_name_does_not_match_the_network() {
        let project = discover(Path::new(
            "tests/fixtures/icp_project_mismatched_mapping_name",
        ))
        .expect("discovery should succeed");
        let env = &project.environments[0];
        assert_eq!(env.canisters.len(), 1);
        assert_eq!(env.canisters[0].name, "root");
        assert_eq!(env.canisters[0].id, "igqk7-g3777-77774-qaaba-cai");
    }

    #[test]
    fn missing_icp_directory_is_an_error_not_a_panic() {
        assert!(discover(Path::new("tests/fixtures/does_not_exist")).is_err());
    }

    /// A non-`"pem"` default identity (icp-cli's user-level `"keyring"`
    /// default here) now resolves to `Some` rather than `None`: the
    /// previous, pem-only-shaped `IdentityRef` had no way to represent a
    /// keyring identity, so `read_identity_from_store` used to hide it
    /// behind `None`. Now that `pem_path` is optional and `kind` is
    /// carried, a keyring identity is representable and — per
    /// `IdentityRef::new` — usable, so it surfaces honestly instead.
    #[test]
    fn keyring_default_identity_resolves_to_a_usable_identity_ref() {
        let dir = Path::new("tests/fixtures/identity_stores/keyring_default");
        assert!(identity_store_present(dir));
        let identity = read_identity_from_store(dir)
            .unwrap()
            .expect("keyring identity should resolve");
        assert_eq!(identity.kind, "keyring");
        assert!(
            identity.pem_path.is_none(),
            "keyring identities have no file"
        );
        assert!(identity.is_usable());
    }

    /// `read_identity_from_store` is the same function used for both a
    /// project-local `cli-home/identity/` and the user-level fallback store
    /// — this fixture models the user-level shape directly (no `keys/`
    /// subdirectory backing the keyring entry) to prove the fallback path
    /// works structurally without depending on this machine's real
    /// `$HOME`.
    #[test]
    fn user_level_shaped_store_with_pem_identity_still_resolves() {
        let dir = Path::new("tests/fixtures/identity_stores/pem_default");
        let identity = read_identity_from_store(dir)
            .unwrap()
            .expect("pem identity should resolve");
        assert_eq!(identity.name, "demo-local");
        assert_eq!(identity.algorithm, "secp256k1");
    }

    #[test]
    fn enumerates_every_identity_with_its_kind() {
        let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
        let identities = read_all_identities(store).expect("should read the store");
        let mut names: Vec<&str> = identities.iter().map(|i| i.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["anonymous", "future-kind", "keyring-one", "pem-one"]);
    }

    #[test]
    fn a_keyring_identity_has_a_kind_and_no_pem_path() {
        let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
        let identities = read_all_identities(store).unwrap();
        let keyring = identities.iter().find(|i| i.name == "keyring-one").unwrap();
        assert_eq!(keyring.kind, "keyring");
        assert_eq!(keyring.algorithm, "secp256k1");
        assert!(keyring.pem_path.is_none(), "keyring identities have no file");
        assert!(keyring.is_usable());
    }

    #[test]
    fn a_pem_identity_keeps_its_path() {
        let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
        let identities = read_all_identities(store).unwrap();
        let pem = identities.iter().find(|i| i.name == "pem-one").unwrap();
        assert_eq!(pem.kind, "pem");
        assert!(pem.pem_path.as_ref().unwrap().ends_with("keys/pem-one.pem"));
        assert!(pem.is_usable());
    }

    #[test]
    fn anonymous_is_unusable_because_endpoints_are_controller_gated() {
        let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
        let identities = read_all_identities(store).unwrap();
        let anonymous = identities.iter().find(|i| i.name == "anonymous").unwrap();
        assert!(!anonymous.is_usable());
        let reason = anonymous.unusable_reason.as_ref().expect("should give a reason");
        assert!(reason.contains("controller-gated"), "got: {reason}");
    }

    #[test]
    fn an_unrecognised_kind_is_unusable_and_names_itself() {
        let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
        let identities = read_all_identities(store).unwrap();
        let future = identities.iter().find(|i| i.name == "future-kind").unwrap();
        assert!(!future.is_usable());
        let reason = future.unusable_reason.as_ref().expect("should give a reason");
        assert!(reason.contains("delegation"), "should name the kind: {reason}");
    }
}
