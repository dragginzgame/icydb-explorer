import type { TreeNode } from "../api/types";

/** A group of canisters that share a role, and therefore a schema. */
export type Pool = {
  /** The role every member has, as canic reports it — `user_shard`, say. */
  role: string;
  /** Every member's principal, in fleet order. Always two or more. */
  members: string[];
};

/** Every canister in a forest, depth-first, parents before children. */
export function flatten(forest: TreeNode[]): TreeNode[] {
  return forest.flatMap((node) => [node, ...flatten(node.children)]);
}

/** The pools in a fleet.
 *
 *  A pool is more than one canister with the same role. canic gives every
 *  canister it provisions from a pool the role that pool declares — three shards
 *  of `user_shard` are three canisters all reporting `user_shard` — so the role
 *  string *is* the grouping, with no naming convention to guess at.
 *
 *  Two is the floor deliberately. A role held by one canister is not a pool, and
 *  offering to "sweep" it would dress a single query up as a fan-out: same
 *  statement, same one canister, a scope control that changes nothing.
 */
export function pools(forest: TreeNode[]): Pool[] {
  const byRole = new Map<string, string[]>();
  for (const node of flatten(forest)) {
    byRole.set(node.role, [...(byRole.get(node.role) ?? []), node.pid]);
  }

  return [...byRole.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([role, members]) => ({ role, members }));
}

/** The pool a canister belongs to, or null if it is alone in its role.
 *
 *  Null is the common case — most roles in a fleet are singletons — and it is
 *  what tells the UI there is no scope to widen.
 */
export function poolOf(forest: TreeNode[], pid: string): Pool | null {
  return pools(forest).find((pool) => pool.members.includes(pid)) ?? null;
}

/** A canister's role, for naming it in the UI. */
export function roleOfPid(forest: TreeNode[], pid: string): string | null {
  return flatten(forest).find((node) => node.pid === pid)?.role ?? null;
}
