import type { TreeNode } from "../api/types";

/** How many canisters sit under this one, at any depth. */
export function descendantCount(node: TreeNode): number {
  return node.children.reduce((total, child) => total + 1 + descendantCount(child), 0);
}

/** Narrows a fleet to what matches, keeping every match reachable.
 *
 *  A node survives when it matches, or when anything beneath it does. The second
 *  half is what makes the result usable: a `project_instance` three levels down is
 *  meaningless without the hubs above it, and pruning them would leave matches
 *  floating at the root with no indication of where they actually live.
 *
 *  A matching node's *children* are still filtered. So everything on screen is
 *  either a match or on the path to one, which is the property that makes a
 *  filtered tree readable — nothing is shown that has no reason to be there.
 *
 *  Matches on role and principal alike, case-insensitively. The principal matters:
 *  a reader who has an id from a log or an error has no role name to search for,
 *  and that is exactly when they most need to find it.
 *
 *  An empty or whitespace-only query returns the forest unchanged rather than
 *  matching everything by coincidence.
 */
export function filterForest(trees: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return trees;

  return trees.flatMap((node) => {
    const children = filterForest(node.children, needle);
    if (matches(node, needle) || children.length > 0) {
      return [{ ...node, children }];
    }

    return [];
  });
}

function matches(node: TreeNode, needle: string): boolean {
  return (
    node.role.toLowerCase().includes(needle) || node.pid.toLowerCase().includes(needle)
  );
}

/** How many canisters a forest holds, for saying what a filter left out. */
export function forestSize(trees: TreeNode[]): number {
  return trees.reduce((total, node) => total + 1 + descendantCount(node), 0);
}
