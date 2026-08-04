// Thin typed wrappers over Tauri's `invoke`, one per backend command declared
// in `src-tauri/src/commands.rs`. Command names are passed to `invoke`
// exactly as declared in Rust (snake_case) — Tauri does not rename the
// command name itself. Argument keys are the Rust parameter names (`env`,
// `canister`, `entity`, `offset`, `sql`). Confirmed on the JS side:
// `@tauri-apps/api` 2.11.1's `invoke` passes the args object straight to
// `window.__TAURI_INTERNALS__.invoke` with no key transformation of its
// own. Whether the `#[tauri::command]` macro itself renames snake_case
// parameters to camelCase on the Rust side wasn't independently verified —
// but every parameter above is already a single lowercase word, so that
// distinction can't actually surface here regardless of which convention
// wins.
//
// When a Tauri command returns `Err(AppError)`, the promise rejects with
// whatever `AppError`'s `Serialize` impl produced — i.e. an object shaped
// exactly like `AppErrorDto` (see `src-tauri/src/error.rs`). Each wrapper
// below catches and re-throws that value as `AppErrorDto` so callers can
// render `.explanation` directly. A rejection that *isn't* already shaped
// like an `AppErrorDto` (e.g. Tauri's own IPC-level failures) is normalized
// into one rather than left as an opaque string or `Error`.
import { invoke } from "@tauri-apps/api/core";

import { toAppErrorDto } from "./errors";
import type {
  Project,
  ProjectSelection,
  ResultDto,
  SqlCapabilities,
  SqlRunDto,
  SweepRunDto,
  TreeNode,
} from "./types";

/** Returns the open project, or `null` if the user hasn't chosen one — a
 * first launch, or a remembered root that has since vanished. */
export async function listEnvironments(): Promise<Project | null> {
  try {
    return await invoke<Project | null>("list_environments");
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Opens the project at `path`, which becomes the project every other
 * command sees. Resolves the path up to the nearest `.icp/` and clears the
 * backend's agent cache — see
 * `src-tauri/src/commands.rs::select_project`.
 *
 * A directory with no `.icp/` anywhere above it still resolves: it comes
 * back as a `Project` whose `error` explains why it's empty, not as a
 * rejection. Only an unusable *path* rejects, and in that case the
 * previously open project stays open. */
export async function selectProject(path: string): Promise<ProjectSelection> {
  try {
    return await invoke<ProjectSelection>("select_project", { path });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Selects `identity` for `env`, exporting it eagerly so a bad identity
 * (an unsupported kind, a missing key file, a keyring export the user
 * declines) fails now rather than on the first query that uses it — see
 * `src-tauri/src/commands.rs::select_identity`. */
export async function selectIdentity(env: string, identity: string): Promise<void> {
  try {
    return await invoke<void>("select_identity", { env, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Returns a forest — one `TreeNode` per named canister in the
 * environment's mapping, not a single tree (see `Environment.canisters`). */
export async function canisterTree(env: string, identity: string): Promise<TreeNode[]> {
  try {
    return await invoke<TreeNode[]>("canister_tree", { env, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/// `SELECT COUNT(*)` for one entity.
///
/// One call per entity, because counting is a full scan — see the Rust
/// `count_rows` for why this is not folded into `listTables`.
/// `EXPLAIN` of the statement the rows pane is running.
///
/// Needs the canister to have icydb's `sql-explain` feature. That is
/// undetectable from outside — EXPLAIN travels through the same `icydb_query`
/// method, so a canister without it looks identical and simply rejects the
/// statement. The rejection is the answer; this cannot be pre-disabled.
export async function explainRows(
  env: string,
  canister: string,
  entity: string,
  offset: number,
  identity: string,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("explain_rows", { env, canister, entity, offset, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/// Writes an exported file to a path the user chose.
///
/// Serialising happens here (the rows are already in hand); writing happens in
/// Rust, so the privileged step stays on one side.
export async function writeExport(path: string, contents: string): Promise<void> {
  try {
    await invoke<void>("write_export", { path, contents });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/// Which offered identity actually controls this canister, if any.
///
/// The declared default is considered first, so it is kept whenever it works.
/// `null` means none of the project's identities control it — which no choice
/// here can fix, and the caller should say so rather than switch blindly.
export async function preferredIdentityFor(
  env: string,
  canister: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("preferred_identity_for", { env, canister });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/// Which icydb SQL endpoints this canister exports.
///
/// A certified metadata read, not a statement — cheap, and it cannot mutate
/// anything. Gate any editing UI on `update`; never assume it.
export async function sqlCapabilities(
  env: string,
  canister: string,
  identity: string,
): Promise<SqlCapabilities> {
  try {
    return await invoke<SqlCapabilities>("sql_capabilities", { env, canister, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function countRows(
  env: string,
  canister: string,
  entity: string,
  identity: string,
): Promise<number> {
  try {
    return await invoke<number>("count_rows", { env, canister, entity, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function listTables(
  env: string,
  canister: string,
  identity: string,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("list_tables", { env, canister, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function describeTable(
  env: string,
  canister: string,
  entity: string,
  identity: string,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("describe_table", { env, canister, entity, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function fetchRows(
  env: string,
  canister: string,
  entity: string,
  offset: number,
  identity: string,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("fetch_rows", { env, canister, entity, offset, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Runs one statement against several canisters, reporting each outcome.
 *
 * The whole of "cross-canister" in this app: icydb has no JOIN and no
 * cross-database addressing, so a statement spanning canisters is the same
 * statement sent to each, correlated here. Concurrent on the Rust side.
 *
 * Rejects only when the *request* is bad — an unclassifiable statement, an
 * unknown environment, a malformed principal. A canister that cannot answer is
 * an outcome, not a rejection, so a partly-authorised sweep still resolves. */
export async function runSqlMany(
  env: string,
  canisters: string[],
  sql: string,
  identity: string,
): Promise<SweepRunDto> {
  try {
    return await invoke<SweepRunDto>("run_sql_many", { env, canisters, sql, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function runSql(
  env: string,
  canister: string,
  sql: string,
  identity: string,
): Promise<SqlRunDto> {
  try {
    return await invoke<SqlRunDto>("run_sql", { env, canister, sql, identity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}
