//! Live tests against a **real canic fleet** (dragginz/toko), as opposed to
//! this repo's own single fixture canister in `integration.rs`.
//!
//! Run with a deployed toko and its replica up:
//!
//! ```bash
//! export ICYDB_EXPLORER_TOKO_PROJECT_ROOT=/path/to/dragginz/toko
//! cargo test --test real_fleet -- --ignored --nocapture
//! ```
//!
//! Why this exists separately from `integration.rs`: that suite connects with a
//! pem this repo controls and a canister id passed in by hand, which proves the
//! query path but says nothing about *discovery*. A real project is where the
//! two meet — the identity the app picks has to be the one that actually
//! controls the canisters, and nothing in the unit suites can observe that.
//!
//! The bug this suite was written after: toko's canisters were installed from a
//! shell without direnv, so `icp` fell back to the user's global identity rather
//! than the `toko-local` identity in the project's own `.icp/cli-home/` store —
//! the store this app discovers identities from.
//!
//! Who ends up a controller is worth stating precisely, because the first
//! diagnosis of this was too broad. `canic.toml` declares an explicit
//! `controllers` list (the team's principals) that every *child* canister
//! receives regardless of who installs, and the installing identity is added on
//! top. `toko-local` is not in that list, so it is a controller only when it did
//! the install. The *root* canister gets a much narrower set — the installer
//! alone. So an install under the wrong identity leaves the app holding a key
//! that may control nothing it needs, and no selection the user can make fixes
//! it, because the controlling principal is not in the store the app reads.
//!
//! What made it hard to see: everything else looked correct — canisters
//! deployed, `icydb_query` present in the wasm, hand-run queries succeeding —
//! because those were run as the global identity, not as the one the app would
//! choose. See README, "Running against a real canic fleet".

use std::path::Path;

use ic_agent::Agent;

use icydb_explorer_lib::agent::load_identity;
use icydb_explorer_lib::discovery::discover;
use icydb_explorer_lib::sql::run_query;
use icydb_explorer_lib::topology::fetch_children;
use icydb_explorer_lib::view::{result_to_dto, ResultDto};

const CALLER: &str = "icydb-explorer-real-fleet-test";

/// Connects exactly the way the app does: discover the project, take the
/// environment's own default identity, and build an agent from it. Nothing is
/// passed in by hand, because the point is to test what the app would choose.
async fn connect_as_the_app_would() -> (Agent, icydb_explorer_lib::discovery::Environment) {
    let root = std::env::var("ICYDB_EXPLORER_TOKO_PROJECT_ROOT")
        .expect("set ICYDB_EXPLORER_TOKO_PROJECT_ROOT to a deployed toko checkout");

    let project = discover(Path::new(&root)).expect("discovery should succeed");
    let env = project
        .environments
        .into_iter()
        .find(|e| e.name == "local")
        .expect("expected a \"local\" environment");

    let identity_ref = env
        .identity
        .clone()
        .expect("the project should resolve a default identity");
    let identity = load_identity(&identity_ref)
        .await
        .expect("the project's default identity should load");

    let agent = Agent::builder()
        .with_url(env.replica_url.clone())
        .with_identity(identity)
        .build()
        .expect("agent should build");
    agent
        .fetch_root_key()
        .await
        .expect("should reach the replica — is it running?");

    (agent, env)
}

/// The regression test for the controller mismatch described in the module
/// comment. It asserts the negative that matters: the identity discovery hands
/// the app must not be rejected by the controller gate.
///
/// A `NotController` here means the fleet was installed under a different
/// identity than the project declares — the app is fine, the deployment is
/// misaligned, and no selection the user can make will fix it.
#[tokio::test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a deployed toko checkout"]
async fn the_identity_the_app_picks_can_actually_query() {
    let (agent, env) = connect_as_the_app_would().await;
    let root = env
        .canisters
        .iter()
        .find(|c| c.name == "root")
        .expect("expected a root canister");
    let root_pid = root.id.parse().expect("root id should be a principal");

    let children = fetch_children(&agent, root_pid)
        .await
        .expect("walking the fleet should succeed");
    assert!(!children.is_empty(), "expected a non-empty fleet");

    // Every canister either answers SHOW ENTITIES or reports that its surface
    // is off — but none may report NotController, which is the misalignment
    // this test exists to catch.
    let mut answered = 0usize;
    for child in &children {
        match run_query(&agent, child.pid, "SHOW ENTITIES", CALLER).await {
            Ok(_) => answered += 1,
            Err(error) => {
                let text = format!("{error:?}");
                // Both spellings on purpose. The rejection arrives as an
                // `icydb::Error` *value* with code 25, and `transport.rs` maps
                // that to `NotController`. Asserting only on the mapped name
                // would make this test silently vacuous if that mapping were
                // ever removed — which is exactly the state this suite was
                // written in, before the E25 arm existed.
                assert!(
                    !text.contains("NotController") && !text.contains("E25"),
                    "{} rejected the project's own identity as a non-controller. The fleet was \
                     installed under a different identity than the project declares — see README, \
                     \"Running against a real canic fleet\", step 3: {text}",
                    child.role
                );
            }
        }
    }
    assert!(
        answered > 0,
        "no canister in the fleet answered SHOW ENTITIES; is the SQL surface enabled?"
    );
}

/// The full path the rows pane drives: list entities, describe one to derive
/// its primary key, then page it. This is the sequence that only works when
/// discovery, the controller gate, the readonly surface and introspection are
/// all correct at once.
#[tokio::test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a deployed toko checkout"]
async fn show_describe_and_page_work_against_the_fleet() {
    let (agent, env) = connect_as_the_app_would().await;
    let root_pid = env
        .canisters
        .iter()
        .find(|c| c.name == "root")
        .expect("expected a root canister")
        .id
        .parse()
        .expect("root id should be a principal");

    let children = fetch_children(&agent, root_pid).await.expect("fleet walk");

    // Find any canister that reports at least one entity. Which canisters have
    // entities is toko's business and may change, so this discovers rather
    // than hardcoding — a hardcoded name would fail for the wrong reason.
    let mut found = None;
    for child in &children {
        if let Ok(result) = run_query(&agent, child.pid, "SHOW ENTITIES", CALLER).await {
            if let Ok(ResultDto::Entities { entities }) = result_to_dto(result) {
                if let Some(first) = entities.first() {
                    found = Some((child.pid, first.name.clone()));
                    break;
                }
            }
        }
    }
    let (canister, entity) = found.expect("expected at least one entity somewhere in the fleet");

    let described = run_query(&agent, canister, &format!("DESCRIBE {entity}"), CALLER)
        .await
        .expect("DESCRIBE should succeed");
    let ResultDto::Schema(schema) = result_to_dto(described).expect("decode") else {
        panic!("expected a Schema result from DESCRIBE");
    };
    assert!(!schema.columns.is_empty(), "{entity} described no columns");

    let keys: Vec<String> = schema
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect();
    assert!(!keys.is_empty(), "{entity} declares no primary key");

    // icydb requires an ORDER BY whenever a statement uses LIMIT, and the app
    // derives it from the primary key — composite keys order by every part.
    let sql = format!(
        "SELECT * FROM {entity} ORDER BY {} LIMIT 100",
        keys.join(", ")
    );
    match run_query(&agent, canister, &sql, CALLER).await {
        Ok(result) => {
            let dto = result_to_dto(result).expect("decode should succeed");
            assert!(
                matches!(dto, ResultDto::Rows(_)),
                "expected rows, got {dto:?}"
            );
        }
        // A key whose type declares no ordering cannot be paged at all — icydb
        // rejects the ORDER BY with diagnostic 96. That is a property of the
        // schema, not a failure of this path, and the app explains it rather
        // than showing the bare code (see `error.rs`). toko's
        // `PlatformClaimConfigState` is a live example, so accepting it here
        // is deliberate — but nothing else may fail.
        Err(error) => {
            let text = format!("{error:?}");
            assert!(
                text.contains("E96"),
                "paging {entity} by {keys:?} failed for an unexpected reason: {text}"
            );
        }
    }
}

/// Counting is the feature this suite is best placed to prove: it is one
/// statement whose whole job is to return a number, and the only way to know
/// the number is right is to ask a canister whose contents are known.
#[tokio::test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a deployed toko checkout"]
async fn counting_reports_a_real_number_for_every_entity() {
    use icydb_explorer_lib::sql::{count_sql, read_count};

    let (agent, env) = connect_as_the_app_would().await;
    let root_pid = env
        .canisters
        .iter()
        .find(|c| c.name == "root")
        .expect("expected a root canister")
        .id
        .parse()
        .expect("root id should be a principal");

    let children = fetch_children(&agent, root_pid).await.expect("fleet walk");

    let mut counted = 0usize;
    for child in &children {
        let Ok(listed) = run_query(&agent, child.pid, "SHOW ENTITIES", CALLER).await else {
            continue;
        };
        let Ok(ResultDto::Entities { entities }) = result_to_dto(listed) else {
            continue;
        };

        for entity in entities {
            let result = run_query(&agent, child.pid, &count_sql(&entity.name), CALLER)
                .await
                .unwrap_or_else(|e| panic!("counting {} failed: {e:?}", entity.name));
            let dto = result_to_dto(result).expect("count should decode");

            // The assertion that matters is that a number comes back at all —
            // `read_count` refuses to turn an unrecognised shape into a zero,
            // so reaching here means icydb answered in the shape this app
            // expects. A freshly installed fleet holds no rows, so the value
            // is 0; asserting a specific number would pin this test to the
            // state of someone's replica rather than to the behaviour.
            let count = read_count(&dto, &entity.name)
                .unwrap_or_else(|e| panic!("counting {} returned an unreadable shape: {e:?}", entity.name));
            println!("  {} :: {} -> {count} rows", child.role, entity.name);
            counted += 1;
        }
    }

    assert!(counted > 0, "no entity in the fleet could be counted");
}
