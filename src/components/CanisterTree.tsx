import type { TreeNode } from "../api/types";

// The fleet tree is how canisters are discovered at all: in a canic project
// only the root canister's id is on disk, every hub/shard/instance exists
// only in root's live topology. So this is the primary navigation, not
// decoration.
export function CanisterTree({
  tree,
  selectedPid,
  onSelect,
}: {
  tree: TreeNode;
  selectedPid: string | null;
  onSelect: (pid: string) => void;
}) {
  return (
    <ul className="text-sm">
      <CanisterTreeNode node={tree} selectedPid={selectedPid} onSelect={onSelect} depth={0} />
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
