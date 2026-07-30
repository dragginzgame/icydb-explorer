//! Tauri command surface: the only boundary the React frontend (Tasks
//! 11-12) talks across.
//!
//! Every command here resolves an `Environment` from the discovered
//! `Project`, gets an `Agent` from the shared `AgentPool`, calls
//! `sql::run_query`, and maps the result through `view::result_to_dto`.
//! Command bodies are deliberately thin: the actual SQL classification,
//! transport, and DTO-mapping logic all live in the modules that already
//! own them (`sql`, `view`, `topology`, `agent`, `discovery`). Nothing here
//! ever returns an icydb type — only the `view` DTOs and `AppError` cross
//! this boundary, so the frontend never sees, imports, or hand-decodes an
//! icydb type.

use candid::Principal;
use serde::Serialize;
use tauri::State;

use crate::agent::AgentPool;
use crate::discovery::{Environment, Project};
use crate::error::AppError;
use crate::sql::{apply_default_limit, classify, rows_sql, run_query, unordered_rows_sql};
use crate::topology::{build_tree, fetch_children, TreeNode};
use crate::view::{result_to_dto, ResultDto};

/// The default row window used both by `fetch_rows`'s fixed `LIMIT` and by
/// `run_sql`'s auto-appended `LIMIT` for a `SELECT` with none of its own.
/// Kept as one constant so the two paths agree on what "a full page" means
/// for the frontend's has-more-rows heuristic (see `fetch_rows`'s doc
/// comment).
const DEFAULT_ROW_LIMIT: u32 = 100;

/// The frontend-facing result of `run_sql`: the query's `ResultDto` plus
/// whether this explorer silently appended a `LIMIT` clause the user didn't
/// type, so the UI can tell them their statement was modified.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRunDto {
    pub result: ResultDto,
    pub limit_appended: bool,
    /// Set when this was a `SELECT` with no `ORDER BY`, so no default
    /// `LIMIT` was appended even though the statement was otherwise
    /// unbounded — see `sql::apply_default_limit`. Lets the console hint at
    /// the fix instead of the user finding out only after a round trip to
    /// the canister.
    pub order_by_missing: bool,
}

/// Finds the configured `Environment` named `name`, or a clear error rather
/// than a panic if the project's `.icp/` layout declares no such
/// environment (e.g. a typo, or an environment removed since the frontend
/// last called `list_environments`).
fn find_environment<'a>(project: &'a Project, name: &str) -> Result<&'a Environment, AppError> {
    project
        .environments
        .iter()
        .find(|environment| environment.name == name)
        .ok_or_else(|| {
            AppError::Io(format!(
                "no environment named \"{name}\" is configured in this project's .icp/ layout"
            ))
        })
}

/// Parses a canister id string (as supplied by the frontend, itself sourced
/// from `canister_tree`'s pids or from `list_environments`' root ids) into a
/// `Principal`, mapping a malformed id to a clear parse error rather than
/// panicking.
fn parse_principal(text: &str) -> Result<Principal, AppError> {
    Principal::from_text(text)
        .map_err(|e| AppError::Parse(format!("invalid canister id \"{text}\": {e}")))
}

/// Runs `sql` against `canister` in `environment` and maps the decoded
/// result straight through to the frontend DTO. The one place every
/// query-shaped command below funnels through: get-agent, run-query,
/// map-to-dto, in that order, every time.
async fn query_dto(
    pool: &AgentPool,
    environment: &Environment,
    canister: Principal,
    sql: &str,
) -> Result<ResultDto, AppError> {
    // Task 5 re-keyed `AgentPool::get` by `(environment, identity)`, so a
    // caller must now supply the identity explicitly. This still always
    // uses the environment's *default* identity — Task 6 threads the
    // user-selected identity through the command surface (and relocates
    // the "no usable identity" message here, where the selection will be
    // known); this is the minimal change needed to keep the build green
    // until then.
    let identity_ref = environment.identity.as_ref().ok_or_else(|| {
        AppError::Agent(format!(
            "no usable identity is available for environment \"{}\"",
            environment.name
        ))
    })?;
    let agent = pool.get(environment, identity_ref).await?;
    let result = run_query(&agent, canister, sql, identity_ref.name.as_str()).await?;
    result_to_dto(result)
}

/// Returns the discovered project: its environments, and — critically —
/// any error `discover()` hit while reading `.icp/` (see `Project`'s doc
/// comment). Cannot fail as a command: it only ever reads already-computed,
/// in-memory state, but the state itself may record a discovery failure,
/// which is exactly what the frontend needs to render an explicit failed
/// state instead of a silently empty one.
#[tauri::command]
pub fn list_environments(project: State<'_, Project>) -> Project {
    project.inner().clone()
}

/// Walks the canic-orchestrated fleet rooted at each of `env`'s named
/// canisters and returns the resulting **forest** — one `TreeNode` per
/// mapping entry, not a single tree.
///
/// `.icp/cache/mappings/<network>.ids.json` names every canister the
/// project's discovery layer found, and none of them is privileged as "the"
/// root: a canic fleet like toko's has only a `root` entry (the rest of the
/// fleet exists only in its live topology), while a plain project like this
/// repo's fixture lists its canisters directly with no root at all. So every
/// named canister gets its own tree walk; one that exposes no `canic_*`
/// endpoints simply comes back as a childless leaf (see
/// `topology::fetch_children`'s doc comment).
#[tauri::command]
pub async fn canister_tree(
    env: String,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<Vec<TreeNode>, AppError> {
    let environment = find_environment(&project, &env)?;
    if environment.canisters.is_empty() {
        return Err(AppError::Io(format!(
            "environment \"{env}\" has no canisters yet; deploy the project before browsing \
             its topology"
        )));
    }

    // See `query_dto`'s comment: same temporary "use the environment's
    // default identity" shim, pending Task 6's threading.
    let identity_ref = environment.identity.as_ref().ok_or_else(|| {
        AppError::Agent(format!(
            "no usable identity is available for environment \"{}\"",
            environment.name
        ))
    })?;
    let agent = pool.get(environment, identity_ref).await?;
    let mut forest = Vec::with_capacity(environment.canisters.len());
    for named in &environment.canisters {
        let root = parse_principal(&named.id)?;
        let infos = fetch_children(&agent, root).await?;
        forest.push(build_tree(&named.id, &named.name, infos));
    }
    Ok(forest)
}

/// `SHOW ENTITIES` against `canister`.
#[tauri::command]
pub async fn list_tables(
    env: String,
    canister: String,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let environment = find_environment(&project, &env)?;
    let canister_id = parse_principal(&canister)?;
    query_dto(&pool, environment, canister_id, "SHOW ENTITIES").await
}

/// `DESCRIBE <entity>` against `canister`.
#[tauri::command]
pub async fn describe_table(
    env: String,
    canister: String,
    entity: String,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let environment = find_environment(&project, &env)?;
    let canister_id = parse_principal(&canister)?;
    let sql = format!("DESCRIBE {entity}");
    query_dto(&pool, environment, canister_id, &sql).await
}

/// Pages `entity`'s rows, `DEFAULT_ROW_LIMIT` at a time, starting at
/// `offset`.
///
/// **Scalar paging is `LIMIT`/`OFFSET`, not cursors** — icydb's SQL subset
/// contract marks `pagination.scalar_cursor` rejected and
/// `pagination.scalar_limit_offset` accepted, and `Projection` (a scalar
/// `SELECT`'s payload) carries no cursor field at all. "Has more" is left
/// for the frontend to infer from `RowsDto.rowCount == DEFAULT_ROW_LIMIT`
/// (a full page): there is no `COUNT` here and this never fabricates a
/// total.
///
/// This does **not** send the single `format!("SELECT * FROM {entity}
/// LIMIT {DEFAULT_ROW_LIMIT} OFFSET {offset}")` the task brief specifies,
/// and that deviation is deliberate, not an oversight — see the task
/// report for the full write-up. Confirmed live against the fixture
/// canister: icydb 0.202.1's query planner rejects *any* `LIMIT`/`OFFSET`
/// window that has no explicit `ORDER BY`
/// (`PolicyPlanError::UnorderedPagination`, diagnostic code
/// `QUERY_UNORDERED_PAGINATION`) — so the brief's literal SQL fails on
/// every real call, for every entity, not just this fixture's. Since
/// `fetch_rows` isn't handed a column to order by, this looks up the
/// entity's primary-key column(s) via `DESCRIBE` first (icydb requires
/// every entity to declare one) and orders by those via `sql::rows_sql`
/// (ordering by any column is sufficient to satisfy the planner — confirmed
/// live: ordering by a non-unique column also works).
///
/// **`introspection.ic = false` (icydb's own default for IC/mainnet
/// builds) makes that `DESCRIBE` fail with `AppError::IntrospectionDisabled`
/// before any row is ever fetched** — `SHOW`/`DESCRIBE`/`EXPLAIN` are
/// unavailable, but plain `SELECT` is not, so row browsing must not be
/// blind to that distinction. This specific error is caught here and
/// switched to `sql::unordered_rows_sql`: an unordered, unbounded `SELECT`
/// (no primary key was derivable, and icydb rejects any `LIMIT`/`OFFSET`
/// with no `ORDER BY`, so a bounded page isn't achievable either). Any
/// other `DESCRIBE` failure — a genuinely unreachable replica, a
/// non-controller identity, etc — still propagates as before; only the
/// introspection-disabled case gets this fallback.
#[tauri::command]
pub async fn fetch_rows(
    env: String,
    canister: String,
    entity: String,
    offset: u32,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let environment = find_environment(&project, &env)?;
    let canister_id = parse_principal(&canister)?;

    let describe_sql = format!("DESCRIBE {entity}");
    let sql = match query_dto(&pool, environment, canister_id, &describe_sql).await {
        Ok(ResultDto::Schema(schema)) => {
            let pk_columns: Vec<String> = schema
                .columns
                .iter()
                .filter(|column| column.primary_key)
                .map(|column| column.name.clone())
                .collect();
            rows_sql(&entity, &pk_columns, DEFAULT_ROW_LIMIT, offset)
        }
        // An unexpected (non-Schema) shape from DESCRIBE: fall back to the
        // same "no primary key derivable" path `rows_sql` already handles,
        // rather than inventing a new error for a case that cannot occur
        // against a well-behaved canister.
        Ok(_) => rows_sql(&entity, &[], DEFAULT_ROW_LIMIT, offset),
        Err(AppError::IntrospectionDisabled) => unordered_rows_sql(&entity),
        Err(other) => return Err(other),
    };

    query_dto(&pool, environment, canister_id, &sql).await
}

/// Runs a user-typed SQL statement, classifying it before any network
/// round-trip so a rejected statement (write/DDL/anything but
/// `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`) never reaches the canister, then
/// appending a default `LIMIT` to an unbounded `SELECT` and reporting
/// whether it did so.
#[tauri::command]
pub async fn run_sql(
    env: String,
    canister: String,
    sql: String,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<SqlRunDto, AppError> {
    let environment = find_environment(&project, &env)?;
    let canister_id = parse_principal(&canister)?;

    // Classify first: a rejected statement returns immediately, before the
    // agent is even fetched, so it never contacts the canister.
    let statement = classify(&sql)?;
    let limited = apply_default_limit(&sql, statement, DEFAULT_ROW_LIMIT);

    let result = query_dto(&pool, environment, canister_id, &limited.sql).await?;
    Ok(SqlRunDto {
        result,
        limit_appended: limited.limit_appended,
        order_by_missing: limited.order_by_missing,
    })
}
