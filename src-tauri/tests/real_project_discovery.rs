//! Verifies `discovery::discover` against real `.icp/` project trees on
//! disk — not fixtures authored to match the code's own assumptions, which
//! is exactly how the original discovery implementation survived thirteen
//! task reviews while reading a layout this project's own `.icp/` never
//! actually produces (see the design doc's "Discovery inputs" correction).
//!
//! Both tests are filesystem-only (no replica, no network) but are gated
//! behind `--ignored` anyway, because both depend on machine-local state
//! that is deliberately not committed to the repo:
//!   - `discovers_this_repos_own_icp_tree` needs this repo's own `.icp/`
//!     (gitignored — see `.gitignore`), created by actually deploying the
//!     fixture with `icp` (see README "Running the fixture end to end").
//!   - `discovers_a_toko_style_project_tree` needs `ICYDB_EXPLORER_TOKO_PROJECT_ROOT`
//!     pointed at a real `dragginz/toko` checkout with its own `.icp/`
//!     (present on this machine at deploy time, but obviously not a
//!     dependency of this repo).
//!
//! Run with:
//!   cargo test --test real_project_discovery -- --ignored

use std::path::{Path, PathBuf};

use icydb_explorer_lib::discovery::discover;

/// This crate's manifest lives at `<repo>/src-tauri`; its own `.icp/` is one
/// level up, at the repo root.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent directory")
        .to_path_buf()
}

/// Verifies discovery against **this repo's own real `.icp/` tree** — the
/// exact layout the headline finding identified as unhandled: no
/// `cli-home/` at all, `.icp/cache/networks/local/descriptor.json` as the
/// only environment source, and `.icp/cache/mappings/local.ids.json` keyed
/// by the *network* name (`local`), containing `{"fixture": <id>}` with no
/// `root` entry.
#[test]
#[ignore = "requires this repo's own .icp/ project state (machine-local, gitignored) to exist \
            — deploy the fixture per README \"Running the fixture end to end\" first"]
fn discovers_this_repos_own_icp_tree() {
    let project =
        discover(&repo_root()).expect("discovery should succeed against this repo's own .icp/");

    assert!(
        project.error.is_none(),
        "a successful discover() should carry no error, got {:?}",
        project.error
    );

    let local = project
        .environments
        .iter()
        .find(|e| e.name == "local")
        .unwrap_or_else(|| {
            panic!(
                "expected a \"local\" environment, got {:?}",
                project.environments
            )
        });

    assert_eq!(
        local.replica_url, "http://127.0.0.1:4943",
        "replica URL should come from cache/networks/local/descriptor.json's gateway"
    );

    let fixture = local
        .canisters
        .iter()
        .find(|c| c.name == "fixture")
        .unwrap_or_else(|| panic!("expected a \"fixture\" canister, got {:?}", local.canisters));
    assert_eq!(
        fixture.id, "4caro-hl777-77775-aaaba-cai",
        "should read the id straight out of local.ids.json, not a hardcoded \"root\" key"
    );
}

/// Verifies discovery against a **real toko checkout's `.icp/` tree** — the
/// other real shape (project-local `cli-home/`, `<network>.ids.json`
/// containing only a `root` entry). Both shapes must work; this is the
/// direct evidence that fixing the no-`cli-home/` case didn't break the
/// one the original implementation was built from.
#[test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a real dragginz/toko checkout \
            with its own deployed .icp/ state"]
fn discovers_a_toko_style_project_tree() {
    let root = std::env::var("ICYDB_EXPLORER_TOKO_PROJECT_ROOT")
        .expect("set ICYDB_EXPLORER_TOKO_PROJECT_ROOT to a toko checkout's root directory");

    let project =
        discover(Path::new(&root)).expect("discovery should succeed against a real toko .icp/");

    let local = project
        .environments
        .iter()
        .find(|e| e.name == "local")
        .unwrap_or_else(|| {
            panic!(
                "expected a \"local\" environment, got {:?}",
                project.environments
            )
        });

    let root_canister = local
        .canisters
        .iter()
        .find(|c| c.name == "root")
        .unwrap_or_else(|| panic!("expected a \"root\" canister, got {:?}", local.canisters));
    assert!(!root_canister.id.is_empty());

    // toko has a project-local cli-home/identity/ store with a real pem
    // identity (toko-local, secp256k1) — this must still resolve, proving
    // the project-local path wasn't broken by adding the no-cli-home
    // fallback.
    let identity = local
        .identity
        .as_ref()
        .expect("toko's project-local identity should resolve");
    assert_eq!(identity.algorithm, "secp256k1");
    assert!(
        identity.pem_path.is_file(),
        "identity pem should exist on disk"
    );
}
