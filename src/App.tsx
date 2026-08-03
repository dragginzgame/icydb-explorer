import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canisterTree,
  countRows,
  preferredIdentityFor,
  explainRows,
  sqlCapabilities,
  writeExport,
  describeTable,
  fetchRows,
  listEnvironments,
  listTables,
  runSql,
  selectIdentity,
  selectProject,
} from "./api/commands";
import type {
  AppErrorDto,
  EntityDto,
  Environment,
  Project,
  ResultDto,
  RowsDto,
  SchemaDto,
  TreeNode,
} from "./api/types";
import { CanisterTree, type QueryableMap } from "./components/CanisterTree";
import { exportFilename, exportRows, type ExportFormat } from "./lib/exportRows";
import { ErrorBanner } from "./components/ErrorBanner";
import { IdentitySelector } from "./components/IdentitySelector";
import { Pane } from "./components/Pane";
import { PaneEmpty } from "./components/PaneStates";
import { ProjectSelector } from "./components/ProjectSelector";
import { RowGrid } from "./components/RowGrid";
import { SchemaInspector } from "./components/SchemaInspector";
import { SchemaPanel } from "./components/SchemaPanel";
import { SettingsMenu } from "./components/SettingsMenu";
import { SqlConsole } from "./components/SqlConsole";
import { TableList, type RowCounts } from "./components/TableList";
import { usePaneLayout } from "./layout/usePaneLayout";
import { useTheme } from "./theme/useTheme";

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

/// The role a canister is known by, which is what a reader recognises — the
/// principal is an identifier, not a name.
function roleOf(trees: TreeNode[] | null, pid: string): string | null {
  return flattenForest(trees ?? []).find((node) => node.pid === pid)?.role ?? null;
}

/// Every canister in the forest, roots and descendants alike.
///
/// The tree is arbitrarily deep — a canic fleet nests shards under hubs under
/// root — so probing "the canisters" means walking it, not reading the top
/// level.
function flattenForest(trees: TreeNode[]): TreeNode[] {
  return trees.flatMap((tree) => [tree, ...flattenForest(tree.children)]);
}

function App() {
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  const { layout, setWidth, toggleSchema, setSqlExpanded } = usePaneLayout();

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentsError, setEnvironmentsError] = useState<AppErrorDto | null>(null);
  const [environmentsLoaded, setEnvironmentsLoaded] = useState(false);
  const [env, setEnv] = useState<string | null>(null);

  // The open project's absolute root, or null when none is open — a first
  // launch, or a remembered root that has since been moved or deleted.
  const [root, setRoot] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  // Set when a project was opened but the choice couldn't be remembered.
  // Deliberately not an `AppErrorDto`: failing to remember a choice is not
  // the same kind of event as failing to read a project, and rendering it
  // in `ErrorBanner` would say it was.
  const [persistWarning, setPersistWarning] = useState<string | null>(null);

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
  // Row counts, once asked for. Keyed by entity name and cleared whenever the
  // entity list is replaced, so a count can never be shown against a different
  // canister's table of the same name.
  const [queryable, setQueryable] = useState<QueryableMap>({});
  // Set when this app moved off the project's declared default identity because
  // that identity does not control the canisters. Shown rather than done
  // silently: switching who you are acting as is not something to do behind
  // someone's back.
  const [identityNote, setIdentityNote] = useState<string | null>(null);
  const [rowCounts, setRowCounts] = useState<RowCounts>({});
  const [counting, setCounting] = useState(false);

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

  // Incremented by every `adoptProject` call. The canister tree effect
  // depends on it so that adopting a project ALWAYS refetches the tree —
  // including when the incoming project's environment and identity names
  // happen to equal the outgoing one's, which is the common case (two
  // projects each having a `local` environment and a `default` identity).
  // Without this, `env` and `identity` are set to identical values, React
  // bails out of the update, the effect's dependencies never change, and the
  // previous project's canisters stay on screen — where clicking one would
  // query the OLD project's canister id through the NEW project's agent.
  const [projectGeneration, setProjectGeneration] = useState(0);

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

  // The single definition of "what opening a project means", shared by
  // launch and by every later switch. Two call sites deriving this
  // separately would drift — the same reason `resolve_identity_store` is one
  // function in `discovery` rather than duplicated per caller.
  const adoptProject = useCallback((project: Project) => {
    setRoot(project.root);
    setEnvironments(project.environments);
    setEnvironmentsError(project.error);
    setIdentityError(null);
    identityRequestRef.current = null;
    const first = project.environments[0] ?? null;
    setEnv(first?.name ?? null);
    setIdentity(first ? initialIdentityFor(first) : null);
    // Everything below the environment is derived from it, so a new project
    // invalidates all of it. The effects keyed on env/canister/entity clear
    // their own state, but `canister` and `entity` are selections, not
    // derived data, and would otherwise survive into a project where they
    // mean nothing. The canister tree itself is invalidated below by the
    // generation bump, not by `env`/`identity` changing — those can come out
    // identical to the outgoing project's when both happen to share an
    // environment and identity name, which is common, not an edge case.
    setCanister(null);
    setEntity(null);
    setSqlResult(null);
    setSqlError(undefined);
    setSqlLimitAppended(false);
    setSqlOrderByMissing(false);
    setProjectGeneration((generation) => generation + 1);
  }, []);

  // Load whatever project was remembered. `null` means none was — the
  // "choose a project" state, not a failure.
  //
  // `cancelled` guards against the near-zero-but-nonzero case where a user
  // completes a folder-picker dialog (`handleSelectProject`) before this
  // mount-time load resolves: without the guard, this call's `.then` would
  // fire after the picked project was already adopted and clobber it,
  // leaving the frontend showing the picked project while the backend's
  // `ProjectState` (and pool) had already moved on to it — the same
  // frontend/backend split the generation counter above exists to prevent.
  useEffect(() => {
    let cancelled = false;
    listEnvironments()
      .then((project) => {
        if (cancelled) return;
        if (project) adoptProject(project);
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setEnvironmentsError(error);
      })
      .finally(() => {
        if (cancelled) return;
        setEnvironmentsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [adoptProject]);

  // A rejected pick changes nothing: `select_project` only rejects on a path
  // it could not adopt at all, in which case the backend never swapped its
  // state, so the project on screen is still the one that's open.
  const handleSelectProject = useCallback(
    (path: string) => {
      setProjectBusy(true);
      setPersistWarning(null);
      selectProject(path)
        .then((selection) => {
          adoptProject(selection.project);
          setPersistWarning(selection.persistWarning);
        })
        .catch((error: AppErrorDto) => setEnvironmentsError(error))
        .finally(() => setProjectBusy(false));
    },
    [adoptProject],
  );

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
  //
  // Depends on `projectGeneration`, not just `env`/`identity`: two projects
  // commonly share an environment name (`local`) and a derived identity name
  // (`default`), in which case `adoptProject` sets `env` and `identity` to
  // values identical to the outgoing project's. React bails out of a
  // no-op `setState`, so without the generation counter this effect's
  // dependencies would never actually change and it would never re-run —
  // leaving the previous project's canister tree on screen, where clicking
  // one would query the *old* project's canister id through the *new*
  // project's agent.
  useEffect(() => {
    setForest(null);
    setTreeError(null);
    setCanister(null);
    setQueryable({});
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
  }, [env, identity, projectGeneration]);

  useEffect(() => {
    setEntities(null);
    setEntitiesError(null);
    setEntity(null);
    // Counts belong to the entity list they were taken against. Two canisters
    // can hold tables of the same name, so keeping them would show one
    // canister's count beside another's table.
    setRowCounts({});
    setCounting(false);
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
    // A query result and a table's rows now share one pane, so a result must not
    // outlive the selection it was taken under. Asking for a table and still
    // being shown a statement's output is the failure that sharing the pane
    // makes possible, and this is where it is prevented.
    //
    // Safe here specifically because this effect depends on the selection alone
    // — env, canister, entity, identity — and not on `offset`, so paging cannot
    // trip it and discard a result the reader just asked for.
    setSqlResult(null);
    if (!env || !canister || !identity) return;
    if (!entity) return;
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
  // Prefer an identity that actually controls the fleet.
  //
  // icydb's SQL endpoints are controller-gated, and which identity a project
  // declares as its default is a separate setting from which principals it
  // declares as controllers. On a canic project those routinely disagree — the
  // default is a per-machine development identity, the controllers are the
  // team's — so following the default blindly opens this app onto an error the
  // reader did not cause.
  //
  // Asked once the fleet is known, never during discovery: discovery is a
  // filesystem read that has to work with no replica running.
  useEffect(() => {
    if (!forest || !env || !identity) return;
    const rootNode = forest[0];
    if (!rootNode) return;
    let cancelled = false;

    void Promise.resolve(preferredIdentityFor(env, rootNode.pid))
      .then((preferred) => {
        if (cancelled || !preferred || preferred === identity) return;
        setIdentityNote(
          `Switched to identity “${preferred}”: the project's default “${identity}” is not a ` +
            `controller of these canisters, and icydb's SQL endpoints are controller-gated.`,
        );
        setIdentity(preferred);
      })
      .catch(() => {
        /* leave the selection alone */
      });

    return () => {
      cancelled = true;
    };
    // Deliberately not re-running on `identity`: this sets it, and depending on
    // it would re-ask on every switch the user makes by hand — overriding a
    // deliberate choice with this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forest, env]);

  // Probe each canister for an icydb surface, once the fleet is known.
  //
  // Its own effect, deliberately. Probing used to run inside the handler that
  // set the forest, which meant a probe that threw took the whole tree down
  // with it — navigation vanishing because a metadata read failed is a bad
  // trade, and the App tests caught it. Marks are decoration on top of the
  // tree; they must never gate it.
  //
  // These are certified metadata reads rather than statements, so running them
  // for the whole fleet is cheap — unlike the row counts, which are full scans
  // and stay user-initiated. A probe that fails leaves its canister unmarked,
  // which reads as "not known" rather than claiming it has nothing.
  useEffect(() => {
    if (!forest || !env || !identity) return;
    let cancelled = false;
    for (const node of flattenForest(forest)) {
      void Promise.resolve(sqlCapabilities(env, node.pid, identity))
        .then((caps) => {
          if (cancelled || !caps) return;
          setQueryable((current) => ({ ...current, [node.pid]: caps.query }));
        })
        .catch(() => {
          /* leave unmarked */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [forest, env, identity]);

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

  // A query result that happens to be rows is still a page of rows, so it saves
  // the same way. Sharing one serialiser rather than a second path means CSV
  // quoting cannot be right in one place and wrong in the other.
  const exportResultRows = useCallback(
    async (format: ExportFormat) => {
      if (sqlResult?.type !== "rows") return;
      const path = await save({ defaultPath: exportFilename(sqlResult, format) });
      if (!path) return;
      try {
        await writeExport(path, exportRows(sqlResult, format));
      } catch (error) {
        setSqlError(error as AppErrorDto);
      }
    },
    [sqlResult],
  );

  // Explains the statement the grid is running.
  //
  // Two things a reader cannot otherwise see: which SQL the rows pane issued —
  // paging SQL is derived, never typed — and what icydb does with it. The
  // result goes into the SQL bar rather than a surface of its own, so the same
  // rendering that already shows explain output is reused and the reader ends
  // up looking at the statement itself.
  const explainCurrentRows = useCallback(async () => {
    if (!env || !canister || !entity || !identity) return;
    setSqlExpanded(true);
    try {
      const result = await explainRows(env, canister, entity, offset, identity);
      setSqlResult(result);
      setSqlError(undefined);
    } catch (error) {
      setSqlResult(null);
      setSqlError(error as AppErrorDto);
    }
  }, [env, canister, entity, identity, offset, setSqlExpanded]);

  // Saves the page on screen. The rows are already here, so this serialises
  // locally and asks Rust only to write — no extra query, and nothing fetched
  // that the reader is not already looking at.
  const exportCurrentRows = useCallback(
    async (format: ExportFormat) => {
      if (!rows) return;
      const path = await save({ defaultPath: exportFilename(rows, format) });
      // Cancelling the dialog is an ordinary outcome, not a failure.
      if (!path) return;
      try {
        await writeExport(path, exportRows(rows, format));
      } catch (error) {
        setRowsError(error as AppErrorDto);
      }
    },
    [rows],
  );

  // Counts every listed entity, one statement each. Sequential rather than
  // concurrent: this is N full scans against someone's canister, and firing
  // them in parallel would turn one deliberate click into a burst. A failure
  // is recorded as null for that entity rather than aborting the run — one
  // unreadable table should not deny the reader every other count.
  const countAllRows = useCallback(
    async (listed: EntityDto[]) => {
      if (!env || !canister || !identity) return;
      // The same staleness rule `loadMore` uses, and for the same reason:
      // compare the *values* selected when this started, not the ref object,
      // which is replaced on every selection change.
      const isStale = () => {
        const current = selectionRef.current;
        return (
          current.env !== env || current.canister !== canister || current.identity !== identity
        );
      };

      setCounting(true);
      try {
        for (const listedEntity of listed) {
          let counted: number | null = null;
          try {
            counted = await countRows(env, canister, listedEntity.name, identity);
          } catch {
            counted = null;
          }
          if (isStale()) return;
          setRowCounts((current) => ({ ...current, [listedEntity.name]: counted }));
        }
      } finally {
        if (!isStale()) setCounting(false);
      }
    },
    [env, canister, identity],
  );

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

  // How many columns the selected entity has, for sizing the row skeletons
  // while its first page is still in flight. `SHOW ENTITIES` already reports
  // this per entity, so the count is known before any row arrives — including
  // on the FIRST load of a session.
  //
  // Read from the *selected* entity, deliberately not carried over from the
  // previous page. An earlier version held the last `RowsDto` in a ref and fed
  // the grid that shape with an empty `rows` array; because `rows` only goes
  // null when the selection changes, the shape in such a ref is by construction
  // some *other* table's — so the skeletons showed the wrong arity under the
  // wrong headers and then reflowed when the real data landed, which is the one
  // thing a skeleton exists to prevent. After a project switch they were the
  // previous project's column names. A count derived from the live selection
  // cannot outlive that selection.
  const skeletonColumns = entities?.find((candidate) => candidate.name === entity)?.columns;

  // `rows` is null both while a fetch is in flight and after one failed, and the
  // error is the only thing that tells the two apart — without this a rejected
  // fetch would leave skeletons spinning underneath its own banner.
  //
  // The other half of the rule — that a fetch is only in flight while a table is
  // actually selected — is the `entity === null` branch in the Rows pane below,
  // which is the ONE place that decision is made. Do not restate it here: two
  // gates for one rule means either can be removed with every test still green,
  // which is how the perpetual-skeleton bug survived review the first time.
  const rowsPending = rows === null && rowsError === null;

  const currentEnvironment = environments.find((candidate) => candidate.name === env) ?? null;

  // The five top-level banner conditions, gathered so the region wrapping
  // them below can be rendered only when at least one is actually showing —
  // an always-present empty box would be one more thing to explain away.
  // Each condition here is copy-pasted from its own block's `&&` guard
  // rather than refactored into shared booleans: keeping them textually
  // identical to the JSX below is what makes it obvious this flag can never
  // disagree with what actually renders.
  const hasTopLevelBanner =
    identityNote !== null ||
    environmentsError !== null ||
    identityError !== null ||
    persistWarning !== null ||
    (environmentsLoaded && root !== null && environments.length === 0 && !environmentsError) ||
    (environmentsLoaded && currentEnvironment !== null && identity === null);

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
    <main className="flex h-screen flex-col bg-surface-0 font-ui text-text-1">
      <header className="flex items-center gap-3 border-b border-rule bg-surface-1 px-4 py-2">
        <h1 className="text-lg font-semibold">icydb Explorer</h1>
        <ProjectSelector root={root} busy={projectBusy} onSelect={handleSelectProject} />
        {environments.length > 0 && (
          <select
            value={env ?? ""}
            onChange={(event) => handleSelectEnvironment(event.target.value)}
            className="rounded-control border border-rule px-2 py-1 text-sm"
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
        <div className="ml-auto">
          <SettingsMenu choice={themeChoice} onChoose={setThemeChoice} />
        </div>
      </header>

      {/* A bounded, independently-scrolling home for every top-level banner —
          errors and warnings alike — so a very long `AppErrorDto.explanation`
          (or a `noUsableIdentitySummary` joining many unusable identities)
          scrolls inside this box instead of growing to content height and
          squeezing the pane shell below toward zero. `<main>` is a COLUMN
          flex container and this region is a plain (non-`flex-1`) sibling of
          that shell, so without a cap its automatic height is exactly its
          content height — this box existed and was `p-2`-only before this
          fix, which is what let an 8042px explanation collapse the panes.

          `shrink-0` + a `max-h` + `overflow-auto` together are what cap it:
          `max-h` bounds the box, `overflow-auto` is what makes the excess
          scroll in place rather than clip or overflow, and `shrink-0` keeps
          the flex algorithm from squeezing it *smaller* than that capped
          size under tight vertical space — that squeeze is reserved for the
          pane shell below (`min-h-0 flex-1`), which is the flexible one.
          `overflow-auto` alone already forces this box's own automatic
          minimum height to 0 (CSS Flexbox §4.5: a non-`visible` overflow
          zeroes the content-based automatic minimum, the same effect
          `min-h-0` spells out explicitly) — `shrink-0` on top of that is
          what stops it from being shrunk past its capped size at all.

          This is a second scroll container outside the four-pane shell, not
          a violation of "one scroll container per pane, owned by that pane"
          (see the pane row's own comment below): a banner region is not a
          pane, and none of the four panes' own scroll regions changed.

          `AppErrorDto.explanation` still renders verbatim inside `ErrorBanner`
          (its own `<pre className="whitespace-pre-wrap">`) — bounding this
          container caps how much is visible at once without touching the
          string a single character. */}
      {hasTopLevelBanner && (
        <div data-banner-region className="max-h-[40vh] shrink-0 space-y-2 overflow-auto p-2">
          {identityNote && (
            <p className="rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn-text">
              {identityNote}
            </p>
          )}

          {environmentsError && <ErrorBanner error={environmentsError} />}

          {identityError && <ErrorBanner error={identityError} />}

          {persistWarning && (
            <p className="rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn-text">
              This project is open, but the choice won&apos;t be remembered next launch:{" "}
              {persistWarning}
            </p>
          )}

          {/* An explicit empty state, not a silently blank window: a
              `discover()` failure of Critical 1's own class (a project
              layout this app doesn't understand) must be visible, not
              indistinguishable from a project that simply hasn't been
              deployed yet. */}
          {environmentsLoaded && root !== null && environments.length === 0 && !environmentsError && (
            <p className="rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn-text">
              No environments were found in this project&apos;s <code>.icp/</code> layout. Deploy
              it (e.g. <code>icp network start</code>, <code>icp canister create</code>,{" "}
              <code>icp canister install</code>) and relaunch this app.
            </p>
          )}

          {/* Another explicit empty state, of the same class as the one
              above: `identity === null` means `initialIdentityFor` found
              nothing selectable for `currentEnvironment` (a store holding
              only `anonymous`, only unrecognised kinds, or nothing at all).
              Every effect below early-returns on a null identity, so without
              this the user would see empty panes with no explanation at all
              — `identityError` is only ever set by a *failed* `selectIdentity`
              call, never by there being nothing to select in the first
              place. */}
          {environmentsLoaded && currentEnvironment && identity === null && (
            <p className="rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn-text">
              {noUsableIdentitySummary(currentEnvironment)}
            </p>
          )}
        </div>
      )}

      {/* No project is open: a first launch, or a remembered root that has
          since been moved or deleted. Distinct from "this project has no
          environments" below — that one is about a project that exists.
          `flex-1` and deliberately NOT inside the bounded banner region
          above: this is the app's main empty state for a first-time user,
          not a banner, and it must keep filling the available space. */}
      {environmentsLoaded && root === null && !environmentsError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-text-2">Choose a project to explore.</p>
          <p className="text-xs text-text-3">
            Pick a directory containing an <code>.icp/</code> layout — or any directory inside
            one.
          </p>
          <ProjectSelector root={null} busy={projectBusy} onSelect={handleSelectProject} />
        </div>
      )}

      {/* Four panes left to right, then the SQL bar across the bottom.
          `min-h-0` on both of these divs (and on the open SQL bar) is
          load-bearing and invisible to jsdom: a flex item's `min-height`
          defaults to `auto`, which in a COLUMN flex container resolves to a
          content-based minimum, so without it each grows to fit its content
          instead of shrinking — every pane's scroll region then sizes itself to
          its full content, stops scrolling, and the window scrolls instead
          (measured: an 800px viewport becomes an 11312px page, and not one of
          the four scroll regions scrolls). `<main>`'s `h-screen` is what makes
          the chain definite at the top; `Pane`'s own `<section>` needs no
          `min-h-0` because it is a flex item in a ROW container, where
          `min-height: auto` computes to 0 and `align-items: stretch` already
          gives it a definite height — its `min-w-0` covers the axis that does
          bind there.

          `overflow-hidden` on the pane row is the other half, and it is about
          WIDTH, which `min-w-0` does not cover: the three side panes are
          `shrink-0`, and `PANE_BOUNDS` allows 480 + 480 + 560 = 1520px of fixed
          width, so on a narrower window dragged to those maxima the row is wider
          than its container. Without the clip that overflow escapes all the way
          to the document, which gains a horizontal scrollbar and slides the
          full-width header out of alignment with the panes (measured at 1280px:
          page scrollWidth 1520 vs clientWidth 1280). Clipped here, the rightmost
          pane is cut off instead — local, visible, and undone by dragging back. */}
      {root !== null && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Pane
              title="Canisters"
              width={layout.widths.fleet}
              onResize={(width) => setWidth("fleet", width)}
              className="border-r border-rule bg-surface-1"
            >
              {treeError && <ErrorBanner error={treeError} />}
              {/* `forest === null` covers both "the fetch is still in flight"
                  and "there is no env/identity to fetch with yet" (the effect
                  early-returns on either, leaving `forest` null forever) — the
                  latter already has its own banner above the pane row, so
                  showing "loading" here is at worst redundant with it, never
                  misleading on its own. A plain line, not `PaneEmpty`: real
                  work may still be in flight, and `PaneEmpty` must never be
                  mistaken for that (see its own doc comment). */}
              {!treeError && forest === null && (
                <p className="p-3 text-sm text-text-3">Loading canisters…</p>
              )}
              {/* A forest that resolved to nothing is a fact about the
                  environment, not a loading state — `CanisterTree` itself
                  draws no distinction and would otherwise render a silently
                  empty `<ul>` here. */}
              {!treeError && forest && forest.length === 0 && (
                <PaneEmpty title="No canisters">This environment has nothing deployed yet.</PaneEmpty>
              )}
              {!treeError && forest && forest.length > 0 && (
                <CanisterTree
                  trees={forest}
                  selectedPid={canister}
                  onSelect={setCanister}
                  queryable={queryable}
                />
              )}
            </Pane>

            <Pane
              title="Tables"
              width={layout.widths.tables}
              onResize={(width) => setWidth("tables", width)}
              className="border-r border-rule bg-surface-1"
            >
              {entitiesError && <ErrorBanner error={entitiesError} />}
              {/* Three blank conditions used to collapse into one silent gap:
                  no canister picked yet (every launch, since nothing
                  auto-selects one), the `listTables` fetch in flight, and a
                  canister with no entities — the last of which `TableList`
                  already renders its own `PaneEmpty` for below. The first two
                  need distinct states here, mirroring the Rows/Schema panes'
                  own "no <upstream> selected" empty state. */}
              {!entitiesError && canister === null && (
                <PaneEmpty title="No canister selected">
                  Select a canister to see its tables.
                </PaneEmpty>
              )}
              {!entitiesError && canister !== null && entities === null && (
                <p className="p-3 text-sm text-text-3">Loading tables…</p>
              )}
              {!entitiesError && entities && (
                <TableList
                  entities={entities}
                  selected={entity}
                  onSelect={setEntity}
                  counts={rowCounts}
                  counting={counting}
                  onCount={() => void countAllRows(entities)}
                />
              )}
            </Pane>

            {/* The banner and the grid render TOGETHER, not one or the other: a
                "Load more" that fails must not discard the hundred rows the
                reader is already looking at. `RowGrid` renders nothing at all
                when there is no page and nothing in flight, so a failed FIRST
                fetch still leaves the banner alone in the pane.

                `entity === null` is the single gate on "is anything loading at
                all" — with no table selected the rows effect early-returns and
                nothing is pending, so the pane must say so rather than render a
                grid that would have nothing to draw but placeholders.

                `@container` makes this pane the query container `max-w-cell`
                (see `tokens.css`) resolves its `cqw` half against. Placed here
                via the existing `className` prop rather than a new `container`
                prop on `Pane` itself — `Pane` is shared by all four panes, and
                only the rows pane's cells read a container-relative cap, so a
                prop on the shared component would be unused surface on the
                other three. `container-type: inline-size` needs no explicit
                size of its own: this section's width already comes from
                `flex-1` in the row above, not from its content, so containment
                changes nothing about how it's sized. */}
            {/* One pane for results, whether they came from selecting a table or
                from a statement. The SQL bar used to render its own grid in a
                fixed third of the height — a second copy of this grid, in a third
                of the room, missing nothing except the space that makes wide rows
                readable. A hundred rows had nowhere to go.

                The title says which of the two you are looking at, and a query
                result carries a way back, because a pane that silently swapped
                its source would have you reading a statement's output as though
                it were the table's contents. */}
            <Pane
              title={sqlResult ? "Query result" : "Rows"}
              className="@container"
              trailing={
                sqlResult && (
                  <button
                    type="button"
                    onClick={() => setSqlResult(null)}
                    className="rounded-control px-1 text-xs text-text-3 hover:bg-surface-2"
                  >
                    {entity ? `back to ${entity}` : "clear"}
                  </button>
                )
              }
            >
              {sqlResult ? (
                <SqlResultView result={sqlResult} onExport={exportResultRows} />
              ) : (
                <>
                  {rowsError && <ErrorBanner error={rowsError} />}
                  {entity === null ? (
                    <PaneEmpty title="No table selected">
                      Select a table to see its rows.
                    </PaneEmpty>
                  ) : (
                    <RowGrid
                      rows={rows}
                      hasMore={hasMore}
                      onLoadMore={loadMore}
                      loading={rowsPending}
                      skeletonColumns={skeletonColumns}
                      onExport={(format) => void exportCurrentRows(format)}
                      onExplain={() => void explainCurrentRows()}
                    />
                  )}
                </>
              )}
            </Pane>

            <SchemaInspector
              schema={schema}
              error={schemaError}
              entity={entity}
              collapsed={layout.schemaCollapsed}
              onToggle={toggleSchema}
              width={layout.widths.schema}
              onResize={(width) => setWidth("schema", width)}
            />
          </div>

          <SqlBar
            entities={entities}
            schema={schema}
            target={
              canister
                ? { canister: roleOf(forest, canister) ?? canister, entity }
                : null
            }
            expanded={layout.sqlExpanded}
            onExpandedChange={setSqlExpanded}
            onRun={handleRunSql}
            error={sqlError}
            limitAppended={sqlLimitAppended}
            orderByMissing={sqlOrderByMissing}
          />
        </div>
      )}
    </main>
  );
}

/** The SQL console as a bar across the bottom of the shell, rather than a
 *  permanent third of the rows pane.
 *
 *  A wrapper in this file, not a component of its own: it is composition — a
 *  disclosure around `SqlConsole` and `SqlResultView`, both of which already
 *  exist — and phase 3 replaces its contents with the CodeMirror editor. A
 *  separate file would have to be unpicked again then.
 *
 *  Opens on click and closes on the close button. No keyboard shortcut: the
 *  keyboard map is phase 3, and half a map is worse than none.
 *
 *  Two layout details that jsdom cannot see. `basis-1/3` gives the open bar a
 *  third of the shell's height, and `min-h-0` is what makes that a ceiling
 *  rather than a floor: `min-height: auto` on a column flex item resolves to a
 *  content-based minimum, so a tall result would otherwise push the bar past a
 *  third and squeeze the panes above it. And the console and its result share
 *  ONE scroll region — the same rule `Pane` follows, and for the same reason:
 *  the result's own sticky header only works if the nearest scrollport is the
 *  one that actually scrolls. */
function SqlBar({
  expanded,
  onExpandedChange,
  onRun,
  error,
  limitAppended,
  orderByMissing,
  entities,
  schema,
  target,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onRun: (sql: string) => void;
  error?: AppErrorDto;
  limitAppended: boolean;
  orderByMissing: boolean;
  /** Passed through for completion: the canister's tables, and the selected
   *  table's schema for its columns and its real primary key. */
  entities: EntityDto[] | null;
  schema: SchemaDto | null;
  target: { canister: string; entity: string | null } | null;
}) {
  if (!expanded) {
    return (
      <div className="flex shrink-0 items-center border-t border-rule bg-surface-1 px-2 py-1">
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          aria-expanded={false}
          className="rounded-control border border-rule px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-2 hover:bg-surface-2"
        >
          SQL
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 basis-1/3 flex-col border-t border-rule bg-surface-1">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">SQL</h2>
        <button
          type="button"
          onClick={() => onExpandedChange(false)}
          aria-label="Close SQL"
          aria-expanded
          className="rounded-control px-1 text-xs text-text-3 hover:bg-surface-2"
        >
          ×
        </button>
      </div>
      {/* `@container` gives this scroll region its own query container, so a
          "rows" result rendered through `RowGrid` below (specifically
          `SqlResultView`'s call site) has an ancestor for `max-w-cell`'s `cqw`
          half to resolve against — the Rows pane's `@container` (see its own
          comment) only covers *that* call site, not this one. Without it
          `cqw` here resolves against no container at all: Chromium measured
          that as a collapse to zero width, and the CSS container-query spec's
          documented fallback is the small viewport size instead — different
          failures, but both wrong, and this is the fix for either reading. */}
      <div className="min-h-0 flex-1 overflow-auto p-2 @container">
        <SqlConsole
          onRun={onRun}
          error={error}
          limitAppended={limitAppended}
          orderByMissing={orderByMissing}
          entities={entities}
          schema={schema}
          target={target ?? undefined}
        />

      </div>
    </div>
  );
}

// Renders whichever of the nine `ResultDto` variants a console statement
// produced. Only "rows" reuses `RowGrid` (a one-off query has no paging
// state of its own, so `hasMore` is always false here); the rest get a
// small dedicated rendering since reusing `TableList`/`CanisterTree` here
// would require selection callbacks that don't apply to a static result.
function SqlResultView({
  result,
  onExport,
}: {
  result: ResultDto;
  onExport?: (format: ExportFormat) => void;
}) {
  if (result.type === "rows") {
    return (
      <RowGrid
        rows={result}
        hasMore={false}
        onLoadMore={() => {}}
        onExport={onExport && ((format) => onExport(format))}
      />
    );
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
  if (result.type === "constraints") {
    return (
      <table className="text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-text-2">
            <th className="pr-4">Name</th>
            <th className="pr-4">Kind</th>
            <th className="pr-4">Origin</th>
            <th className="pr-4">Validation</th>
            <th className="pr-4">Fields</th>
            <th>Semantics</th>
          </tr>
        </thead>
        <tbody>
          {result.constraints.map((constraint) => (
            <tr key={constraint.name}>
              <td className="pr-4 font-mono text-xs">{constraint.name}</td>
              <td className="pr-4">{constraint.kind}</td>
              <td className="pr-4">{constraint.origin}</td>
              <td className="pr-4">{constraint.validationState}</td>
              <td className="pr-4 font-mono text-xs">{constraint.fields.join(", ")}</td>
              <td>{constraint.semantics}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Exhaustiveness guard: every `ResultDto` variant is handled by an `if`
  // above, so `result` is narrowed to `never` here. Adding a tenth variant
  // without a matching branch turns this into a compile error instead of a
  // silent runtime no-op.
  const exhaustiveCheck: never = result;
  return exhaustiveCheck;
}

export default App;
