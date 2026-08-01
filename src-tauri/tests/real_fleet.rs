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

/// Connects the way a reader ends up connected: the project's declared default
/// first, falling back to another offered identity if the canisters reject it.
///
/// It used to take the default and stop, which conflated two questions. Whether
/// the default is accepted is its own property, with its own test below — and on
/// a canic project it routinely is not, because the declared default is a local
/// development identity while the declared *controllers* are the team's. Tests
/// about the query path should exercise the query path, not re-fail on identity
/// selection.
async fn connect_as_the_app_would() -> (Agent, icydb_explorer_lib::discovery::Environment) {
    use icydb_explorer_lib::agent::load_identity;

    let root = std::env::var("ICYDB_EXPLORER_TOKO_PROJECT_ROOT")
        .expect("set ICYDB_EXPLORER_TOKO_PROJECT_ROOT to a deployed toko checkout");
    let project = discover(Path::new(&root)).expect("discovery should succeed");
    let env = project
        .environments
        .into_iter()
        .find(|e| e.name == "local")
        .expect("expected a \"local\" environment");

    // Declared default first, then the rest, so this mirrors what a reader does.
    let default_name = env.identity.as_ref().map(|i| i.name.clone());
    let mut candidates: Vec<_> = env
        .identities
        .iter()
        .filter(|i| i.unusable_reason.is_none())
        .cloned()
        .collect();
    candidates.sort_by_key(|i| Some(i.name.clone()) != default_name);

    for identity_ref in candidates {
        let Ok(identity) = load_identity(&identity_ref).await else {
            continue;
        };
        let agent = Agent::builder()
            .with_url(env.replica_url.clone())
            .with_identity(identity)
            .build()
            .expect("agent should build");
        agent
            .fetch_root_key()
            .await
            .expect("should reach the replica — is it running?");

        let root_pid = env
            .canisters
            .iter()
            .find(|c| c.name == "root")
            .expect("expected a root canister")
            .id
            .parse()
            .expect("root id should be a principal");
        let Ok(children) = fetch_children(&agent, root_pid).await else {
            continue;
        };
        let Some(probe_target) = children.iter().find(|c| c.role == "user_hub") else {
            continue;
        };
        if run_query(&agent, probe_target.pid, "SHOW ENTITIES", CALLER)
            .await
            .is_ok()
        {
            return (agent, env);
        }
    }

    panic!("no identity this project offers can query the fleet");
}

/// The invariant that actually matters: the project must offer *an* identity
/// that the canisters accept.
///
/// This began as "the identity the app picks can actually query", which asserted
/// the wrong thing. A canic project declares its controllers in `canic.toml` —
/// the team's principals, in the user-level store — while its project-local
/// store holds a local development identity that is deliberately not among them,
/// and is the declared *default*. So the default being rejected is an ordinary
/// configuration, not a fault; the fault would be having no usable identity at
/// all, which is what left this app with a dead end before the two stores were
/// merged.
///
/// Also asserts the rejection is legible when it happens. A caller that is not a
/// controller gets `NotController` naming the principal — reachable only because
/// icydb's controller rejection arrives as an `Err` value (code 25) and is mapped
/// for it; before that it surfaced as a bare code.
#[tokio::test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a deployed toko checkout"]
async fn the_project_offers_an_identity_the_canisters_accept() {
    use icydb_explorer_lib::agent::load_identity;

    let root = std::env::var("ICYDB_EXPLORER_TOKO_PROJECT_ROOT")
        .expect("set ICYDB_EXPLORER_TOKO_PROJECT_ROOT to a deployed toko checkout");
    let project = discover(Path::new(&root)).expect("discovery should succeed");
    let env = project
        .environments
        .into_iter()
        .find(|e| e.name == "local")
        .expect("expected a \"local\" environment");

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();

    for identity_ref in env.identities.iter().filter(|i| i.unusable_reason.is_none()) {
        let Ok(identity) = load_identity(identity_ref).await else {
            continue;
        };
        let agent = Agent::builder()
            .with_url(env.replica_url.clone())
            .with_identity(identity)
            .build()
            .expect("agent should build");
        agent.fetch_root_key().await.expect("should reach the replica");

        let root_pid = env
            .canisters
            .iter()
            .find(|c| c.name == "root")
            .expect("expected a root canister")
            .id
            .parse()
            .expect("root id should be a principal");
        let children = fetch_children(&agent, root_pid).await.expect("fleet walk");
        let Some(schema_canister) = children.iter().find(|c| c.role == "user_hub") else {
            continue;
        };

        match run_query(&agent, schema_canister.pid, "SHOW ENTITIES", CALLER).await {
            Ok(_) => accepted.push(identity_ref.name.clone()),
            Err(error) => rejected.push((identity_ref.name.clone(), format!("{error:?}"))),
        }
    }

    assert!(
        !accepted.is_empty(),
        "no identity this project offers can query the fleet — the store holding the declared \
         controllers is not reachable. Offered and rejected: {rejected:?}"
    );

    for (name, error) in &rejected {
        assert!(
            error.contains("NotController"),
            "{name} was rejected but not as NotController, so the reason will not reach the \
             reader: {error}"
        );
    }
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

/// The capability probe against canisters that really do lack an update
/// endpoint. toko is built with only the readonly and introspection surfaces,
/// so every canister in the fleet must report `update: false` — and `query:
/// true`, since this app is querying them successfully throughout this suite.
///
/// This is the negative half of the write feature, and the half that matters:
/// the permissive failure would offer an edit control for a canister that can
/// only reject the write.
#[tokio::test]
#[ignore = "requires ICYDB_EXPLORER_TOKO_PROJECT_ROOT pointed at a deployed toko checkout"]
async fn a_read_only_fleet_reports_no_update_capability() {
    use icydb_explorer_lib::sql::probe;

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

    let mut queryable = 0usize;
    for child in &children {
        let caps = probe(&agent, child.pid)
            .await
            .unwrap_or_else(|e| panic!("probing {} failed: {e:?}", child.role));

        assert!(
            !caps.update,
            "{} reported update support, but toko enables only the readonly and \
             introspection surfaces — a false positive here would put an edit control in \
             front of a canister that will reject the write",
            child.role
        );
        if caps.query {
            queryable += 1;
        }
        println!("  {} :: query={} update={}", child.role, caps.query, caps.update);
    }

    assert!(
        queryable > 0,
        "no canister reported query support, yet this suite queries them successfully — \
         the probe is not reading the interface correctly"
    );
}
