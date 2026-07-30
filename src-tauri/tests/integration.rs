//! Live tests against the fixture canister. Ignored by default: they need a
//! running replica. Run with:
//!   cargo test --test integration -- --ignored
//!
//! Set ICYDB_EXPLORER_TEST_CANISTER and ICYDB_EXPLORER_TEST_URL first.

use std::path::PathBuf;

use candid::Principal;
use ic_agent::identity::Secp256k1Identity;
use ic_agent::Agent;

use icydb_explorer_lib::error::AppError;
use icydb_explorer_lib::sql::run_query;
use icydb_explorer_lib::view::{result_to_dto, ResultDto};

/// Builds a live `Agent` against `ICYDB_EXPLORER_TEST_URL`, authenticated as
/// the same identity the task report's deploy steps added as a controller
/// of `ICYDB_EXPLORER_TEST_CANISTER` — `icydb_query` is controller-gated
/// (confirmed against `icydb-build`'s generated glue), so an unauthenticated
/// or non-controller caller would get `NotController` rather than a real
/// result. Reuses the same offline test pem `sql::transport`'s own unit
/// tests already load (`tests/fixtures/secp256k1.pem`), rather than
/// inventing a second one, so this suite has exactly one fixed identity to
/// keep a controller of the fixture canister.
async fn connect() -> (Agent, Principal) {
    let url = std::env::var("ICYDB_EXPLORER_TEST_URL").expect(
        "set ICYDB_EXPLORER_TEST_URL to the local replica's URL, e.g. http://127.0.0.1:4943",
    );
    let canister_text = std::env::var("ICYDB_EXPLORER_TEST_CANISTER")
        .expect("set ICYDB_EXPLORER_TEST_CANISTER to the fixture canister's id");
    let canister = Principal::from_text(canister_text.trim())
        .expect("ICYDB_EXPLORER_TEST_CANISTER should be a valid principal");

    let pem_path = PathBuf::from("tests/fixtures/secp256k1.pem");
    let identity =
        Secp256k1Identity::from_pem_file(&pem_path).expect("test identity pem should load");

    let agent = Agent::builder()
        .with_url(&url)
        .with_identity(identity)
        .build()
        .expect("agent should build offline, without a network call");
    agent
        .fetch_root_key()
        .await
        .expect("should fetch the local replica's root key — is `dfx start`/`icp` running?");

    (agent, canister)
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn show_entities_lists_the_fixture_entities() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "SHOW ENTITIES", "icydb-explorer-test")
        .await
        .expect("query should succeed");
    let dto = result_to_dto(result).expect("decode should succeed");
    match dto {
        // `ResultDto::Entities` is a struct variant (`{ entities: Vec<EntityDto> }`),
        // not a tuple variant — see `view::dto`'s doc comment for why (a
        // newtype variant around a `Vec` panics serde's internally-tagged
        // serializer). The brief's literal snippet used tuple-variant
        // syntax, which doesn't compile against that already-reviewed
        // shape; fixed here without touching the assertion itself.
        ResultDto::Entities { entities } => {
            let names: Vec<&str> = entities.iter().map(|e| e.name.as_str()).collect();
            assert!(names.contains(&"demo_row"), "got {names:?}");
        }
        other => panic!("expected Entities, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn select_returns_typed_values_for_every_seeded_column() {
    let (agent, canister) = connect().await;
    // Was `"SELECT * FROM demo_row LIMIT 10"` (no `ORDER BY`) — that SQL is
    // rejected outright by icydb 0.202.1's query planner
    // (`PolicyPlanError::UnorderedPagination`: pagination requires an
    // explicit ordering), confirmed live while first writing this test (see
    // the task report). Updated per the coordinator's follow-up now that
    // the finding is confirmed and folded into the plan.
    let result = run_query(
        &agent,
        canister,
        "SELECT * FROM demo_row ORDER BY id LIMIT 10",
        "icydb-explorer-test",
    )
    .await
    .unwrap();
    match result_to_dto(result).expect("decode should succeed") {
        ResultDto::Rows(rows) => {
            assert!(!rows.rows.is_empty(), "fixture should be seeded");
            let kinds: Vec<&str> = rows.rows[0].iter().map(|v| v.kind.as_str()).collect();
            for expected in [
                "ulid",
                "text",
                "nat",
                "decimal",
                "principal",
                "timestamp",
                "blob",
                "bool",
            ] {
                assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
            }
        }
        other => panic!("expected Rows, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn describe_reports_the_primary_key() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "DESCRIBE demo_row", "icydb-explorer-test")
        .await
        .unwrap();
    match result_to_dto(result).expect("decode should succeed") {
        ResultDto::Schema(schema) => {
            assert!(
                schema.columns.iter().any(|c| c.primary_key),
                "expected a primary key column"
            );
        }
        other => panic!("expected Schema, got {other:?}"),
    }
}

/// Not one of the task brief's three prescribed tests — added on top of
/// them to cover the negative case none of the three exercise.
///
/// This started out proving *both* halves of the `ORDER BY` finding
/// (unordered rejected, ordered succeeds) — the "ordered succeeds" half is
/// now redundant with `select_returns_typed_values_for_every_seeded_column`
/// above, since the coordinator folded the finding into the prescribed
/// test's own SQL. Trimmed down to just the half that's still distinct: the
/// negative case (that omitting `ORDER BY` really is rejected, not merely
/// unnecessary) that no prescribed test checks, and that's the whole reason
/// `commands::fetch_rows` and `sql::limit::apply_default_limit` needed
/// fixing in the first place.
#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn select_with_limit_and_no_order_by_is_rejected() {
    let (agent, canister) = connect().await;

    let unordered = run_query(
        &agent,
        canister,
        "SELECT * FROM demo_row LIMIT 1 OFFSET 0",
        "icydb-explorer-test",
    )
    .await;
    assert!(
        unordered.is_err(),
        "expected icydb to reject LIMIT/OFFSET without ORDER BY, got {unordered:?}"
    );
}

/// The negative counterpart to the four tests above: a canister that never
/// enabled icydb's SQL surface at all. `dragginz/toko` is exactly this case
/// — its canisters are built without `features = ["sql"]`, so their candid
/// exposes at most `icydb_metrics`/`icydb_metrics_reset` (confirmed by
/// grepping the built `user_hub.did` in that project) and never
/// `icydb_query`.
///
/// This turns the app's single most valuable error message
/// (`AppError::NoSqlSurface`, the one a new user is likeliest to hit first)
/// into a permanent regression test rather than a one-off manual
/// observation. Verified live against `toko`'s `root` canister on its own
/// running replica before writing this test:
///
/// ```text
/// $ icp canister call root icydb_query '("SHOW ENTITIES")' --environment toko --query --identity anonymous
/// Error: The replica returned a rejection error: reject code CanisterError, reject message
/// Error from Canister <root-id>: Canister has no query method 'icydb_query'..
/// ```
///
/// That reject text contains the exact marker
/// `sql::transport::map_reject_message` matches on
/// (`"has no query method 'icydb_query'"`), which is what makes this
/// deterministic rather than a guess about candid shape. No identity/pem is
/// needed — a method that doesn't exist on the canister rejects any caller,
/// controller or not, so this builds an anonymous `Agent` rather than
/// reusing the fixture suite's controller pem.
async fn connect_toko() -> (Agent, Principal) {
    let url = std::env::var("ICYDB_EXPLORER_TOKO_URL").expect(
        "set ICYDB_EXPLORER_TOKO_URL to the toko replica's URL, e.g. http://127.0.0.1:8000",
    );
    let canister_text = std::env::var("ICYDB_EXPLORER_TOKO_CANISTER")
        .expect("set ICYDB_EXPLORER_TOKO_CANISTER to a deployed toko canister id (e.g. root)");
    let canister = Principal::from_text(canister_text.trim())
        .expect("ICYDB_EXPLORER_TOKO_CANISTER should be a valid principal");

    let agent = Agent::builder()
        .with_url(&url)
        .build()
        .expect("agent should build offline, without a network call");
    agent
        .fetch_root_key()
        .await
        .expect("should fetch the toko replica's root key — is its network running?");

    (agent, canister)
}

#[tokio::test]
#[ignore = "requires a running toko replica (ICYDB_EXPLORER_TOKO_URL/ICYDB_EXPLORER_TOKO_CANISTER)"]
async fn run_query_against_a_toko_canister_reports_no_sql_surface() {
    let (agent, canister) = connect_toko().await;
    let canister_text = canister.to_text();

    let result = run_query(&agent, canister, "SHOW ENTITIES", "icydb-explorer-test").await;

    match result {
        Err(AppError::NoSqlSurface { canister: named }) => {
            assert_eq!(named, canister_text);
            let text = AppError::NoSqlSurface { canister: named }.explanation();
            assert!(
                text.contains(&canister_text),
                "explanation should name the canister: {text}"
            );
            assert!(
                text.contains(r#"features = ["sql"]"#),
                "explanation should mention features = [\"sql\"]: {text}"
            );
            assert!(
                text.contains("icydb.toml"),
                "explanation should mention icydb.toml: {text}"
            );
        }
        other => panic!("expected NoSqlSurface, got {other:?}"),
    }
}
