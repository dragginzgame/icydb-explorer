import { expect, test } from "vitest";

import type { TreeNode } from "../api/types";
import { fleetIndex, fleetLinks, hasFleetLink } from "./fleetLinks";

/** toko's real fleet, principals included, read off the running replica. */
const forest: TreeNode[] = [
  {
    pid: "igqk7-g3777-77774-qaaba-cai",
    role: "root",
    children: [
      {
        pid: "i2uqo-r3777-77774-qaada-cai",
        role: "project_hub",
        children: [
          { pid: "j6z74-i3777-77774-qaafa-cai", role: "project_instance", children: [] },
          { pid: "jzyzi-fd777-77774-qaafq-cai", role: "project_ledger", children: [] },
        ],
      },
      { pid: "jx2ua-6t777-77774-qaaeq-cai", role: "user_shard", children: [] },
    ],
  },
];

const index = fleetIndex(forest);

/// Real values from toko: a user principal is self-authenticating and 29 groups
/// long, a canister id is five groups ending `-cai`. Both are principals; only
/// one is in the fleet.
const USER_PRINCIPAL = "b3bcf-xxk7r-uy5st-idags-wlqaj-yd64m-65y2h-pi4oh-7pjmh-zdgac-cqe";
const PROJECT_INSTANCE = "j6z74-i3777-77774-qaafa-cai";

test("the index covers every canister at every depth", () => {
  expect(index.size).toBe(5);
  expect(index.get(PROJECT_INSTANCE)).toBe("project_instance");
  expect(index.get("igqk7-g3777-77774-qaaba-cai")).toBe("root");
});

/// The case this feature exists for: a principal that names a canister in this
/// fleet. Verified, not inferred — set membership, not a heuristic.
test("a principal naming a fleet canister resolves to its role", () => {
  expect(fleetLinks({ kind: "principal", display: PROJECT_INSTANCE }, index)).toEqual([
    { pid: PROJECT_INSTANCE, role: "project_instance" },
  ]);
});

/// Most principals in a fleet's data are users. Saying nothing about them is the
/// correct answer and the common case, so it has to read as normal rather than as
/// a failure to resolve.
test("a user principal resolves to nothing", () => {
  expect(fleetLinks({ kind: "principal", display: USER_PRINCIPAL }, index)).toEqual([]);
  expect(hasFleetLink({ kind: "principal", display: USER_PRINCIPAL }, index)).toBe(false);
});

/// The real shape that motivated scanning text rather than typed values:
/// `UserProjects.projects` is a `map<principal, record{pid:principal, …}>`, and
/// its canister ids live nested inside the rendered map.
test("a principal nested inside a rendered map is found", () => {
  const cell = {
    kind: "map",
    display: `{${PROJECT_INSTANCE}: {pid: ${PROJECT_INSTANCE}, status: ProjectStatus::Saved}}`,
  };

  expect(fleetLinks(cell, index)).toEqual([
    { pid: PROJECT_INSTANCE, role: "project_instance" },
  ]);
});

/// One cell can name the same canister twice — a map keyed by principal whose
/// value repeats it. Two chips for one canister would say there are two.
test("the same canister named twice yields one link", () => {
  const cell = { kind: "map", display: `{${PROJECT_INSTANCE}: ${PROJECT_INSTANCE}}` };

  expect(fleetLinks(cell, index)).toHaveLength(1);
});

test("several distinct canisters in one cell all resolve, in order of appearance", () => {
  const cell = {
    kind: "list",
    display: `[jzyzi-fd777-77774-qaafq-cai, ${PROJECT_INSTANCE}]`,
  };

  expect(fleetLinks(cell, index).map((link) => link.role)).toEqual([
    "project_ledger",
    "project_instance",
  ]);
});

/// A cell holding both kinds is the common real case — a record with a user's
/// principal and a canister's. Only the canister resolves.
test("a mixed cell resolves only the canister", () => {
  const cell = {
    kind: "map",
    display: `{claimer_pid: ${USER_PRINCIPAL}, ledger_pid: jzyzi-fd777-77774-qaafq-cai}`,
  };

  expect(fleetLinks(cell, index)).toEqual([
    { pid: "jzyzi-fd777-77774-qaafq-cai", role: "project_ledger" },
  ]);
});

/// The safety argument for scanning text: a token this over-matches cannot equal
/// a canister id, so it disappears. There is no wrong row to fetch, which is the
/// opposite of the relation-key case where parsing text was rejected.
test("dashed text that is not a principal resolves to nothing", () => {
  const cases = [
    { kind: "text", display: "some-dashed-slug" },
    { kind: "text", display: "2026-08-04" },
    { kind: "text", display: "not-a-real-canister-id-cai" },
    { kind: "ulid", display: "01JBQPZ4M8W2K7V3N1X5T9R2P" },
    { kind: "nat", display: "1785831001051" },
    { kind: "null", display: "" },
  ];

  for (const cell of cases) {
    expect(fleetLinks(cell, index), cell.display).toEqual([]);
  }
});

/// An empty fleet resolves nothing rather than throwing — the tree is null while
/// it loads, and cells render before it arrives.
test("an empty fleet resolves nothing", () => {
  expect(fleetLinks({ kind: "principal", display: PROJECT_INSTANCE }, fleetIndex([]))).toEqual([]);
});
