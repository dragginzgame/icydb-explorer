import type { TreeNode } from "../api/types";

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
  return (
    <ul className="text-sm">
      {trees.map((tree) => (
        <CanisterTreeNode
          key={tree.pid}
          node={tree}
          selectedPid={selectedPid}
          onSelect={onSelect}
          depth={0}
          queryable={queryable}
        />
      ))}
    </ul>
  );
}

function CanisterTreeNode({
  node,
  selectedPid,
  onSelect,
  depth,
  queryable,
}: {
  node: TreeNode;
  selectedPid: string | null;
  onSelect: (pid: string) => void;
  depth: number;
  queryable?: QueryableMap;
}) {
  const isSelected = node.pid === selectedPid;
  // Only ever dims on a definite `false`. An unprobed canister looks normal,
  // because "we have not asked yet" and "it has nothing to show" are different
  // answers and only one of them is the reader's problem.
  const hasNoSchema = queryable?.[node.pid] === false;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.pid)}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        // Still selectable. A canister with no icydb schema is a legitimate
        // thing to look at — it has an id worth copying and a place in the
        // fleet — so this dims it rather than disabling it, and says why.
        title={hasNoSchema ? `${node.role} exposes no icydb SQL surface` : undefined}
        className={`block w-full rounded-row px-2 py-1 text-left ${
          isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"
        }`}
      >
        <div className={hasNoSchema && !isSelected ? "text-text-3" : undefined}>
          {node.role}
          {hasNoSchema && <span className="ml-1 text-xs font-normal">· no tables</span>}
        </div>
        <div
          className={`truncate font-mono text-xs ${isSelected ? "text-sel-text" : "text-text-3"}`}
        >
          {node.pid}
        </div>
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <CanisterTreeNode
              key={child.pid}
              node={child}
              selectedPid={selectedPid}
              onSelect={onSelect}
              depth={depth + 1}
              queryable={queryable}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
