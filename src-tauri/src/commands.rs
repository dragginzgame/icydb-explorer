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
use tauri::{AppHandle, Manager, State};

use crate::agent::AgentPool;
use crate::discovery::{self, resolve_root, Environment, IdentityRef, Project};
use crate::error::AppError;
use crate::project::config::write_recorded_root;
use crate::project::ProjectState;
use crate::sql::{
    apply_default_limit, classify, count_sql, probe, read_count, rows_sql, run_query,
    SqlCapabilities,
};
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

/// Finds the identity named `name` in `env`, or a clear error rather than a
/// panic if the store changed since the frontend last listed environments
/// (or if the name was simply never valid — a typo, or an identity removed
/// via `icp identity` since this window opened).
///
/// This is the one place both former `pool.get` call sites' "no usable
/// identity" shim now funnels through — see the task history: an earlier
/// pass had to degrade that message to a placeholder that named neither the
/// identity nor how to find one, to keep the build green while identity
/// selection didn't exist yet. Now that the frontend supplies a name, the
/// message can be specific and actionable again — and, since keyring
/// identities load exactly as well as pem ones now, it no longer steers
/// anyone toward "use a pem identity", which would be stale advice.
pub fn find_identity<'a>(env: &'a Environment, name: &str) -> Result<&'a IdentityRef, AppError> {
    env.identities
        .iter()
        .find(|identity| identity.name == name)
        .ok_or_else(|| {
            AppError::Agent(format!(
                "environment \"{}\" has no identity named \"{name}\"; the icp identity store \
                 may have changed since this window opened. Run `icp identity list` to see \
                 which identities are currently available.",
                env.name
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

/// Runs `sql` against `canister` in `environment`, as `identity_ref`, and
/// maps the decoded result straight through to the frontend DTO. The one
/// place every query-shaped command below funnels through: get-agent,
/// run-query, map-to-dto, in that order, every time.
///
/// Takes an already-resolved `identity_ref` rather than looking one up
/// itself: every caller has just resolved the frontend-supplied identity
/// name via `find_identity`, and doing that resolution once per command
/// (instead of once per `query_dto` call, of which `fetch_rows` makes two)
/// avoids reporting the same lookup failure from two different call sites
/// with two different chances to drift out of sync.
async fn query_dto(
    pool: &AgentPool,
    root: &std::path::Path,
    environment: &Environment,
    identity_ref: &IdentityRef,
    canister: Principal,
    sql: &str,
) -> Result<ResultDto, AppError> {
    let agent = pool.get(root, environment, identity_ref).await?;
    let result = run_query(&agent, canister, sql, identity_ref.name.as_str()).await?;
    result_to_dto(result)
}

/// Returns the open project, or `None` if the user hasn't chosen one yet.
///
/// `None` and `Some(project)` are both ordinary outcomes: the frontend
/// renders the first as the "choose a project" empty state and the second
/// through its normal path. As before, a `Some` project may still carry a
/// `discover()` failure on its `error` field — see `Project`'s doc comment —
/// so a layout this app can't read stays distinguishable from a project
/// that simply has no environments yet.
#[tauri::command]
pub fn list_environments(project: State<'_, ProjectState>) -> Option<Project> {
    project.snapshot()
}

/// Loads the named identity now, so a failure surfaces when the user selects
/// it rather than on their first query.
///
/// This exports eagerly rather than just recording the choice as state: it
/// resolves the identity and calls `pool.get`, which is what actually loads
/// the key material (from disk, or via a keyring export that may prompt the
/// OS Keychain) and builds the agent. A lazy version — one that only
/// remembered the selected name — would defer that first key-load (and any
/// Keychain prompt) to whatever query the user happens to run first, which
/// would surface the same failure three clicks later, at a moment that
/// doesn't obviously connect back to "I just switched identities". Doing it
/// here, synchronously with the selection, is the entire point of this
/// command existing as more than a plain setter.
#[tauri::command]
pub async fn select_identity(
    env: String,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<(), AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    pool.get(&project.root, environment, identity_ref).await?;
    Ok(())
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
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<Vec<TreeNode>, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    if environment.canisters.is_empty() {
        return Err(AppError::Io(format!(
            "environment \"{env}\" has no canisters yet; deploy the project before browsing \
             its topology"
        )));
    }

    let identity_ref = find_identity(environment, &identity)?;
    let agent = pool.get(&project.root, environment, identity_ref).await?;
    let mut forest = Vec::with_capacity(environment.canisters.len());
    for named in &environment.canisters {
        // Named `canister_root` rather than `root`, unlike elsewhere in this
        // file: this function already binds `project.root` a few lines up,
        // and the two are unrelated (a filesystem path vs. this tree walk's
        // starting canister principal) — the one function whose correctness
        // turns on telling them apart is not the place for two things named
        // `root`.
        let canister_root = parse_principal(&named.id)?;
        let infos = fetch_children(&agent, canister_root).await?;
        forest.push(build_tree(&named.id, &named.name, infos));
    }
    Ok(forest)
}

/// `SHOW ENTITIES` against `canister`.
#[tauri::command]
pub async fn list_tables(
    env: String,
    canister: String,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;
    query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        "SHOW ENTITIES",
    )
    .await
}

/// Writes an exported page of rows to `path`.
///
/// The frontend serialises (it holds the rows already) and picks the path
/// through the save dialog; this only writes, so the one privileged step —
/// touching the filesystem — stays in Rust where it can be reasoned about.
///
/// No `fs` plugin: a single `std::fs::write` behind a command is a smaller
/// surface than a general filesystem capability, and this app needs exactly one
/// operation.
#[tauri::command]
pub fn write_export(path: String, contents: String) -> Result<(), AppError> {
    std::fs::write(&path, contents)
        .map_err(|e| AppError::Agent(format!("could not write {path}: {e}")))
}

/// What icydb SQL endpoints `canister` exports.
///
/// The frontend uses this to decide whether an editing affordance may exist at
/// all. A canister built without an update policy exports no `icydb_update`,
/// and no amount of willingness in this app changes that — so the control has
/// to be absent before the user reaches for it, not error after they have
/// committed to an edit.
///
/// Read from the canister's own `candid:service` metadata: a certified
/// read-state call, not a statement, so it cannot mutate anything and costs
/// nothing to ask.
#[tauri::command]
pub async fn sql_capabilities(
    env: String,
    canister: String,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<SqlCapabilities, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;

    let agent = pool.get(&project.root, environment, identity_ref).await?;

    probe(&agent, canister_id).await
}

/// `SELECT COUNT(*)` for one entity.
///
/// Separate from `list_tables` on purpose. `SHOW ENTITIES` reports how many
/// columns, indexes and relations an entity declares — all schema facts, free
/// to read — but says nothing about how many rows it holds, which is usually
/// the first thing a reader wants to know and the only way to tell a table
/// worth opening from an empty one.
///
/// Counting is a full scan, so this is one call per entity and the caller
/// decides when to spend them. That is why it is not folded into
/// `list_tables`: counting every entity the moment a canister is selected
/// would be free against an empty local replica and careless against a
/// production canister holding millions of rows. The user asks; the app does
/// not guess on their behalf.
#[tauri::command]
pub async fn count_rows(
    env: String,
    canister: String,
    entity: String,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<u64, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;

    let result = query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        &count_sql(&entity),
    )
    .await?;

    read_count(&result, &entity)
}

/// `DESCRIBE <entity>` against `canister`.
#[tauri::command]
pub async fn describe_table(
    env: String,
    canister: String,
    entity: String,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;
    let sql = format!("DESCRIBE {entity}");
    query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        &sql,
    )
    .await
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
/// canister: icydb's query planner rejects *any* `LIMIT`/`OFFSET`
/// window that has no explicit `ORDER BY`
/// (`PolicyPlanError::UnorderedPagination`, diagnostic code
/// `QUERY_UNORDERED_PAGINATION`) — so the brief's literal SQL fails on
/// every real call, for every entity, not just this fixture's. Re-confirmed
/// under 0.215.5 by
/// `tests/integration.rs::select_with_limit_and_no_order_by_is_rejected`,
/// which asserts the `E5` rejection directly. Since
/// `fetch_rows` isn't handed a column to order by, this looks up the
/// entity's primary-key column(s) via `DESCRIBE` first (icydb requires
/// every entity to declare one) and orders by those via `sql::rows_sql`
/// (ordering by any column is sufficient to satisfy the planner — confirmed
/// live: ordering by a non-unique column also works).
///
/// **`introspection.ic = false` (icydb's own default for IC/mainnet
/// builds) makes that `DESCRIBE` fail with `AppError::IntrospectionDisabled`
/// before any row is ever fetched** — `SHOW`/`DESCRIBE`/`EXPLAIN` are
/// unavailable, but plain `SELECT` is not in general. Row browsing
/// specifically, however, still needs a primary key to build an `ORDER BY`
/// (icydb rejects any `LIMIT`/`OFFSET` with no `ORDER BY`), and with
/// `DESCRIBE` unavailable there is no way to discover one. This case
/// therefore returns `AppError::RowPagingRequiresIntrospection` rather than
/// falling back to an unordered, unbounded `SELECT` as an earlier version of
/// this app did: the generated-SQL lane this runs on is trusted/admin and
/// intentionally bypasses public-read admission, so an unbounded read here
/// would be exactly the wrong place to relax that. Row browsing is
/// *unavailable* on a canister with introspection disabled — the SQL
/// console remains available for a hand-written, explicitly ordered
/// `SELECT`. Any other `DESCRIBE` failure — a genuinely unreachable replica,
/// a non-controller identity, etc — still propagates as before; only the
/// introspection-disabled case gets this treatment.
#[tauri::command]
pub async fn fetch_rows(
    env: String,
    canister: String,
    entity: String,
    offset: u32,
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<ResultDto, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;

    let describe_sql = format!("DESCRIBE {entity}");
    let sql = match query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        &describe_sql,
    )
    .await
    {
        Ok(ResultDto::Schema(schema)) => {
            let pk_columns: Vec<String> = schema
                .columns
                .iter()
                .filter(|column| column.primary_key)
                .map(|column| column.name.clone())
                .collect();
            rows_sql(&entity, &pk_columns, DEFAULT_ROW_LIMIT, offset)?
        }
        // An unexpected (non-Schema) shape from DESCRIBE: fall back to the
        // same "no primary key derivable" path `rows_sql` already handles,
        // rather than inventing a new error for a case that cannot occur
        // against a well-behaved canister. `rows_sql` itself refuses to
        // build unordered SQL for this, so this still ends in a clear error,
        // not a silent unordered/unbounded `SELECT`.
        Ok(_) => rows_sql(&entity, &[], DEFAULT_ROW_LIMIT, offset)?,
        Err(AppError::IntrospectionDisabled) => {
            return Err(AppError::RowPagingRequiresIntrospection {
                entity: entity.clone(),
            })
        }
        Err(other) => return Err(other),
    };

    query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        &sql,
    )
    .await
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
    identity: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
) -> Result<SqlRunDto, AppError> {
    let project = project.snapshot().ok_or(AppError::NoProjectSelected)?;
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    let canister_id = parse_principal(&canister)?;

    // Classify first: a rejected statement returns immediately, before the
    // agent is even fetched, so it never contacts the canister.
    let statement = classify(&sql)?;
    let limited = apply_default_limit(&sql, statement, DEFAULT_ROW_LIMIT);

    let result = query_dto(
        &pool,
        &project.root,
        environment,
        identity_ref,
        canister_id,
        &limited.sql,
    )
    .await?;
    Ok(SqlRunDto {
        result,
        limit_appended: limited.limit_appended,
        order_by_missing: limited.order_by_missing,
    })
}

/// The result of switching projects: the newly-open project, plus a warning
/// if the choice could not be remembered.
///
/// The wrapper exists for one reason. A config-write failure has nowhere to
/// go in a bare `Project`, and reusing `Project::error` for it would render
/// a *storage* problem in the same banner as a *discovery* problem — two
/// unrelated conditions with one explanation. Keeping `project` a plain
/// `Project` means the frontend adopts a switched project through the exact
/// code path it uses at launch.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSelection {
    pub project: Project,
    /// `Some` when the project was adopted but will not be remembered next
    /// launch. Never a reason to fail the switch.
    pub persist_warning: Option<String>,
}

/// Opens the project at `path`, making it the one every other command sees.
///
/// In order: check the path is a directory, resolve it up to the nearest
/// `.icp/`, discover, clear the agent pool, swap the state, remember the
/// choice.
///
/// Two deliberate choices about failure. First, an unusable *path* is an
/// `Err` and changes nothing — the previously open project stays open and
/// the pool is untouched — because nothing was adopted. Second, a `discover()`
/// failure is **not** an `Err`: it becomes a `Project` carrying the error,
/// exactly as at launch, so a directory with no `.icp/` is adopted and the
/// UI explains why it's empty. Refusing it would make an undeployed project
/// impossible to open, which this app deliberately supports.
///
/// The root is remembered even when it holds no `.icp/`. The user asked for
/// that folder; silently reverting to a different project on next launch
/// would be the more surprising behaviour.
#[tauri::command]
pub async fn select_project(
    path: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
    app: AppHandle,
) -> Result<ProjectSelection, AppError> {
    let picked = std::path::PathBuf::from(&path);
    if !picked.is_dir() {
        return Err(AppError::Io(format!(
            "{path} is not a directory, so it cannot be opened as a project"
        )));
    }

    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let root = resolve_root(&picked, home.as_deref());

    let discovered = discovery::discover(&root).unwrap_or_else(|error| Project {
        root: root.clone(),
        environments: Vec::new(),
        error: Some(error),
    });

    // Order matters: clear before swapping. Every cached agent belongs to
    // the project being left, and its key may collide with the incoming
    // project's (see `AgentPool::clear`).
    pool.clear().await;
    project.replace(discovered.clone());

    let persist_warning = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate the app config directory: {error}"))
        .and_then(|dir| write_recorded_root(&dir, &root))
        .err();

    Ok(ProjectSelection {
        project: discovered,
        persist_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_identity_reports_a_missing_name_rather_than_panicking() {
        let env = Environment {
            name: "local".into(),
            replica_url: "http://127.0.0.1:4943".into(),
            canisters: Vec::new(),
            identity: None,
            identities: vec![IdentityRef::new(
                "alice".into(),
                "secp256k1".into(),
                "keyring".into(),
                None,
            )],
            artifacts: Vec::new(),
        };

        assert_eq!(find_identity(&env, "alice").unwrap().name, "alice");

        let error = find_identity(&env, "nope").expect_err("should fail");
        let text = error.explanation();
        assert!(text.contains("nope"), "should name the identity: {text}");
        assert!(text.contains("local"), "should name the environment: {text}");
    }
}
