import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  runSqlMany,
  selectIdentity,
  selectProject,
} from "./api/commands";
import { toAppErrorDto } from "./api/errors";
import type {
  AppErrorDto,
  EntityDto,
  Environment,
  Project,
  RelationDto,
  ResultDto,
  RowsDto,
  SchemaDto,
  TreeNode,
  ValueDto,
} from "./api/types";
import { CanisterTree, type QueryableMap } from "./components/CanisterTree";
import { exportFilename, exportRows, type ExportFormat } from "./lib/exportRows";
import { followPlan, followStatement, primaryKeyOf } from "./lib/followRelation";
import { fleetIndex, type FleetIndex } from "./lib/fleetLinks";
import { mergeSweep, type MergedSweep } from "./lib/mergeSweep";
import { flatten, poolOf, roleOfPid } from "./lib/pools";
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
import { SweepAllRefused, SweepStatusStrip } from "./components/SweepView";
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

/** The actions that apply to the rows on screen.
 *
 *  In the pane's header rather than under the grid. Under it they sat below a page
 *  that can be a hundred rows tall, so "save what I am looking at" was somewhere
 *  the reader had to scroll to find — and they are about the pane's contents,
 *  which is what a pane header is for.
 *
 *  Rendered only when there is something to act on: an export of nothing is a file
 *  with a header row, and offering it says there is a page here when there is not.
 */
function GridActions({
  onExport,
  onExplain,
}: {
  onExport?: (format: ExportFormat) => void;
  onExplain?: () => void;
}) {
  // Text, not buttons with a box. The pane header is `py-1` around a `text-xs`
  // title, so anything with vertical padding and a border makes the row taller —
  // and this row is chrome above the rows it acts on, which should not be the
  // tallest thing in the pane.
  const shared =
    "rounded-row px-0.5 text-xs text-text-3 underline decoration-dotted underline-offset-2 hover:text-text-1";

  return (
    <span className="flex items-center gap-1.5">
      {onExport && (
        <>
          {/* The page in hand, which is what "save what I am looking at" means —
              not the whole table, which would be an unbounded read this app does
              not issue. */}
          <button type="button" onClick={() => onExport("csv")} className={shared}>
            Export CSV
          </button>
          <button type="button" onClick={() => onExport("json")} className={shared}>
            Export JSON
          </button>
        </>
      )}
      {onExplain && (
        <button type="button" onClick={onExplain} className={shared}>
          Explain query
        </button>
      )}
    </span>
  );
}

/// What a result is *of*, for a trail step's label.
///
/// Every variant this app can reach carries an entity except the three catalogue
/// listings, which are about the canister rather than any one table — so those
/// get their own word instead of a borrowed entity name that would be a lie.
function resultLabel(result: ResultDto): string {
  if (result.type === "entities") return "tables";
  if (result.type === "stores") return "stores";
  if (result.type === "memory") return "memory";

  return result.entity;
}

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
  return roleOfPid(trees ?? [], pid);
}

/// A canister named the way a reader recognises it. Falls back to the principal,
/// which is worse to read but never wrong — an unlabelled row in a merged grid
/// would be worse than a long one.
function roleLabel(trees: TreeNode[] | null, pid: string): string {
  return roleOfPid(trees ?? [], pid) ?? pid;
}

/// Every canister in the forest, roots and descendants alike.
///
/// The tree is arbitrarily deep — a canic fleet nests shards under hubs under
/// root — so probing "the canisters" means walking it, not reading the top
/// level.
/// Kept as a name local to this file because several call sites read better with
/// it, but it is `pools.flatten` — one implementation, so a fleet is walked the
/// same way whether the caller is probing capabilities or grouping a pool.
const flattenForest = flatten;

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
  const [loadingMore, setLoadingMore] = useState(false);

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
  // Where following relations has been. Each step is a view the pane was showing
  // before a follow replaced it, so going back restores it exactly rather than
  // re-running anything. `result: null` is the selected table's own rows, which
  // is what the pane shows when nothing has overlaid it.
  //
  // A stack rather than a single "back": following a relation can land two or
  // three entities away from where you started, and one undo would leave the
  // reader stranded in the middle with no way to the beginning.
  const [trail, setTrail] = useState<
    { label: string; result: ResultDto | null; schema: SchemaDto | null }[]
  >([]);
  // The schema of the entity the current *result* is about, when it is known —
  // which it is exactly when the result came from following a relation, because
  // that path describes the target anyway to learn its primary key.
  //
  // Without this a follow is a dead end: a statement's output would carry no
  // relation affordances, so the reader could go one step and no further, and a
  // trail that can never hold more than one step is not a trail. Keeping the
  // schema we already fetched costs nothing and makes following chain.
  const [resultSchema, setResultSchema] = useState<SchemaDto | null>(null);
  // Whether the next statement sweeps the selected canister's pool.
  //
  // Opt-in and never sticky across a selection change: a sweep costs one call
  // per member, so it is something the reader asks for each time they mean it
  // rather than a mode they can forget they are in.
  const [sweeping, setSweeping] = useState(false);
  const [sweep, setSweep] = useState<MergedSweep | null>(null);

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
  // Bumped by the Refresh control to re-read what is on screen.
  //
  // A separate counter from `projectGeneration` because the two mean opposite
  // things to the selection. Switching project invalidates it — the old
  // canister id means nothing in the new project — so those effects clear it.
  // A refresh does the reverse: the ids are the same and the reader wants the
  // same view, only current. So the effects below distinguish the two and keep
  // the selection (and the rendered data) across a refresh.
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Lets the fleet effect tell a refresh from a project switch. A ref rather
  // than state: reading it must not itself cause a render.
  const refreshSeenRef = useRef(0);
  const tablesRefreshRef = useRef(0);
  const rowsRefreshRef = useRef(0);

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
    setResultSchema(null);
    setTrail([]);
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
    // A refresh re-reads the same fleet, so it must not blank the tree or drop
    // the selection: the reader asked for current data, not to start over. A
    // project switch is the opposite and still clears both.
    const isRefresh = refreshSeenRef.current !== refreshGeneration;
    refreshSeenRef.current = refreshGeneration;

    if (!isRefresh) {
      setForest(null);
      setCanister(null);
      setQueryable({});
    }
    setTreeError(null);
    if (!env || !identity) return;
    let cancelled = false;
    canisterTree(env, identity)
      .then((result) => {
        if (cancelled) return;
        setForest(result);
        // A refresh can reveal that the selected canister is gone — a pool
        // canister released, say. Keeping the selection would leave the panes
        // querying an id the fleet no longer lists, so it is dropped, which
        // reads as "nothing selected" rather than as a failing query.
        setCanister((current) =>
          current && !flattenForest(result).some((node) => node.pid === current) ? null : current,
        );
      })
      .catch((error: AppErrorDto) => {
        if (cancelled) return;
        setTreeError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [env, identity, projectGeneration, refreshGeneration]);

  useEffect(() => {
    // Same rule as the fleet effect: a refresh re-reads this canister's tables
    // and must keep the selected one, where changing canister must not.
    const isRefresh = tablesRefreshRef.current !== refreshGeneration;
    tablesRefreshRef.current = refreshGeneration;

    if (!isRefresh) {
      setEntities(null);
      setEntity(null);
      // Counts belong to the entity list they were taken against. Two canisters
      // can hold tables of the same name, so keeping them would show one
      // canister's count beside another's table.
      setRowCounts({});
      setCounting(false);
    }
    setEntitiesError(null);
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
  }, [env, canister, identity, refreshGeneration]);

  useEffect(() => {
    // A refresh keeps the rows on screen while the new page is in flight, so the
    // grid does not blink to skeletons and back for data that is about to look
    // almost identical. Everything else it resets, because a refresh really does
    // discard: paging returns to the first page, and a statement's output is not
    // what the reader asked to have refreshed.
    const isRefresh = rowsRefreshRef.current !== refreshGeneration;
    rowsRefreshRef.current = refreshGeneration;

    setSchema(null);
    setSchemaError(null);
    if (!isRefresh) setRows(null);
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
    // And the trail with it. Its steps hold views taken under the outgoing
    // selection, so a surviving trail would offer a way "back" to a different
    // table's rows from inside this one — the same failure as a stale result,
    // one indirection further away.
    setTrail([]);
    setResultSchema(null);
    // A sweep is opt-in per selection, never a mode. The pool a reader chose to
    // sweep belonged to the outgoing canister, and carrying the flag forward
    // would silently widen the scope of the next statement they type.
    setSweeping(false);
    setSweep(null);
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
  }, [env, canister, entity, identity, refreshGeneration]);

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
      try {
        const path = await save({ defaultPath: exportFilename(sqlResult, format) });
        // Cancelling the dialog is an ordinary outcome, not a failure.
        if (!path) return;
        await writeExport(path, exportRows(sqlResult, format));
      } catch (error) {
        setSqlError(toAppErrorDto(error));
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

  // Follows a declared relation from the cell holding the target's keys.
  //
  // Two calls, in this order, because the statement cannot be written until the
  // target is described: the keys come from the clicked row, but the column to
  // match them against is the *target's* primary key, and this app holds a
  // schema only for the selected entity. Assuming `id` would fail as a confusing
  // SQL error on any entity naming its key otherwise.
  //
  // Same canister throughout. A declared relation is always intra-canister —
  // `targetStorePath` names a store in this schema — so there is no boundary
  // being crossed here and no identity to re-resolve.
  const followRelationFrom = useCallback(
    async (relation: RelationDto, cell: ValueDto) => {
      if (!env || !canister || !identity) return;
      const plan = followPlan(relation, cell);
      // The affordance is not drawn without a plan, so this is a guard rather
      // than a path — but a no-op beats a statement built from no keys.
      if (!plan) return;

      const from = sqlResult ? resultLabel(sqlResult) : (entity ?? "rows");
      const fromSchema = resultSchema;
      setSqlExpanded(true);
      try {
        const described = await describeTable(env, canister, plan.targetEntity, identity);
        if (described.type !== "schema") {
          throw genericError(
            `Describing ${plan.targetEntity} returned a ${described.type}, not a schema, ` +
              "so its primary key is unknown and there is nothing to match these keys against.",
          );
        }
        const primaryKey = primaryKeyOf(described);
        if (primaryKey === null) {
          // Both reasons are worth distinguishing: no key at all, versus a
          // composite one this app cannot match with a single value per key.
          const keys = described.columns.filter((column) => column.primaryKey).length;
          throw genericError(
            keys === 0
              ? `${plan.targetEntity} declares no primary key, so there is no column to match ` +
                  `${relation.field} against.`
              : `${plan.targetEntity} has a primary key of ${keys} columns. A relation carries ` +
                  "one value per key, so this explorer cannot follow it without matching part " +
                  "of the key and over-reporting.",
          );
        }

        const run = await runSql(env, canister, followStatement(plan, primaryKey), identity);
        setTrail((steps) => [...steps, { label: from, result: sqlResult, schema: fromSchema }]);
        setSqlResult(run.result);
        // The target's own schema, so the result it produced can be followed on
        // in turn. Set only alongside the result it describes — a schema that
        // outlived its result would offer to follow a column of another entity.
        setResultSchema(described);
        setSqlError(undefined);
        setSqlLimitAppended(run.limitAppended);
        setSqlOrderByMissing(run.orderByMissing);
      } catch (error) {
        // The trail is deliberately untouched on failure: a follow that did not
        // happen must not add a step, or "back" would return to where the reader
        // already is.
        setSqlError(error as AppErrorDto);
      }
    },
    [env, canister, identity, entity, sqlResult, resultSchema, setSqlExpanded],
  );

  // Returns to a step, discarding everything after it. Restores the view rather
  // than re-running it: the rows are already in hand, and re-querying would show
  // a reader different data than the one they are stepping back to.
  const backTo = useCallback((index: number) => {
    setTrail((steps) => {
      setSqlResult(steps[index].result);
      // Restored together: the schema describes that step's result, and pairing
      // them is what keeps a restored view followable without re-describing.
      setResultSchema(steps[index].schema);
      return steps.slice(0, index);
    });
    setSqlError(undefined);
  }, []);

  // Counts a canister's tables as soon as they are listed, once per canister.
  //
  // This reverses a deliberate earlier choice, and the cost is worth stating: each
  // count is a full scan, so selecting a canister now issues one statement per
  // table without being asked. Against a local replica that is free; against a
  // production canister it is not, and the counts are the only thing in this app
  // that behaves that way.
  //
  // Keyed on the canister so it happens once rather than on every render, and
  // deliberately *not* on `rowCounts` — which it writes, and would otherwise
  // retrigger itself.
  // The effect's own dependencies are the mechanism: it runs when the canister
  // changes, when the entity list is re-fetched, and when a refresh bumps the
  // generation — and not otherwise, because a re-render changes none of those.
  //
  // An earlier version added a ref keyed on canister-plus-generation to stop it
  // running twice. Removing that ref changed no test, which is how it was found to
  // be describing a guarantee the deps already gave. It also quietly *suppressed*
  // one case that should recount: switching identity re-lists the tables, and the
  // counts should follow.
  //
  // `refreshGeneration` is load-bearing rather than decorative: a re-fetch can
  // return an identical entity list, so the generation is what makes "again" mean
  // again.
  useEffect(() => {
    if (!canister || !entities || entities.length === 0) return;
    void countAllRows(entities);
    // `countAllRows` is excluded on purpose: it closes over the selection and is
    // rebuilt whenever any part of it changes, which would re-run this effect
    // mid-count and start a second pass over the same tables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canister, entities, refreshGeneration]);

  // Saves the page on screen. The rows are already here, so this serialises
  // locally and asks Rust only to write — no extra query, and nothing fetched
  // that the reader is not already looking at.
  const exportCurrentRows = useCallback(
    async (format: ExportFormat) => {
      if (!rows) return;
      // The dialog call is inside the try. Outside it, a rejection from the
      // dialog plugin — a missing `dialog:allow-save` capability, which is exactly
      // what was wrong — became an unhandled promise rejection: the click did
      // nothing, said nothing, and looked like an unwired button.
      try {
        const path = await save({ defaultPath: exportFilename(rows, format) });
        // Cancelling the dialog is an ordinary outcome, not a failure.
        if (!path) return;
        await writeExport(path, exportRows(rows, format));
      } catch (error) {
        // Normalised rather than cast: a plugin rejection is not an `AppErrorDto`,
        // and casting one produced a banner with an undefined explanation — a
        // failure reported into a blank box.
        setRowsError(toAppErrorDto(error));
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

  // Re-reads what is on screen: the fleet, this canister's tables, and the
  // selected table's rows and schema. The selection survives, because a reader
  // asking for current data is not asking to start over.
  //
  // Why this is needed at all: everything here is fetched once, when a selection
  // changes. Nothing polls, and a canister cannot notify us — so a row written
  // by something else (creating a project in the app, say) is invisible until
  // something re-asks. This is that something.
  //
  // Counts are re-read too, by letting the automatic pass run again. This used to
  // filter to "tables that already have a count", which was the right rule while
  // counting was manual — but with counting automatic that set is everything, and
  // the filter left a gap: a refresh fired *before* the first pass finished would
  // recount only the tables counted so far and never revisit the rest, because the
  // pass does not re-fire for a canister it has already seen.
  const refresh = useCallback(() => {
    setRefreshing(true);
    // The bump is what makes the automatic count pass run again: it is part of
    // that effect's key.
    setRefreshGeneration((generation) => generation + 1);
    // The fetches are effect-driven and each guards its own staleness, so there
    // is nothing here to await. The spinner is a deliberate fixed beat: it says
    // "this was received" rather than tracking a completion this callback cannot
    // observe. Claiming to know when every fetch has landed would be a lie.
    window.setTimeout(() => setRefreshing(false), 400);
  }, []);

  const loadMore = useCallback(() => {
    if (!env || !canister || !entity || !identity) return;
    // A page against a large table can take seconds, and the button previously
    // just sat there — which reads as a click that did not register.
    setLoadingMore(true);
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
        setLoadingMore(false);
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
        // Cleared on the failing path too, or a rejected page leaves the button
        // saying "Loading…" for the rest of the session.
        setLoadingMore(false);
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
      setSweep(null);

      // A sweep only where there is a pool to sweep. `sweeping` cannot outlive
      // the selection that offered it (the effect below clears it), but reading
      // the pool again here means the request is built from what is true now
      // rather than from a flag.
      const target = sweeping ? poolOf(forest ?? [], requestCanister) : null;
      if (target) {
        runSqlMany(requestEnv, target.members, sql, requestIdentity)
          .then((run) => {
            if (isStale()) return;
            setSweep(mergeSweep(run.outcomes, (pid) => roleLabel(forest, pid)));
            setSqlLimitAppended(run.limitAppended);
            setSqlOrderByMissing(run.orderByMissing);
          })
          .catch((error: AppErrorDto) => {
            if (isStale()) return;
            setSqlError(error);
          });
        return;
      }

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
    [env, canister, identity, sweeping, forest],
  );

  // Principal → role for the whole fleet, so a cell holding a canister's id can
  // name it. Memoised on the forest because it is read once per rendered cell —
  // a hundred rows of ten columns would otherwise walk the tree a thousand times
  // for an answer that changes only when the fleet does.
  const fleet = useMemo(() => fleetIndex(forest ?? []), [forest]);

  // Going to a canister a cell points at. Selecting it is the whole action: the
  // effects keyed on `canister` fetch its tables, and the reader lands where they
  // would have if they had found it in the tree themselves.
  const goToCanister = useCallback((pid: string) => {
    setCanister(pid);
    setEntity(null);
  }, []);

  // Where following has been, for the rows pane's header.
  //
  // A trail rather than one "back": following relations can land two or three
  // entities from where you started, and a single undo would strand the reader in
  // the middle. Each step restores the view it captured rather than re-running it
  // — the rows are already in hand, and re-querying could show different data
  // than the one being stepped back to.
  //
  // With no trail, a bare result still gets a way out, because a pane that
  // silently swapped its source would have you reading a statement's output as
  // though it were the table's contents.
  //
  // Lifted out of the JSX because the header now carries this *and* the actions,
  // and two multi-line expressions in one attribute is where a header stops being
  // readable.
  const rowsPaneTrail =
    trail.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  {trail.map((step, index) => (
                    <span key={`${step.label}-${index}`} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => backTo(index)}
                        className="rounded-control px-1 font-mono text-accent hover:bg-surface-2"
                      >
                        {step.label}
                      </button>
                      <span className="text-text-3">›</span>
                    </span>
                  ))}
                  <span className="font-mono text-text-2">
                    {sqlResult ? resultLabel(sqlResult) : (entity ?? "rows")}
                  </span>
                </span>
              ) : (
                sqlResult && (
                  <button
                    type="button"
                    onClick={() => setSqlResult(null)}
                    className="rounded-control px-1 text-xs text-text-3 hover:bg-surface-2"
                  >
                    {entity ? `back to ${entity}` : "clear"}
                  </button>
                )
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

  // How many of this canister's tables have a count. Counting is sequential — N
  // full scans, one at a time — so on a canister with a dozen big tables the pass
  // takes long enough that "Counting…" alone reads as stuck. A fraction says work
  // is happening and roughly how much is left.
  const countProgress = (entities ?? []).filter((listed) => listed.name in rowCounts).length;

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
        <div className="ml-auto flex items-center gap-2">
          {/* Nothing here polls and a canister cannot notify us, so everything on
              screen is as of the moment it was selected. A row written by
              something else — creating a project in the app — is invisible until
              something re-asks. Disabled until there is a fleet to re-read, so
              the control is never offered with nothing behind it. */}
          <button
            type="button"
            onClick={refresh}
            disabled={!env || !identity || refreshing}
            title={
              "Re-reads the fleet, this canister's tables, and the selected table's rows. " +
              "Keeps your selection. Row counts are re-run only where one is already shown, " +
              "since a count is a full scan."
            }
            className="flex items-center gap-1.5 rounded-control border border-rule px-2 py-1 text-sm text-text-2 hover:bg-surface-2 disabled:opacity-50"
          >
            <span aria-hidden="true" className={refreshing ? "inline-block animate-spin" : ""}>
              ↻
            </span>
            Refresh
          </button>
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
        <>
        <SqlBar
            entities={entities}
            schema={schema}
            target={
              canister
                ? { canister: roleOf(forest, canister) ?? canister, entity }
                : null
            }
            pool={canister ? poolOf(forest ?? [], canister) : null}
            sweeping={sweeping}
            onToggleScope={() => setSweeping((current) => !current)}
            expanded={layout.sqlExpanded}
            onExpandedChange={setSqlExpanded}
            onRun={handleRunSql}
            error={sqlError}
            limitAppended={sqlLimitAppended}
            orderByMissing={sqlOrderByMissing}
          />
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
              trailing={
                /* "Recount", not "Count": the counts arrive on their own now, so
                   the manual action is refreshing a number that is already there.
                   In the header with the same text-only treatment as the row
                   actions, rather than a bordered button taking a row from the
                   list it sits above. */
                entities && entities.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void countAllRows(entities)}
                    disabled={counting}
                    title="Runs COUNT(*) on every table in this canister. Each one is a full scan."
                    className="rounded-row px-0.5 text-xs text-text-3 underline decoration-dotted underline-offset-2 hover:text-text-1 disabled:no-underline disabled:opacity-60"
                  >
                    {counting ? `Counting ${countProgress} of ${entities.length}…` : "Recount rows"}
                  </button>
                ) : null
              }
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
              title={sweep ? "Merged result" : sqlResult ? "Query result" : "Rows"}
              className="@container"
              trailing={
                /* The pane's header carries two things: where following has been,
                   and what can be done with the rows in front of the reader. Both
                   are about the pane's contents, which is what a header is for.

                   The actions are gated on there being rows to act on — an export
                   of nothing is a file with a header row, and offering it claims a
                   page exists when it does not. */
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {rowsPaneTrail}
                  <GridActions
                    onExport={
                      sweep
                        ? undefined
                        : sqlResult
                          ? sqlResult.type === "rows"
                            ? (format: ExportFormat) => void exportResultRows(format)
                            : undefined
                          : rows && rows.rows.length > 0
                            ? (format: ExportFormat) => void exportCurrentRows(format)
                            : undefined
                    }
                    /* Explaining is about the statement this app built for the
                       selected table, so it belongs to that view alone — not to a
                       statement the reader wrote, which they can EXPLAIN
                       themselves, and not to a sweep, which is one statement
                       against several canisters and has no single plan. */
                    onExplain={
                      !sweep && !sqlResult && entity ? () => void explainCurrentRows() : undefined
                    }
                  />
                </span>
              }
            >
              {sweep ? (
                /* A sweep is neither a single result nor a table's rows, so it
                   gets its own branch rather than being squeezed into either.
                   The status strip is above the grid because a refusal has no row
                   to attach itself to — and without it, a canister that could not
                   be read would simply be absent, making a sweep short of a
                   member read as a complete answer. */
                <div className="flex min-h-0 flex-col">
                  <SweepStatusStrip statuses={sweep.statuses} />
                  {sweep.rows ? (
                    <RowGrid
                      rows={sweep.rows}
                      hasMore={false}
                      onLoadMore={() => {}}
                      fleet={fleet}
                      onGoToCanister={goToCanister}
                    />
                  ) : (
                    <SweepAllRefused statuses={sweep.statuses} />
                  )}
                </div>
              ) : sqlResult ? (
                <SqlResultView
                result={sqlResult}
                /* Only when this schema is actually about the result on screen.
                   A statement the reader typed has no known schema, and matching
                   another entity's relations by column name would offer to follow
                   a column that merely shares a name with a relation field. */
                schema={
                  sqlResult.type === "rows" && resultSchema?.entity === sqlResult.entity
                    ? resultSchema
                    : null
                }
                onFollow={(relation: RelationDto, cell: ValueDto) =>
                  void followRelationFrom(relation, cell)
                }
                fleet={fleet}
                onGoToCanister={goToCanister}
              />
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
                      loadingMore={loadingMore}
                      skeletonColumns={skeletonColumns}
                      /* Only the selected table's own grid gets relation
                         affordances. A statement's output need not have this
                         entity's columns at all, so matching relations by column
                         name there could offer to follow a column that merely
                         shares a name with a relation field. */
                      relations={schema?.relations}
                      onFollow={(relation: RelationDto, cell: ValueDto) =>
                        void followRelationFrom(relation, cell)
                      }
                      fleet={fleet}
                      onGoToCanister={goToCanister}
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

        </div>
        </>
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
 *  Sits at the top, below the banners and above the panes, and is only as tall
 *  as the editor. It used to sit at the bottom with a third of the shell's
 *  height, which was sized for a result grid — that grid now lives in the rows
 *  pane, so the bar was reserving a third of the window for four lines of text,
 *  taken from the rows it exists to query.
 *
 *  The editor bounds its own height and scrolls internally, so a long statement
 *  cannot push the panes down. That is the one layout property jsdom cannot see
 *  here, and it belongs to `SqlEditor` rather than to this chrome.
 */
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
  pool,
  sweeping,
  onToggleScope,
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
  /** The selected canister's pool, for the scope control. */
  pool: { role: string; members: string[] } | null;
  sweeping: boolean;
  onToggleScope: () => void;
}) {
  if (!expanded) {
    return (
      <div className="flex shrink-0 items-center border-b border-rule bg-surface-1 px-2 py-1">
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
    // `shrink-0` and content-height, not a share of the shell. It used to take a
    // third, which was sized for a result grid that now lives in the rows pane —
    // all this holds is an editor and its hints, and a bar that reserves a third
    // of the window for four lines of text is taking space from the rows it
    // exists to query.
    //
    // The editor bounds itself (see `SqlEditor`'s `max-height`) and scrolls
    // internally, so a long statement cannot push the panes down.
    <div className="shrink-0 border-b border-rule bg-surface-1">
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
      <div className="p-2">
        <SqlConsole
          onRun={onRun}
          error={error}
          limitAppended={limitAppended}
          orderByMissing={orderByMissing}
          entities={entities}
          schema={schema}
          target={target ?? undefined}
          pool={pool}
          sweeping={sweeping}
          onToggleScope={onToggleScope}
        />
      </div>
    </div>
  );
}

function SqlResultView({
  result,
  schema,
  onFollow,
  fleet,
  onGoToCanister,
}: {
  result: ResultDto;
  /** The schema of the entity this result is about, when it is known — which is
   *  the case when the result came from following a relation. Null for a
   *  statement the reader typed, whose columns need not belong to any one
   *  entity. */
  schema?: SchemaDto | null;
  onFollow?: (relation: RelationDto, cell: ValueDto) => void;
  /** Principal → role, so a result's cells can name the canisters they point at
   *  even when the result did not come from a relation. */
  fleet?: FleetIndex;
  onGoToCanister?: (pid: string) => void;
}) {
  if (result.type === "rows") {
    return (
      <RowGrid
        rows={result}
        hasMore={false}
        onLoadMore={() => {}}
        relations={schema?.relations}
        onFollow={schema ? onFollow : undefined}
        fleet={fleet}
        onGoToCanister={onGoToCanister}
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
