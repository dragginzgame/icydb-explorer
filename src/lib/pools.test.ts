import { expect, test } from "vitest";

import type { TreeNode } from "../api/types";
import { flatten, poolOf, pools, roleOfPid } from "./pools";

/** Shaped like toko: a root, hubs, and a shard pool under one of them. */
const forest: TreeNode[] = [
  {
    pid: "root",
    role: "root",
    children: [
      {
        pid: "uhub",
        role: "user_hub",
        children: [
          { pid: "us1", role: "user_shard", children: [] },
          { pid: "us2", role: "user_shard", children: [] },
          { pid: "us3", role: "user_shard", children: [] },
        ],
      },
      { pid: "mkt", role: "market", children: [] },
    ],
  },
];

test("flatten yields every canister, parents before children", () => {
  expect(flatten(forest).map((node) => node.pid)).toEqual([
    "root",
    "uhub",
    "us1",
    "us2",
    "us3",
    "mkt",
  ]);
});

/// canic gives every canister provisioned from a pool the role that pool
/// declares, so the role string is the grouping — no naming convention to guess.
test("canisters sharing a role form a pool", () => {
  expect(pools(forest)).toEqual([{ role: "user_shard", members: ["us1", "us2", "us3"] }]);
});

/// A role held by one canister is not a pool. Offering to "sweep" it would dress
/// a single query up as a fan-out: same statement, same one canister.
test("a role with one canister is not a pool", () => {
  expect(pools(forest).some((pool) => pool.role === "market")).toBe(false);
  expect(pools(forest).some((pool) => pool.role === "root")).toBe(false);
});

test("a pool member finds its pool", () => {
  expect(poolOf(forest, "us2")).toEqual({
    role: "user_shard",
    members: ["us1", "us2", "us3"],
  });
});

/// Null is the common case and is what tells the UI there is no scope to widen.
test("a canister alone in its role has no pool", () => {
  expect(poolOf(forest, "mkt")).toBeNull();
  expect(poolOf(forest, "root")).toBeNull();
});

test("an unknown canister has no pool and no role", () => {
  expect(poolOf(forest, "nope")).toBeNull();
  expect(roleOfPid(forest, "nope")).toBeNull();
});

/// A principal is not something a reader recognises, so the UI names canisters
/// by role.
test("a canister's role is available for labelling", () => {
  expect(roleOfPid(forest, "us1")).toBe("user_shard");
  expect(roleOfPid(forest, "mkt")).toBe("market");
});

/// Pool members need not be siblings: canic can place them anywhere, and the role
/// is what groups them.
test("a pool spans the fleet rather than one parent's children", () => {
  const scattered: TreeNode[] = [
    { pid: "a", role: "worker", children: [{ pid: "b", role: "other", children: [] }] },
    { pid: "c", role: "other", children: [] },
  ];

  expect(pools(scattered)).toEqual([{ role: "other", members: ["b", "c"] }]);
});

test("an empty fleet has no pools", () => {
  expect(pools([])).toEqual([]);
});
