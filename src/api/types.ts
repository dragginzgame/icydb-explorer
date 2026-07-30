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

/** The frontend-facing shape of a SQL query result, internally tagged on
 * `type` (see `src-tauri/src/view/dto.rs::ResultDto`). Eight variants. */
export type ResultDto =
  | ({ type: "rows" } & RowsDto)
  | ({ type: "schema" } & SchemaDto)
  | { type: "entities"; entities: EntityDto[] }
  | { type: "count"; entity: string; rowCount: number }
  | { type: "explain"; entity: string; explain: string }
  | { type: "indexes"; entity: string; indexes: string[] }
  | { type: "stores"; stores: StoreDto[] }
  | { type: "memory"; memory: MemoryDto[] };

/** A node in the canic-orchestrated fleet topology (see
 * `src-tauri/src/topology/types.rs::TreeNode`). Field names are all single
 * words, so no camelCase rename applies. */
export type TreeNode = { pid: string; role: string; children: TreeNode[] };

/** The backend's single error shape (see `src-tauri/src/error.rs::AppError`).
 * `explanation` is operator-facing prose safe to render directly. */
export type AppErrorDto = { kind: string; explanation: string };

/** The frontend-facing result of `run_sql`: the query's `ResultDto` plus
 * whether the backend silently appended a `LIMIT` the user didn't type. */
export type SqlRunDto = { result: ResultDto; limitAppended: boolean };

// `list_environments` returns these (see `src-tauri/src/discovery/types.rs`).
export type IdentityRef = { name: string; algorithm: string; pemPath: string };
export type CanisterArtifact = { role: string; didPath: string };
export type Environment = {
  name: string;
  replicaUrl: string;
  rootCanisterId: string | null;
  identity: IdentityRef | null;
  artifacts: CanisterArtifact[];
};
