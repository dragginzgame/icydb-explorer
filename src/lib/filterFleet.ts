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

/** The ancestors of `pid`, outermost first, or `null` if it is not in the fleet.
 *
 *  `null` rather than an empty array for "absent", because an empty array is the
 *  correct answer for a root — it has no ancestors — and a caller that needs to
 *  open a path has to tell "already at the top" from "not here at all".
 */
export function ancestorsOf(trees: TreeNode[], pid: string): string[] | null {
  for (const node of trees) {
    if (node.pid === pid) return [];
    const below = ancestorsOf(node.children, pid);
    if (below !== null) return [node.pid, ...below];
  }

  return null;
}

/** Every canister's principal, depth-first — fleet order. */
export function pidsInOrder(trees: TreeNode[]): string[] {
  return trees.flatMap((node) => [node.pid, ...pidsInOrder(node.children)]);
}
