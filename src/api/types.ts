// Mirrors of the Tauri backend's DTOs (see `src-tauri/src/view/dto.rs`,
// `src-tauri/src/discovery/types.rs`, `src-tauri/src/topology/types.rs`, and
// `src-tauri/src/commands.rs`). These are the app's own shapes, deliberately
// decoupled from icydb — this file must never import, mirror, or hand-decode
// an icydb type. If a backend DTO changes, update this file to match; do not
// let this file drift into inventing its own shapes.

/** One rendered cell: a `kind` for styling/type-aware rendering plus a
 * ready-to-display `display` string. */
export type ValueDto = { kind: string; display: string };

/** A page of rows, whether from a plain projection or a grouped query.
 * `nextCursor` is only ever populated for grouped results. */
export type RowsDto = {
  entity: string;
  columns: string[];
  rows: ValueDto[][];
  rowCount: number;
  nextCursor: string | null;
};

/** One column entry, shared by `SHOW COLUMNS` and `DESCRIBE`. */
export type ColumnDto = { name: string; typeName: string; primaryKey: boolean; optional: boolean };

/** A `DESCRIBE`/`SHOW COLUMNS` result. `indexes` is empty for `SHOW COLUMNS`. */
export type SchemaDto = { entity: string; columns: ColumnDto[]; indexes: string[] };

/** One `SHOW ENTITIES` row. */
export type EntityDto = {
  name: string;
  storePath: string;
  storage: string;
  columns: number;
  indexes: number;
  relations: number;
  schemaVersion: number;
};

/** One `SHOW STORES` row. */
export type StoreDto = { storePath: string; storage: string };

/** One `SHOW MEMORY` row. */
export type MemoryDto = { tag: string; memoryId: number; storePath: string };

/** One constraint from `SHOW CONSTRAINTS` (see
 * `src-tauri/src/view/dto.rs::ConstraintDto`). Six of icydb's sixteen
 * `EntityConstraintDescription` accessors — the rest have no UI consumer. */
export type ConstraintDto = {
  name: string;
  kind: string;
  origin: string;
  validationState: string;
  fields: string[];
  semantics: string;
};

/** The frontend-facing shape of a SQL query result, internally tagged on
 * `type` (see `src-tauri/src/view/dto.rs::ResultDto`). Nine variants. */
export type ResultDto =
  | ({ type: "rows" } & RowsDto)
  | ({ type: "schema" } & SchemaDto)
  | { type: "entities"; entities: EntityDto[] }
  | { type: "count"; entity: string; rowCount: number }
  | { type: "explain"; entity: string; explain: string }
  | { type: "indexes"; entity: string; indexes: string[] }
  | { type: "stores"; stores: StoreDto[] }
  | { type: "memory"; memory: MemoryDto[] }
  | { type: "constraints"; entity: string; constraints: ConstraintDto[] };

/** A node in the canic-orchestrated fleet topology (see
 * `src-tauri/src/topology/types.rs::TreeNode`). Field names are all single
 * words, so no camelCase rename applies. `canisterTree` returns an array of
 * these — a forest, one tree per named canister in the environment's
 * mapping, not a single root. */
export type TreeNode = { pid: string; role: string; children: TreeNode[] };

/** The backend's single error shape (see `src-tauri/src/error.rs::AppError`).
 * `explanation` is operator-facing prose safe to render directly. */
export type AppErrorDto = { kind: string; explanation: string };

/** The frontend-facing result of `run_sql`: the query's `ResultDto`, plus
 * whether the backend silently appended a `LIMIT` the user didn't type, plus
 * whether no `LIMIT` was appended specifically because the statement has no
 * `ORDER BY` (icydb rejects `LIMIT`/`OFFSET` without one). */
export type SqlRunDto = { result: ResultDto; limitAppended: boolean; orderByMissing: boolean };

// `list_environments` returns a `Project` (see `src-tauri/src/discovery/types.rs`).
export type IdentityRef = {
  name: string;
  algorithm: string;
  kind: string;
  pemPath: string | null;
  /// Why this app cannot use this identity, or null if it can. Computed by
  /// `IdentityRef::new` in `src-tauri/src/discovery/types.rs` and rendered
  /// verbatim here — the rule is not re-implemented in TypeScript.
  unusableReason: string | null;
};
export type CanisterArtifact = { role: string; didPath: string };

/** One entry from `.icp/cache/mappings/<network>.ids.json`: a name the
 * project (or canic) gave a canister, and the id it resolved to. Every
 * entry is a forest root in its own right — see `Environment`'s doc
 * comment and `canisterTree`'s return shape. */
export type NamedCanister = { name: string; id: string };

export type Environment = {
  name: string;
  replicaUrl: string;
  /** A forest, not a single root: `.icp/cache/mappings/<network>.ids.json`
   * is a name→id map with no guaranteed `root` entry (a canic fleet like
   * toko has only `root`; a plain project may list its canisters directly
   * with no root at all). `canisterTree(env)` walks each entry. */
  canisters: NamedCanister[];
  identity: IdentityRef | null;
  /** Every identity the resolved store declares, usable or not — see
   * `IdentityRef.unusableReason`. The UI lists all of them so an
   * unsupported identity reads as unsupported rather than missing. */
  identities: IdentityRef[];
  artifacts: CanisterArtifact[];
};

/** The discovered project. `error` carries a `discover()` failure (e.g. no
 * `.icp/` directory at all) — `null` both on success and on a merely
 * undeployed project (zero environments, no error is not a failure).
 * `listEnvironments` returns `null` for the project itself when the user
 * has not chosen one yet: a first launch, or a remembered root that has
 * since been moved or deleted. */
export type Project = {
  root: string;
  environments: Environment[];
  error: AppErrorDto | null;
};

/** The result of `selectProject` (see
 * `src-tauri/src/commands.rs::ProjectSelection`). `project` is a plain
 * `Project`, identical to what `listEnvironments` returns, so both paths
 * adopt a project through the same code. `persistWarning` is set when the
 * project was opened but the choice could not be remembered for next
 * launch — a note, never a failure. */
export type ProjectSelection = { project: Project; persistWarning: string | null };
