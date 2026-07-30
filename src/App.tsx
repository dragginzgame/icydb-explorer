import { useCallback, useEffect, useState } from "react";
import {
  canisterTree,
  describeTable,
  fetchRows,
  listEnvironments,
  listTables,
  runSql,
} from "./api/commands";
import type {
  AppErrorDto,
  EntityDto,
  Environment,
  ResultDto,
  RowsDto,
  SchemaDto,
  TreeNode,
} from "./api/types";
import { CanisterTree } from "./components/CanisterTree";
import { ErrorBanner } from "./components/ErrorBanner";
import { RowGrid } from "./components/RowGrid";
import { SchemaPanel } from "./components/SchemaPanel";
import { SqlConsole } from "./components/SqlConsole";
import { TableList } from "./components/TableList";

// Matches `DEFAULT_ROW_LIMIT` in `src-tauri/src/commands.rs`: `fetch_rows`
// always pages this many rows at a time. Scalar paging is LIMIT/OFFSET, not
// cursors (see Task 10), and the DTO carries no total — a full page just
// means there may be more, which is exactly what `hasMore` below encodes.
// Never fabricate a total beyond that.
const DEFAULT_ROW_LIMIT = 100;

const genericError = (explanation: string): AppErrorDto => ({ kind: "unknown", explanation });

function App() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentsError, setEnvironmentsError] = useState<AppErrorDto | null>(null);
  const [env, setEnv] = useState<string | null>(null);

  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeError, setTreeError] = useState<AppErrorDto | null>(null);
  const [canister, setCanister] = useState<string | null>(null);

  const [entities, setEntities] = useState<EntityDto[] | null>(null);
  const [entitiesError, setEntitiesError] = useState<AppErrorDto | null>(null);
  const [entity, setEntity] = useState<string | null>(null);

  const [schema, setSchema] = useState<SchemaDto | null>(null);
  const [schemaError, setSchemaError] = useState<AppErrorDto | null>(null);

  const [rows, setRows] = useState<RowsDto | null>(null);
  const [rowsError, setRowsError] = useState<AppErrorDto | null>(null);
  const [offset, setOffset] = useState(0);
  const [lastPageRowCount, setLastPageRowCount] = useState(0);

  const [sqlError, setSqlError] = useState<AppErrorDto | undefined>(undefined);
  const [sqlLimitAppended, setSqlLimitAppended] = useState(false);
  const [sqlResult, setSqlResult] = useState<ResultDto | null>(null);

  // Discover the configured environments once on launch.
  useEffect(() => {
    listEnvironments()
      .then((discovered) => {
        setEnvironments(discovered);
        if (discovered.length > 0) {
          setEnv(discovered[0].name);
        }
      })
      .catch((error: AppErrorDto) => setEnvironmentsError(error));
  }, []);

  // The fleet tree is the only way canisters are discovered at all — a
  // failure to load it must be visible, never a silently empty tree.
  useEffect(() => {
    setTree(null);
    setTreeError(null);
    setCanister(null);
    if (!env) return;
    canisterTree(env)
      .then(setTree)
      .catch((error: AppErrorDto) => setTreeError(error));
  }, [env]);

  useEffect(() => {
    setEntities(null);
    setEntitiesError(null);
    setEntity(null);
    if (!env || !canister) return;
    listTables(env, canister)
      .then((result) => {
        if (result.type === "entities") {
          setEntities(result.entities);
        } else {
          setEntitiesError(genericError("list_tables returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => setEntitiesError(error));
  }, [env, canister]);

  useEffect(() => {
    setSchema(null);
    setSchemaError(null);
    setRows(null);
    setRowsError(null);
    setOffset(0);
    setLastPageRowCount(0);
    if (!env || !canister || !entity) return;

    describeTable(env, canister, entity)
      .then((result) => {
        if (result.type === "schema") {
          setSchema(result);
        } else {
          setSchemaError(genericError("describe_table returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => setSchemaError(error));

    fetchRows(env, canister, entity, 0)
      .then((result) => {
        if (result.type === "rows") {
          setRows(result);
          setLastPageRowCount(result.rowCount);
        } else {
          setRowsError(genericError("fetch_rows returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => setRowsError(error));
  }, [env, canister, entity]);

  const loadMore = useCallback(() => {
    if (!env || !canister || !entity) return;
    const nextOffset = offset + DEFAULT_ROW_LIMIT;
    fetchRows(env, canister, entity, nextOffset)
      .then((result) => {
        if (result.type !== "rows") {
          setRowsError(genericError("fetch_rows returned an unexpected result shape."));
          return;
        }
        setRows((previous) =>
          previous ? { ...result, rows: [...previous.rows, ...result.rows] } : result,
        );
        setLastPageRowCount(result.rowCount);
        setOffset(nextOffset);
      })
      .catch((error: AppErrorDto) => setRowsError(error));
  }, [env, canister, entity, offset]);

  const handleRunSql = useCallback(
    (sql: string) => {
      if (!env || !canister) return;
      setSqlError(undefined);
      setSqlResult(null);
      runSql(env, canister, sql)
        .then((run) => {
          setSqlResult(run.result);
          setSqlLimitAppended(run.limitAppended);
        })
        .catch((error: AppErrorDto) => {
          setSqlError(error);
          setSqlLimitAppended(false);
        });
    },
    [env, canister],
  );

  // A full page (== DEFAULT_ROW_LIMIT rows on the most recently fetched
  // page) means there may be more; there is no COUNT here, so this never
  // claims a total.
  const hasMore = lastPageRowCount === DEFAULT_ROW_LIMIT;

  return (
    <main className="flex h-screen flex-col bg-white text-gray-900">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">icydb Explorer</h1>
        {environments.length > 0 && (
          <select
            value={env ?? ""}
            onChange={(event) => setEnv(event.target.value)}
            className="rounded border px-2 py-1 text-sm"
          >
            {environments.map((environment) => (
              <option key={environment.name} value={environment.name}>
                {environment.name}
              </option>
            ))}
          </select>
        )}
      </header>

      {environmentsError && (
        <div className="p-2">
          <ErrorBanner error={environmentsError} />
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-64 shrink-0 overflow-auto border-r p-2">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">Canisters</h2>
          {treeError && <ErrorBanner error={treeError} />}
          {tree && <CanisterTree tree={tree} selectedPid={canister} onSelect={setCanister} />}
        </aside>

        <aside className="w-72 shrink-0 overflow-auto border-r p-2">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">Tables</h2>
          {entitiesError && <ErrorBanner error={entitiesError} />}
          {entities && <TableList entities={entities} selected={entity} onSelect={setEntity} />}

          {schemaError && (
            <div className="mt-4">
              <ErrorBanner error={schemaError} />
            </div>
          )}
          {schema && (
            <div className="mt-4">
              <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">Schema</h2>
              <SchemaPanel schema={schema} />
            </div>
          )}
        </aside>

        <section className="flex flex-1 flex-col overflow-hidden p-2">
          <div className="flex-1 overflow-auto">
            {rowsError && <ErrorBanner error={rowsError} />}
            {rows && <RowGrid rows={rows} hasMore={hasMore} onLoadMore={loadMore} />}
            {!rows && !rowsError && entity && (
              <p className="p-2 text-sm text-gray-500">Loading rows…</p>
            )}
          </div>

          <div className="mt-4 shrink-0 border-t pt-2">
            <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">SQL console</h2>
            <SqlConsole onRun={handleRunSql} error={sqlError} limitAppended={sqlLimitAppended} />
            {sqlResult && (
              <div className="mt-2 max-h-64 overflow-auto">
                <SqlResultView result={sqlResult} />
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

// Renders whichever of the eight `ResultDto` variants a console statement
// produced. Only "rows" reuses `RowGrid` (a one-off query has no paging
// state of its own, so `hasMore` is always false here); the rest get a
// small dedicated rendering since reusing `TableList`/`CanisterTree` here
// would require selection callbacks that don't apply to a static result.
function SqlResultView({ result }: { result: ResultDto }) {
  if (result.type === "rows") {
    return <RowGrid rows={result} hasMore={false} onLoadMore={() => {}} />;
  }
  if (result.type === "schema") {
    return <SchemaPanel schema={result} />;
  }
  if (result.type === "entities") {
    return (
      <ul className="text-sm">
        {result.entities.map((e) => (
          <li key={e.name}>
            {e.name} — {e.columns} columns · {e.indexes} indexes
          </li>
        ))}
      </ul>
    );
  }
  if (result.type === "count") {
    return (
      <p className="text-sm">
        {result.entity}: {result.rowCount} row(s)
      </p>
    );
  }
  if (result.type === "explain") {
    return <pre className="whitespace-pre-wrap text-xs">{result.explain}</pre>;
  }
  if (result.type === "indexes") {
    return (
      <ul className="list-disc pl-5 text-sm">
        {result.indexes.map((index) => (
          <li key={index} className="font-mono text-xs">
            {index}
          </li>
        ))}
      </ul>
    );
  }
  if (result.type === "stores") {
    return (
      <ul className="text-sm">
        {result.stores.map((store) => (
          <li key={store.storePath}>
            {store.storePath} — {store.storage}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="text-sm">
      {result.memory.map((entry) => (
        <li key={entry.memoryId}>
          {entry.tag} (#{entry.memoryId}) — {entry.storePath}
        </li>
      ))}
    </ul>
  );
}

export default App;
