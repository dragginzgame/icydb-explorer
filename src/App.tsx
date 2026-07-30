import { useCallback, useEffect, useRef, useState } from "react";
import {
  canisterTree,
  describeTable,
  fetchRows,
  listEnvironments,
  listTables,
  runSql,
  selectIdentity,
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
import { IdentitySelector } from "./components/IdentitySelector";
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

// The initial-selection rule: the configured default wins if it's usable,
// otherwise fall back to the first usable entry in `identities` rather
// than leaving the session stuck on an identity the backend would reject
// (or, worse, silently picking an unusable one). `unusableReason` is read
// verbatim — never re-derived from `kind`.
//
// This isn't only "initial": it's re-applied by the effect below every
// time `env` changes, not just on first load. An identity name carried
// over from the previous environment is only meaningful by coincidence —
// `identities` is per-environment, and a same-named identity in the new
// environment may be unusable (or simply absent) even though it was fine a
// moment ago. Re-deriving from scratch avoids both silently querying with
// a stale identity `find_identity` would still resolve by name, and
// surfacing an obscure agent-level failure instead of a clear one.
function initialIdentityFor(environment: Environment): string | null {
  const configured = environment.identity;
  if (configured && configured.unusableReason === null) {
    return configured.name;
  }
  const fallback = environment.identities.find((candidate) => candidate.unusableReason === null);
  return fallback ? fallback.name : null;
}

// Explains why `initialIdentityFor` came back `null` for `environment` — a
// store holding only `anonymous`, only unrecognised kinds, or no identities
// at all. This is exactly the case the show-unusable-with-reason design
// exists for (`unusableReason` on every `IdentityRef`), so when there is
// truly nothing selectable, that design should still be the thing the user
// sees, not a blank window with no explanation.
function noUsableIdentitySummary(environment: Environment): string {
  if (environment.identities.length === 0) {
    return "No identities were found in the icp identity store. Run `icp identity new` to create one.";
  }
  const reasons = environment.identities
    .filter((candidate) => candidate.unusableReason !== null)
    .map((candidate) => `${candidate.name} (${candidate.unusableReason})`)
    .join("; ");
  return `No usable identity is available for this environment. ${reasons}`;
}

function App() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentsError, setEnvironmentsError] = useState<AppErrorDto | null>(null);
  const [environmentsLoaded, setEnvironmentsLoaded] = useState(false);
  const [env, setEnv] = useState<string | null>(null);

  // The session's chosen `icp` identity, by name. Initialised once the
  // environments load (see the effect below) and changed only through
  // `handleSelectIdentity`, which calls `selectIdentity` first and only
  // updates this on success — see that handler's doc comment for why.
  const [identity, setIdentity] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<AppErrorDto | null>(null);

  // A forest, not a single tree: see `Environment.canisters`'s doc comment.
  const [forest, setForest] = useState<TreeNode[] | null>(null);
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
  const [sqlOrderByMissing, setSqlOrderByMissing] = useState(false);
  const [sqlResult, setSqlResult] = useState<ResultDto | null>(null);

  // Discover the configured environments once on launch. `listEnvironments`
  // returns the whole `Project`, whose `error` field carries a `discover()`
  // failure (e.g. no `.icp/` at all) rather than that failure being
  // indistinguishable from "this project just has no environments yet" —
  // see `Project`'s doc comment. Both are rendered explicitly below rather
  // than as a silent blank pane.
  useEffect(() => {
    listEnvironments()
      .then((project) => {
        setEnvironments(project.environments);
        setEnvironmentsError(project.error);
        if (project.environments.length > 0) {
          const firstEnvironment = project.environments[0];
          setEnv(firstEnvironment.name);
          setIdentity(initialIdentityFor(firstEnvironment));
        }
      })
      .catch((error: AppErrorDto) => setEnvironmentsError(error))
      .finally(() => setEnvironmentsLoaded(true));
  }, []);

  // Tracks the *latest requested* `handleSelectIdentity` call — see that
  // handler's doc comment below for why. Declared here, ahead of both
  // handlers that touch it, because `handleSelectEnvironment` also needs to
  // clear it: switching environments abandons whatever identity selection
  // was in flight, and without clearing this ref a slow keyring export for
  // the *old* environment's identity would still pass the "am I the latest
  // request" check when it finally settles (that check only ever compared
  // against itself, never against a environment change happening out from
  // under it) and could plant an error banner — or, on success, call
  // `setIdentity` — for an identity that may not even exist in the
  // environment the user has since switched to.
  const identityRequestRef = useRef<{ env: string; name: string } | null>(null);

  // The one place `env` changes after the initial load: re-derives
  // `identity` via `initialIdentityFor` in the *same* handler, rather than
  // in a separate effect keyed on `env`. A separate effect would still be
  // correct eventually, but for one render in between it would leave `env`
  // already updated while `identity` (a different piece of state) still
  // held the previous environment's value — and the forest effect below,
  // which depends on both, would fire in that window with a real
  // (env, identity) pair that's simply wrong: the new environment paired
  // with an identity that may not even be in its `identities` list. Setting
  // both here, in one synchronous handler, means React batches them into a
  // single commit, so no effect ever observes that mismatched combination.
  const handleSelectEnvironment = useCallback(
    (name: string) => {
      const nextEnvironment = environments.find((candidate) => candidate.name === name);
      setEnv(name);
      setIdentity(nextEnvironment ? initialIdentityFor(nextEnvironment) : null);
      setIdentityError(null);
      // Abandons any in-flight `handleSelectIdentity` request for the
      // environment being left: its `.then`/`.catch` compares against this
      // ref, so nulling it here means that request can never again match
      // and is dropped, however long its keyring export takes to settle.
      identityRequestRef.current = null;
    },
    [environments],
  );

  // The fleet forest is the only way canisters are discovered at all — a
  // failure to load it must be visible, never a silently empty tree.
  //
  // `cancelled` guards every `setState` below against a stale response: if
  // `env` changes again before this fetch resolves, the cleanup flips
  // `cancelled` to true so the in-flight promise's `.then`/`.catch` becomes
  // a no-op instead of clobbering whatever the newer selection already set.
  useEffect(() => {
    setForest(null);
    setTreeError(null);
    setCanister(null);
    if (!env || !identity) return;
    let cancelled = false;
    canisterTree(env, identity)
      .then((result) => {
        if (cancelled) return;
        setForest(result);
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setTreeError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [env, identity]);

  useEffect(() => {
    setEntities(null);
    setEntitiesError(null);
    setEntity(null);
    if (!env || !canister || !identity) return;
    let cancelled = false;
    listTables(env, canister, identity)
      .then((result) => {
        if (cancelled) return;
        if (result.type === "entities") {
          setEntities(result.entities);
        } else {
          setEntitiesError(genericError("list_tables returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setEntitiesError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [env, canister, identity]);

  useEffect(() => {
    setSchema(null);
    setSchemaError(null);
    setRows(null);
    setRowsError(null);
    setOffset(0);
    setLastPageRowCount(0);
    if (!env || !canister || !entity || !identity) return;
    let cancelled = false;

    describeTable(env, canister, entity, identity)
      .then((result) => {
        if (cancelled) return;
        if (result.type === "schema") {
          setSchema(result);
        } else {
          setSchemaError(genericError("describe_table returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setSchemaError(error);
      });

    fetchRows(env, canister, entity, 0, identity)
      .then((result) => {
        if (cancelled) return;
        if (result.type === "rows") {
          setRows(result);
          setLastPageRowCount(result.rowCount);
        } else {
          setRowsError(genericError("fetch_rows returned an unexpected result shape."));
        }
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setRowsError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [env, canister, entity, identity]);

  // `loadMore` isn't tied to a `useEffect` cleanup (it's fired from a click,
  // not a selection change), so it uses a request-token equivalent instead:
  // `selectionRef` always holds the *currently selected* env/canister/entity,
  // updated by the effect below on every selection change. If the user picks
  // a different table (or canister, or environment) while a "Load more"
  // fetch for the old one is still in flight, the stale response's selection
  // snapshot won't match `selectionRef.current` when it resolves, and it's
  // dropped instead of appending pages from the wrong table onto the new
  // selection's (just-reset-to-null) rows.
  const selectionRef = useRef<{
    env: string | null;
    canister: string | null;
    entity: string | null;
    identity: string | null;
  }>({ env: null, canister: null, entity: null, identity: null });
  useEffect(() => {
    selectionRef.current = { env, canister, entity, identity };
  }, [env, canister, entity, identity]);

  const loadMore = useCallback(() => {
    if (!env || !canister || !entity || !identity) return;
    const nextOffset = offset + DEFAULT_ROW_LIMIT;
    const isStale = () => {
      const current = selectionRef.current;
      return (
        current.env !== env ||
        current.canister !== canister ||
        current.entity !== entity ||
        current.identity !== identity
      );
    };
    fetchRows(env, canister, entity, nextOffset, identity)
      .then((result) => {
        if (isStale()) return;
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
      .catch((error: AppErrorDto) => {
        if (isStale()) return;
        setRowsError(error);
      });
  }, [env, canister, entity, identity, offset]);

  // The only async path with no staleness guard before this fix: switching
  // canisters (or, now, identities) while a console query is still in
  // flight could otherwise land an old selection's result under the
  // newly-selected one's label. Reuses `selectionRef` (env/canister/identity
  // — the console has no `entity` of its own) rather than a second
  // cancellation mechanism, matching `loadMore`'s pattern.
  const handleRunSql = useCallback(
    (sql: string) => {
      if (!env || !canister || !identity) return;
      const requestEnv = env;
      const requestCanister = canister;
      const requestIdentity = identity;
      const isStale = () =>
        selectionRef.current.env !== requestEnv ||
        selectionRef.current.canister !== requestCanister ||
        selectionRef.current.identity !== requestIdentity;

      setSqlError(undefined);
      setSqlResult(null);
      runSql(requestEnv, requestCanister, sql, requestIdentity)
        .then((run) => {
          if (isStale()) return;
          setSqlResult(run.result);
          setSqlLimitAppended(run.limitAppended);
          setSqlOrderByMissing(run.orderByMissing);
        })
        .catch((error: AppErrorDto) => {
          if (isStale()) return;
          setSqlError(error);
          setSqlLimitAppended(false);
          setSqlOrderByMissing(false);
        });
    },
    [env, canister, identity],
  );

  // A full page (== DEFAULT_ROW_LIMIT rows on the most recently fetched
  // page) means there may be more; there is no COUNT here, so this never
  // claims a total.
  const hasMore = lastPageRowCount === DEFAULT_ROW_LIMIT;

  const currentEnvironment = environments.find((candidate) => candidate.name === env) ?? null;

  // `selectIdentity` performs an eager export (see its doc comment in
  // `src-tauri/src/commands.rs`), so it's called *before* any local state
  // changes: a bad identity fails right here, and the previous selection is
  // left in place rather than the UI optimistically switching and then
  // reporting an error against an identity the backend never actually
  // accepted.
  //
  // A keyring identity's eager export can take up to 20s (see
  // `EXPORT_TIMEOUT` in `src-tauri/src/agent/export.rs`) before it fails, so
  // this — unlike every other async path in this file — had no staleness
  // guard: picking a password-protected identity, then picking a working one
  // before the first call resolves, would let the working selection succeed
  // and then, ~20s later, the first (abandoned) selection's rejection would
  // still fire `setIdentityError`, planting a persistent error banner about
  // an identity the user isn't even using anymore. `identityRequestRef`
  // (declared above, alongside `handleSelectEnvironment`) tracks the
  // *latest requested* selection — a fresh object per call, so a
  // `.then`/`.catch` firing for any request other than the most recent one
  // (by reference identity) is dropped, same idea as `selectionRef` above,
  // scoped to just this one in-flight request rather than the whole
  // env/canister/entity/identity tuple.
  const handleSelectIdentity = useCallback(
    (name: string) => {
      if (!env) return;
      const request = { env, name };
      identityRequestRef.current = request;
      selectIdentity(env, name)
        .then(() => {
          if (identityRequestRef.current !== request) return;
          setIdentityError(null);
          setIdentity(name);
        })
        .catch((error: AppErrorDto) => {
          if (identityRequestRef.current !== request) return;
          setIdentityError(error);
        });
    },
    [env],
  );

  return (
    <main className="flex h-screen flex-col bg-white text-gray-900">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">icydb Explorer</h1>
        {environments.length > 0 && (
          <select
            value={env ?? ""}
            onChange={(event) => handleSelectEnvironment(event.target.value)}
            className="rounded border px-2 py-1 text-sm"
          >
            {environments.map((environment) => (
              <option key={environment.name} value={environment.name}>
                {environment.name}
              </option>
            ))}
          </select>
        )}
        <IdentitySelector
          identities={currentEnvironment?.identities ?? []}
          selected={identity}
          onSelect={handleSelectIdentity}
        />
      </header>

      {environmentsError && (
        <div className="p-2">
          <ErrorBanner error={environmentsError} />
        </div>
      )}

      {identityError && (
        <div className="p-2">
          <ErrorBanner error={identityError} />
        </div>
      )}

      {/* An explicit empty state, not a silently blank window: a `discover()`
          failure of Critical 1's own class (a project layout this app
          doesn't understand) must be visible, not indistinguishable from a
          project that simply hasn't been deployed yet. */}
      {environmentsLoaded && environments.length === 0 && !environmentsError && (
        <div className="p-2">
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            No environments were found in this project&apos;s <code>.icp/</code> layout. Deploy
            it (e.g. <code>icp network start</code>, <code>icp canister create</code>,{" "}
            <code>icp canister install</code>) and relaunch this app.
          </p>
        </div>
      )}

      {/* Another explicit empty state, of the same class as the one above:
          `identity === null` means `initialIdentityFor` found nothing
          selectable for `currentEnvironment` (a store holding only
          `anonymous`, only unrecognised kinds, or nothing at all). Every
          effect below early-returns on a null identity, so without this the
          user would see empty panes with no explanation at all —
          `identityError` is only ever set by a *failed* `selectIdentity`
          call, never by there being nothing to select in the first place. */}
      {environmentsLoaded && currentEnvironment && identity === null && (
        <div className="p-2">
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            {noUsableIdentitySummary(currentEnvironment)}
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-64 shrink-0 overflow-auto border-r p-2">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">Canisters</h2>
          {treeError && <ErrorBanner error={treeError} />}
          {forest && <CanisterTree trees={forest} selectedPid={canister} onSelect={setCanister} />}
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
            <SqlConsole
              onRun={handleRunSql}
              error={sqlError}
              limitAppended={sqlLimitAppended}
              orderByMissing={sqlOrderByMissing}
            />
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
  if (result.type === "memory") {
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

  // Exhaustiveness guard: every `ResultDto` variant is handled by an `if`
  // above, so `result` is narrowed to `never` here. Adding a ninth variant
  // without a matching branch turns this into a compile error instead of a
  // silent runtime no-op.
  const exhaustiveCheck: never = result;
  return exhaustiveCheck;
}

export default App;
