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
import type { AppErrorDto, Project, ResultDto, SqlRunDto, TreeNode } from "./types";

function isAppErrorDto(error: unknown): error is AppErrorDto {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string" &&
    typeof (error as { explanation?: unknown }).explanation === "string"
  );
}

function toAppErrorDto(error: unknown): AppErrorDto {
  if (isAppErrorDto(error)) {
    return error;
  }
  const explanation = error instanceof Error ? error.message : String(error);
  return { kind: "unknown", explanation };
}

export async function listEnvironments(): Promise<Project> {
  try {
    return await invoke<Project>("list_environments");
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Returns a forest — one `TreeNode` per named canister in the
 * environment's mapping, not a single tree (see `Environment.canisters`). */
export async function canisterTree(env: string): Promise<TreeNode[]> {
  try {
    return await invoke<TreeNode[]>("canister_tree", { env });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function listTables(env: string, canister: string): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("list_tables", { env, canister });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function describeTable(
  env: string,
  canister: string,
  entity: string,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("describe_table", { env, canister, entity });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function fetchRows(
  env: string,
  canister: string,
  entity: string,
  offset: number,
): Promise<ResultDto> {
  try {
    return await invoke<ResultDto>("fetch_rows", { env, canister, entity, offset });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

export async function runSql(env: string, canister: string, sql: string): Promise<SqlRunDto> {
  try {
    return await invoke<SqlRunDto>("run_sql", { env, canister, sql });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}
