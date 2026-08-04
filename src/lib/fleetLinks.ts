import type { TreeNode, ValueDto } from "../api/types";

/** Principal → role, for every canister in the fleet. */
export type FleetIndex = Map<string, string>;

export function fleetIndex(forest: TreeNode[]): FleetIndex {
  const index: FleetIndex = new Map();
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      index.set(node.pid, node.role);
      walk(node.children);
    }
  };
  walk(forest);

  return index;
}

/** A canister a cell's value points at. */
export type FleetLink = { pid: string; role: string };

/** Principal-shaped tokens: lowercase base32 groups joined by dashes.
 *
 *  Deliberately loose, and deliberately applied to a cell's rendered text rather
 *  than to a typed value. Both are safe here for the same reason, which is worth
 *  stating because the opposite call was made for relation keys a few commits ago:
 *  a token from this is only ever used as a *lookup* into the fleet, never to
 *  build a statement. A token this over-matches simply fails to equal any
 *  canister id and disappears; there is no wrong row to fetch. Recovering
 *  relation keys by parsing text was rejected precisely because the failure there
 *  is a query for something else.
 *
 *  Applied to the text because principals arrive nested in shapes this app does
 *  not decode: `UserProjects.projects` is a `map<principal, record{pid:principal,
 *  …}>`, and its canister ids live inside the rendered map. A per-kind rule would
 *  have to reach into every container icydb can produce; one text scan reaches all
 *  of them and cannot invent a match.
 */
const PRINCIPAL_LIKE = /[a-z0-9]+(?:-[a-z0-9]+)+/g;

/** The fleet canisters a cell's value names.
 *
 *  Exact, not inferred: a principal either is a canister in this fleet or it is
 *  not. On toko's real data the split is clean — a `project_pid` resolves to
 *  `project_instance`, while a user's `pid` resolves to nothing and is left
 *  alone, which is the correct answer rather than a missed one. Most principals
 *  in a fleet's data are users, so saying nothing about them is the common case
 *  and has to read as normal.
 *
 *  Deduplicated, in order of first appearance: one cell can name the same
 *  canister twice (a map keyed by principal whose value repeats it), and two
 *  chips for one canister would say there are two.
 */
export function fleetLinks(cell: ValueDto, index: FleetIndex): FleetLink[] {
  const links: FleetLink[] = [];
  const seen = new Set<string>();

  for (const token of cell.display.match(PRINCIPAL_LIKE) ?? []) {
    if (seen.has(token)) continue;
    const role = index.get(token);
    if (role === undefined) continue;
    seen.add(token);
    links.push({ pid: token, role });
  }

  return links;
}

/** Whether a cell names any fleet canister — the cheap check for whether it is
 *  worth rendering an affordance at all. */
export function hasFleetLink(cell: ValueDto, index: FleetIndex): boolean {
  return fleetLinks(cell, index).length > 0;
}
