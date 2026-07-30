import type { TreeNode } from "../api/types";

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
}: {
  trees: TreeNode[];
  selectedPid: string | null;
  onSelect: (pid: string) => void;
}) {
  return (
    <ul className="text-sm">
      {trees.map((tree) => (
        <CanisterTreeNode key={tree.pid} node={tree} selectedPid={selectedPid} onSelect={onSelect} depth={0} />
      ))}
    </ul>
  );
}

function CanisterTreeNode({
  node,
  selectedPid,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selectedPid: string | null;
  onSelect: (pid: string) => void;
  depth: number;
}) {
  const isSelected = node.pid === selectedPid;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.pid)}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`block w-full rounded px-2 py-1 text-left ${
          isSelected ? "bg-blue-100" : "hover:bg-gray-100"
        }`}
      >
        <div>{node.role}</div>
        <div className="truncate font-mono text-xs text-gray-400">{node.pid}</div>
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}
