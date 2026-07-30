//! Live tests against the fixture canister. Ignored by default: they need a
//! running replica. Run with:
//!   cargo test --test integration -- --ignored
//!
//! Set ICYDB_EXPLORER_TEST_CANISTER and ICYDB_EXPLORER_TEST_URL first.
//!
//! The fixture's entities are `DemoRow`/`DemoChild`, not `demo_row`/
//! `demo_child` — the icydb 0.215.5 bump's `#[entity]` macro dropped its
//! entity-level `name` attribute (`fixture-schema/src/lib.rs` used to set
//! `name = "demo_row"` explicitly), so an entity's SQL-visible name is now
//! forced to its Rust struct identifier. Every SQL literal below was
//! written against the old snake_case name and updated for this; see
//! README.md item 9's "A distinct upgrade note" for the full explanation
//! and why it isn't a no-op.

use std::path::PathBuf;

use candid::Principal;
use ic_agent::identity::Secp256k1Identity;
use ic_agent::Agent;

use icydb_explorer_lib::agent::load_identity;
use icydb_explorer_lib::discovery::{
    read_all_identities, read_default_identity_name, recorded_principal, user_level_identity_store,
};
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
            assert!(names.contains(&"DemoRow"), "got {names:?}");
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
    // the finding is confirmed and folded into the plan. (The entity was
    // named `demo_row` at the time; the 0.215.5 bump forced the rename to
    // `DemoRow` — see this file's module doc comment.)
    let result = run_query(
        &agent,
        canister,
        "SELECT * FROM DemoRow ORDER BY id LIMIT 10",
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
            // `timestamps(created_at(...), updated_at(...))` in
            // `fixture-schema/src/lib.rs` was restored deliberately on this
            // bump — 0.202.1 generated these columns unconditionally, and
            // 0.215.5 made them opt-in, so silently dropping the
            // `timestamps(...)` key would change `SELECT *`'s column set
            // without any other test noticing. Assert both names are still
            // present so a future bump that drops that key fails here.
            assert!(
                rows.columns.iter().any(|c| c == "created_at"),
                "missing created_at in {:?}",
                rows.columns
            );
            assert!(
                rows.columns.iter().any(|c| c == "updated_at"),
                "missing updated_at in {:?}",
                rows.columns
            );
        }
        other => panic!("expected Rows, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn describe_reports_the_primary_key() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "DESCRIBE DemoRow", "icydb-explorer-test")
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
///
/// **Corrected 2026-07-30 (icydb 0.215.5 bump, Task 3 fix-up).** Until this
/// fix, this assertion was `unordered.is_err()` — true, but true for the
/// wrong reason: while this test still referred to the fixture's pre-bump
/// entity name (`demo_row`), the query failed with icydb's generic
/// unknown-entity error (`E23`) rather than the `UnorderedPagination`
/// rejection (`E5`) it exists to check, and `is_err()` can't tell the two
/// apart. Verified directly: the identical query against the correct
/// (post-bump) entity name returns `E5` as expected, while the stale name
/// returned `E23` — proving the earlier "pass" was accidental. Now asserts
/// on the specific `AppError::IcyDb` code so an unrelated failure mode
/// can't silently masquerade as this one again.
#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn select_with_limit_and_no_order_by_is_rejected() {
    let (agent, canister) = connect().await;

    let unordered = run_query(
        &agent,
        canister,
        "SELECT * FROM DemoRow LIMIT 1 OFFSET 0",
        "icydb-explorer-test",
    )
    .await;
    match unordered {
        Err(AppError::IcyDb { message, .. }) if message == "E5" => {}
        other => panic!(
            "expected icydb's E5 UnorderedPagination rejection, got {other:?}"
        ),
    }
}

/// Confirms `commands::fetch_rows`'s introspection-disabled behavior against
/// a **real introspection-disabled canister**, not just the pure-function
/// unit tests in `sql::rows` and `error::tests`.
///
/// **Corrected 2026-07-30 (icydb author review, Step 4c).** This test
/// previously asserted that `fetch_rows`'s fallback for this case — an
/// unordered, unbounded `SELECT * FROM {entity}` built by the
/// since-removed `sql::unordered_rows_sql` — still returned rows. That
/// fallback was a real defect: an unbounded read against the trusted/admin
/// generated-SQL lane, which intentionally bypasses public-read admission.
/// `fetch_rows` now returns `AppError::RowPagingRequiresIntrospection`
/// instead of issuing any fallback query at all in this case (see
/// `sql::rows::tests::empty_primary_key_is_refused_rather_than_left_unordered`
/// and `error::tests::row_paging_requires_introspection_names_the_entity_and_the_sql_console`
/// for the offline coverage of that). What this live test still verifies is
/// the workaround the corrected error message actually recommends: a
/// hand-written `SELECT` with its own explicit `ORDER BY`/`LIMIT` needs no
/// `DESCRIBE` and so is unaffected by introspection being off.
///
/// The committed fixture canister is built with `ICYDB_BUILD_TARGET=local`
/// (see README item 4), so `introspection.local = true` applies and this
/// scenario can't be reproduced against it. This test instead points at a
/// second, separately-deployed instance of the exact same fixture wasm,
/// rebuilt with `ICYDB_BUILD_TARGET=ic` — which flips it to
/// `introspection.ic = false` per `fixture/icydb.toml` — and installed as a
/// detached canister (`icp canister create -n local --detached`, `icp
/// canister install <id> -n local --wasm <path>`) so it needs no `icp.yaml`
/// entry of its own. Verified live while fixing the original finding:
/// `SHOW ENTITIES` against it fails with error code 179
/// (`RUNTIME_BOUNDARY_SQL_INTROSPECTION_DISABLED`) via a plain `icp
/// canister call`, while an explicitly ordered `SELECT` succeeds.
#[tokio::test]
#[ignore = "requires a second fixture instance built with ICYDB_BUILD_TARGET=ic and deployed \
            detached (see this test's doc comment); set \
            ICYDB_EXPLORER_INTROSPECTION_DISABLED_CANISTER to its id"]
async fn explicit_order_by_and_limit_still_works_when_introspection_is_disabled() {
    let (agent, canister) = connect().await;
    let canister_text = std::env::var("ICYDB_EXPLORER_INTROSPECTION_DISABLED_CANISTER")
        .map(|id| Principal::from_text(id.trim()).expect("should be a valid principal"))
        .unwrap_or(canister);

    // DESCRIBE (what fetch_rows uses to derive an ORDER BY) fails with
    // exactly the error commands::fetch_rows now turns into
    // AppError::RowPagingRequiresIntrospection, rather than falling back to
    // an unbounded SELECT.
    let describe = run_query(
        &agent,
        canister_text,
        "DESCRIBE DemoRow",
        "icydb-explorer-test",
    )
    .await;
    assert!(
        matches!(describe, Err(AppError::IntrospectionDisabled)),
        "expected IntrospectionDisabled, got {describe:?}"
    );

    // The SQL console workaround the corrected error message points a user
    // at — an explicit ORDER BY and LIMIT, hand-written rather than derived
    // from a DESCRIBE — still succeeds: it never needed introspection.
    let result = run_query(
        &agent,
        canister_text,
        "SELECT * FROM DemoRow ORDER BY id LIMIT 100",
        "icydb-explorer-test",
    )
    .await
    .expect(
        "an explicitly ordered, bounded SELECT should succeed even with introspection disabled",
    );
    match result_to_dto(result).expect("decode should succeed") {
        ResultDto::Rows(rows) => {
            assert!(!rows.rows.is_empty(), "fixture should be seeded");
        }
        other => panic!("expected Rows, got {other:?}"),
    }
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

/// Live: exports the configured default identity and checks the principal it
/// produces against the one recorded in the store. Requires a real icp
/// identity store and the `icp` binary.
///
/// This is the whole identity chain in one assertion — enumerate, export,
/// parse, load — without ever printing key material: only the (public)
/// principal derived from the loaded identity is compared against the
/// (public) principal `identity_list.json` already records for it.
///
/// Run with: cargo test --test integration -- --ignored
#[tokio::test]
#[ignore = "requires a real icp identity store and the icp CLI"]
async fn the_default_identity_loads_and_matches_its_recorded_principal() {
    let store = user_level_identity_store().expect("a user-level icp store should exist");
    let identities = read_all_identities(&store).expect("store should read");
    let defaults = read_default_identity_name(&store).expect("a default should be configured");
    let identity = identities
        .iter()
        .find(|i| i.name == defaults)
        .expect("the default should be present in the store");
    if !identity.is_usable() {
        eprintln!(
            "default identity \"{}\" is kind \"{}\" — skipping",
            identity.name, identity.kind
        );
        return;
    }

    let loaded = load_identity(identity)
        .await
        .expect("default identity should load");
    let recorded = recorded_principal(&store, &identity.name).expect("store records a principal");
    assert_eq!(
        loaded.sender().expect("sender").to_text(),
        recorded,
        "the exported key must produce the principal the store recorded"
    );
}
