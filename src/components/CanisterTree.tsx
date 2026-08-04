import { useMemo, useRef, useState } from "react";

import type { TreeNode } from "../api/types";
import { CopyButton } from "./CopyButton";
import {
  ancestorsOf,
  descendantCount,
  filterForest,
  forestSize,
  pidsInOrder,
} from "../lib/filterFleet";

/// Whether a canister exposes an icydb SQL surface, once known.
///
/// Absent means "not probed yet"; `false` means probed and it has none. A canic
/// fleet routinely contains canisters that carry no icydb schema at all — in
/// toko, `wasm_store` and `discovery_hub` — and selecting one produces an error
/// after the click. Marking them turns a dead end into a visible fact.
export type QueryableMap = Record<string, boolean>;

// The fleet forest is how canisters are discovered at all: `.icp/cache/
// mappings/<network>.ids.json` is a name→id map with no guaranteed single
// root (a canic fleet like toko has only `root`; a plain project may list
// its canisters directly, with no root at all), so `trees` renders one root
// per mapping entry rather than assuming there's exactly one. This is the
// primary navigation, not decoration.
export function CanisterTree({
  trees,
  selectedPid,
  onSelect,
  queryable,
}: {
  trees: TreeNode[];
  selectedPid: string | null;
  onSelect: (pid: string) => void;
  queryable?: QueryableMap;
}) {
  const [query, setQuery] = useState("");
  // Every canister that has anything to collapse.
  const collapsible = useMemo(() => withChildren(trees), [trees]);
  // Collapsed by default: a fleet with a hundred project canisters is a scroll
  // before it is navigation, and the counts on a collapsed node say what is
  // inside without opening it. Keyed by principal, which is what identifies a
  // canister across a refresh — the tree is re-fetched by Refresh, and collapse
  // has to survive that or the control would undo itself.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(collapsible));
  // Only *newly seen* canisters get collapsed. Re-collapsing everything on every
  // refresh would fight the reader — they expanded a branch, refreshed to see new
  // rows, and found it shut again. A canister that genuinely just appeared does
  // start collapsed, which is right: nothing should expand itself under them.
  const seen = useRef<Set<string>>(new Set(collapsible));
  const unseen = collapsible.filter((pid) => !seen.current.has(pid));
  if (unseen.length > 0) {
    // Adjusted during render rather than in an effect, so the tree never paints
    // expanded-then-collapsed. React's documented pattern for derived state.
    for (const pid of unseen) seen.current.add(pid);
    setCollapsed((current) => new Set([...current, ...unseen]));
  }

  // Opened as far as the first canister that can actually be queried.
  //
  // Collapsed-by-default is right for a large fleet but lands the reader on a
  // single row with nothing to do. The first queryable canister is where they
  // were going anyway: a canic fleet's upper levels are hubs and stores with no
  // icydb schema, so "the top of the tree" and "somewhere worth looking" are
  // different places.
  //
  // Depends on the capability probe, which resolves after the tree, so this runs
  // when that lands rather than on mount.
  const firstQueryable = useMemo(
    () => (queryable ? (pidsInOrder(trees).find((pid) => queryable[pid] === true) ?? null) : null),
    [trees, queryable],
  );
  // Once per target, not once per render, and not again if the reader folds it
  // back up. A refresh re-probes and arrives at the same answer, which must not
  // re-open what they closed; a different project arrives at a different one and
  // gets its own reveal.
  const revealedFor = useRef<string | null>(null);
  if (firstQueryable !== null && revealedFor.current !== firstQueryable) {
    revealedFor.current = firstQueryable;
    const path = ancestorsOf(trees, firstQueryable) ?? [];
    if (path.length > 0) {
      setCollapsed((current) => {
        const next = new Set(current);
        for (const pid of path) next.delete(pid);

        return next;
      });
    }
  }

  const searching = query.trim() !== "";
  const shown = filterForest(trees, query);
  const total = forestSize(trees);
  const found = forestSize(shown);

  const toggle = (pid: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(pid)) next.add(pid);

      return next;
    });

  return (
    <div>
      {/* Sticky, not scrolled away with the list. A fleet long enough to need
          filtering is long enough that the filter must stay reachable from the
          bottom of it. */}
      <div className="sticky top-0 z-10 border-b border-rule bg-surface-1 px-2 py-1.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter canisters"
          aria-label="Filter canisters"
          className="w-full rounded-control border border-rule bg-surface-0 px-2 py-1 text-xs text-text-1 placeholder:text-text-3"
        />
        {searching && (
          // Says what was left out, not just what was found: "3 canisters" alone
          // reads as the whole fleet to anyone who has forgotten the filter is on.
          <div className="mt-1 text-xs text-text-3">
            {found === 0 ? "Nothing matches" : `${found} of ${total} canisters`}
          </div>
        )}
      </div>

      <ul className="text-sm">
        {shown.map((tree) => (
          <CanisterTreeNode
            key={tree.pid}
            node={tree}
            selectedPid={selectedPid}
            onSelect={onSelect}
            depth={0}
            queryable={queryable}
            collapsed={collapsed}
            onToggle={toggle}
            // While filtering, collapse is ignored. Finding a match and then not
            // being shown it because an ancestor happened to be collapsed would
            // make the filter feel broken, and the reader cannot see the cause.
            ignoreCollapse={searching}
          />
        ))}
      </ul>
    </div>
  );
}

/** Every canister in a forest that has children, at any depth. */
function withChildren(trees: TreeNode[]): string[] {
  return trees.flatMap((node) => [
    ...(node.children.length > 0 ? [node.pid] : []),
    ...withChildren(node.children),
  ]);
}

function CanisterTreeNode({
  node,
  selectedPid,
  onSelect,
  depth,
  queryable,
  collapsed,
  onToggle,
  ignoreCollapse,
}: {
  node: TreeNode;
  selectedPid: string | null;
  onSelect: (pid: string) => void;
  depth: number;
  queryable?: QueryableMap;
  collapsed: Set<string>;
  onToggle: (pid: string) => void;
  ignoreCollapse: boolean;
}) {
  const isSelected = node.pid === selectedPid;
  // Only ever dims on a definite `false`. An unprobed canister looks normal,
  // because "we have not asked yet" and "it has nothing to show" are different
  // answers and only one of them is the reader's problem.
  const hasNoSchema = queryable?.[node.pid] === false;
  const hasChildren = node.children.length > 0;
  const isCollapsed = hasChildren && !ignoreCollapse && collapsed.has(node.pid);
  const hidden = descendantCount(node);

  return (
    <li>
      <div className="flex items-stretch" style={{ paddingLeft: `${depth * 12}px` }}>
        {/* A separate control from selecting. Collapsing a hub to get past it is
            not the same intent as looking at it, and one button doing both means
            every attempt to tidy the tree also re-queries a canister. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.pid)}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.role}`}
            aria-expanded={!isCollapsed}
            disabled={ignoreCollapse}
            className="w-5 shrink-0 rounded-row font-mono text-xs text-text-3 hover:bg-surface-2 disabled:opacity-40"
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          // Holds the column so leaf rows line up with their siblings' labels
          // rather than shifting left by the width of a control they lack.
          <span className="w-5 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onSelect(node.pid)}
          // Still selectable. A canister with no icydb schema is a legitimate
          // thing to look at — it has an id worth copying and a place in the
          // fleet — so this dims it rather than disabling it, and says why.
          title={hasNoSchema ? `${node.role} exposes no icydb SQL surface` : undefined}
          className={`min-w-0 flex-1 rounded-row px-2 py-1 text-left ${
            isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"
          }`}
        >
          <div className={hasNoSchema && !isSelected ? "text-text-3" : undefined}>
            {node.role}
            {hasNoSchema && <span className="ml-1 text-xs font-normal">· no tables</span>}
            {/* Only while collapsed. Expanded, the children are right there and
                the count is noise; collapsed, it is the only thing saying how
                much was folded away. */}
            {isCollapsed && (
              <span className="ml-1 text-xs font-normal text-text-3">
                · {hidden} {hidden === 1 ? "canister" : "canisters"}
              </span>
            )}
          </div>
          <div
            className={`truncate font-mono text-xs ${isSelected ? "text-sel-text" : "text-text-3"}`}
          >
            {node.pid}
          </div>
        </button>

        {/* A sibling of the select button, not inside it: a button within a button
            is invalid, and clicking to copy an id must not also re-query the
            canister it belongs to. */}
        <CopyButton value={node.pid} label={`Copy ${node.role} principal`} className="w-6" />
      </div>

      {hasChildren && !isCollapsed && (
        <ul>
          {node.children.map((child) => (
            <CanisterTreeNode
              key={child.pid}
              node={child}
              selectedPid={selectedPid}
              onSelect={onSelect}
              depth={depth + 1}
              queryable={queryable}
              collapsed={collapsed}
              onToggle={onToggle}
              ignoreCollapse={ignoreCollapse}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
