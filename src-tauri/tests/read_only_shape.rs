//! Structural guards on the read-only guarantee.
//!
//! README.md says this app's read-only property does not come from a flag that
//! could be flipped, but from the shape of the code: one agent method, one icydb
//! endpoint, one classifier. That is a claim about the source tree, so it is
//! checked against the source tree.
//!
//! These tests read this crate's own `src/`. They are deliberately blunt — a
//! substring count, not a parse — because the thing being defended is "nobody
//! added a second way to talk to a canister", and a new call site is a new
//! substring however it is written. A false positive here is a prompt to update
//! this file with a reason; a false negative would be the guarantee quietly
//! ceasing to hold.
//!
//! Added when cross-canister fan-out landed: sweeping a pool multiplies how many
//! canisters one action touches, so it is exactly the kind of change that could
//! have introduced a second transport without anyone noticing.

use std::fs;
use std::path::{Path, PathBuf};

fn source_files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&root, &mut files);
    assert!(
        files.len() > 10,
        "expected to find this crate's sources under src/, found {} files",
        files.len()
    );

    files
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("readable source directory") {
        let path = entry.expect("readable dir entry").path();
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Lines of real code: comments are stripped so that *documenting* a method name
/// never trips a guard about *calling* one. Every doc comment in `commands.rs`
/// that explains this design mentions `.query()`, and a guard that counted those
/// would force the explanation to be deleted to stay green.
fn code_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .expect("readable source file")
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.starts_with("//") && !line.starts_with("///") && !line.starts_with("*"))
        .collect()
}

/// The whole guarantee in one assertion: nothing in this app calls an agent
/// update method.
///
/// An update call is how state changes on the IC. There is no allowlist and no
/// exception — if this ever needs one, the app is no longer read-only and the
/// README's claim has to change with it.
#[test]
fn nothing_calls_an_agent_update_method() {
    let mut offenders = Vec::new();
    for path in source_files() {
        for (index, line) in code_lines(&path).iter().enumerate() {
            if line.contains(".update(") || line.contains("update_call") {
                offenders.push(format!("{}:{}: {line}", path.display(), index + 1));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "this app must never issue an update call; found:\n{}",
        offenders.join("\n")
    );
}

/// Exactly two `.query(` call sites, and they are the two the README names.
///
/// Counted rather than merely bounded: a new one is a new way to reach a
/// canister, and whoever adds it should have to come here and say why. The
/// topology call is canic's children listing (navigation); the sql one is
/// icydb's query endpoint (everything else).
#[test]
fn there_are_exactly_two_agent_query_call_sites() {
    let mut sites = Vec::new();
    for path in source_files() {
        for (index, line) in code_lines(&path).iter().enumerate() {
            if line.contains(".query(") {
                let name = path
                    .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")))
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                sites.push(format!("{name}:{}", index + 1));
            }
        }
    }
    sites.sort();

    assert_eq!(
        sites.len(),
        2,
        "expected exactly two agent query call sites, found: {sites:?}"
    );
    assert!(
        sites.iter().any(|site| site.starts_with("src/sql/transport.rs")),
        "the icydb query call site should be in sql/transport.rs, found: {sites:?}"
    );
    assert!(
        sites.iter().any(|site| site.starts_with("src/topology/mod.rs")),
        "the canic children call site should be in topology/mod.rs, found: {sites:?}"
    );
}

/// The only icydb endpoint this app *invokes* is the read-only one.
///
/// icydb generates `icydb_ddl`, `icydb_update`, `icydb_integrity` and
/// `icydb_fixtures_load` alongside `icydb_query` when a canister enables them.
/// None may be passed to an agent call.
///
/// Naming one is not the same as calling one, and there is exactly one file that
/// legitimately names `icydb_update`: `sql/capability.rs` searches a canister's
/// `candid:service` metadata for the declaration, so the UI can tell a writable
/// canister from a read-only one and refuse to offer editing on either. That is
/// detection, and detection is why the app can be honest about what a canister
/// supports. The allowance is per-file and deliberate — widening it means
/// writing down a new reason here.
#[test]
fn no_mutating_icydb_endpoint_is_invoked() {
    const FORBIDDEN: [&str; 4] = [
        "icydb_ddl",
        "icydb_update",
        "icydb_integrity",
        "icydb_fixtures_load",
    ];
    // Detects declarations in candid metadata; never calls anything.
    const MAY_NAME_FOR_DETECTION: &str = "capability.rs";

    let mut offenders = Vec::new();
    for path in source_files() {
        let detecting = path
            .file_name()
            .is_some_and(|name| name == MAY_NAME_FOR_DETECTION);

        for (index, line) in code_lines(&path).iter().enumerate() {
            for endpoint in FORBIDDEN {
                if !line.contains(endpoint) {
                    continue;
                }
                // An agent call on the same line is an invocation wherever it
                // appears, including in the file allowed to name these.
                let invoked = line.contains(".query(") || line.contains(".update(");
                if invoked || !detecting {
                    offenders.push(format!("{}:{}: {endpoint}", path.display(), index + 1));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "only icydb_query may be invoked, and only capability.rs may name the others \
         (for candid detection); found:\n{}",
        offenders.join("\n")
    );
}

/// The one endpoint that *is* invoked is `icydb_query`, at the one site.
///
/// The mirror of the test above: forbidding the others is only half the claim if
/// nothing pins what the surviving call site actually asks for.
#[test]
fn the_icydb_call_site_asks_for_icydb_query() {
    let transport = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql/transport.rs"),
    )
    .expect("transport.rs is readable");

    let called: Vec<&str> = transport
        .lines()
        .filter(|line| line.contains(".query("))
        .collect();

    assert_eq!(called.len(), 1, "one icydb call site: {called:?}");
    assert!(
        transport.contains(r#""icydb_query""#),
        "the call site should name icydb_query"
    );
}

/// The fan-out classifies once and shares the single transport.
///
/// The risk a sweep introduces is not a new endpoint but a *second path* to the
/// old one — a loop that builds its own agent call because that was easier than
/// reusing `query_dto`. This pins that `run_sql_many` goes through it.
#[test]
fn the_sweep_reuses_the_single_query_path() {
    let commands = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs"),
    )
    .expect("commands.rs is readable");

    let sweep_start = commands
        .find("pub async fn run_sql_many")
        .expect("run_sql_many exists");
    let sweep_end = commands[sweep_start..]
        .find("\npub struct SweepRunDto")
        .map(|offset| sweep_start + offset)
        .expect("the sweep's body is followed by its DTO");
    let body = &commands[sweep_start..sweep_end];

    assert!(
        body.contains("query_dto("),
        "the sweep must reach canisters through query_dto, not its own agent call"
    );
    // `?`, not merely a call: the point is that a rejected statement *returns*.
    // An earlier version of this asserted only that `classify(&sql)` appeared,
    // which stayed green when the call was changed to swallow the rejection with
    // `unwrap_or` — the text was still there and the guard was worthless.
    assert!(
        body.contains("classify(&sql)?"),
        "the sweep must propagate a classification failure, not swallow it"
    );
    // And before the agents are reached, so a rejected statement contacts nothing.
    let classified = body.find("classify(&sql)?").expect("classification");
    let first_call = body.find("query_dto(").expect("the query path");
    assert!(
        classified < first_call,
        "classification must happen before any canister is contacted"
    );
}
