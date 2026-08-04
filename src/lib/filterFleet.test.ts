import { expect, test } from "vitest";

import type { TreeNode } from "../api/types";
import { descendantCount, filterForest, forestSize } from "./filterFleet";

/** Shaped like toko's real fleet, from the running replica. */
const fleet: TreeNode[] = [
  {
    pid: "igqk7-g3777-77774-qaaba-cai",
    role: "root",
    children: [
      { pid: "ibrml-1d777-77774-qaabq-cai", role: "wasm_store", children: [] },
      {
        pid: "iuw5g-k1777-77774-qaaca-cai",
        role: "discovery_hub",
        children: [{ pid: "itx3s-ht777-77774-qaacq-cai", role: "discovery_shard", children: [] }],
      },
      {
        pid: "i2uqo-r3777-77774-qaada-cai",
        role: "project_hub",
        children: [
          {
            pid: "j6z74-i3777-77774-qaafa-cai",
            role: "project_instance",
            children: [
              { pid: "jzyzi-fd777-77774-qaafq-cai", role: "project_ledger", children: [] },
            ],
          },
        ],
      },
      {
        pid: "jq3su-tl777-77774-qaaea-cai",
        role: "user_hub",
        children: [{ pid: "jx2ua-6t777-77774-qaaeq-cai", role: "user_shard", children: [] }],
      },
    ],
  },
];

/// `toBe`, not `toEqual`: an empty needle would match every node anyway, since
/// `includes("")` is true of any string — so a deep-equality assertion here holds
/// with the early return deleted and pins nothing. What the early return actually
/// buys is the *same* forest back, rather than a full rebuild of every node on
/// every render where nobody is filtering.
test("an empty query returns the very same fleet, not a rebuilt copy", () => {
  expect(filterForest(fleet, "")).toBe(fleet);
  expect(filterForest(fleet, "   ")).toBe(fleet);
});

/// The property that makes a filtered tree readable: everything on screen is
/// either a match or on the path to one.
test("a match keeps its ancestors so it stays in context", () => {
  const filtered = filterForest(fleet, "user_shard");

  expect(filtered).toHaveLength(1);
  expect(filtered[0].role).toBe("root");
  // Only the branch leading to the match survives.
  expect(filtered[0].children.map((child) => child.role)).toEqual(["user_hub"]);
  expect(filtered[0].children[0].children.map((child) => child.role)).toEqual(["user_shard"]);
});

/// A three-levels-down match floating at the root would say nothing about where it
/// actually lives.
test("a deep match keeps the whole path above it", () => {
  const filtered = filterForest(fleet, "project_ledger");

  const roles: string[] = [];
  let level = filtered;
  while (level.length > 0) {
    roles.push(level[0].role);
    level = level[0].children;
  }

  expect(roles).toEqual(["root", "project_hub", "project_instance", "project_ledger"]);
});

/// A matching node's children are still filtered, so nothing is shown that has no
/// reason to be there.
test("a matching node does not drag its non-matching children along", () => {
  const filtered = filterForest(fleet, "project_hub");

  expect(filtered[0].children).toHaveLength(1);
  expect(filtered[0].children[0].role).toBe("project_hub");
  // `project_instance` does not match and is not on the path to a match.
  expect(filtered[0].children[0].children).toEqual([]);
});

/// A reader with an id from a log or an error has no role name to search for, and
/// that is exactly when they need to find it.
test("a principal is searchable, not only a role", () => {
  const filtered = filterForest(fleet, "jx2ua");

  expect(filtered[0].children[0].children[0].role).toBe("user_shard");
});

test("matching is case-insensitive", () => {
  expect(filterForest(fleet, "USER_SHARD")).toEqual(filterForest(fleet, "user_shard"));
  expect(filterForest(fleet, "JX2UA")).toEqual(filterForest(fleet, "jx2ua"));
});

/// A partial role matches every member of a family, which is how a reader narrows
/// a hundred canisters to the handful they mean.
test("a partial role matches a whole family", () => {
  const filtered = filterForest(fleet, "project");
  const under = filtered[0].children;

  expect(under.map((child) => child.role)).toEqual(["project_hub"]);
  expect(under[0].children[0].role).toBe("project_instance");
  expect(under[0].children[0].children[0].role).toBe("project_ledger");
});

test("a query matching nothing yields an empty forest", () => {
  expect(filterForest(fleet, "nothing-here")).toEqual([]);
});

/// The counts are what make a collapsed node informative: `project_hub · 2` says
/// what is inside without expanding it.
test("descendants are counted at every depth, not just the immediate children", () => {
  const root = fleet[0];

  // wasm_store, discovery_hub, discovery_shard, project_hub, project_instance,
  // project_ledger, user_hub, user_shard.
  expect(descendantCount(root)).toBe(8);
  const projectHub = root.children.find((child) => child.role === "project_hub")!;
  expect(descendantCount(projectHub)).toBe(2);
  expect(descendantCount(root.children[0])).toBe(0);
});

test("forest size counts every canister including the roots", () => {
  // The eight above, plus root itself.
  expect(forestSize(fleet)).toBe(9);
  expect(forestSize([])).toBe(0);
});

/// A fleet with several roots is the documented shape — a plain project may list
/// canisters with no root at all — so filtering must not assume one.
test("a multi-root fleet filters each root independently", () => {
  const forest: TreeNode[] = [
    { pid: "a", role: "alpha", children: [] },
    { pid: "b", role: "beta", children: [{ pid: "c", role: "alpha_child", children: [] }] },
  ];

  expect(filterForest(forest, "alpha").map((node) => node.role)).toEqual(["alpha", "beta"]);
  expect(filterForest(forest, "beta").map((node) => node.role)).toEqual(["beta"]);
});
