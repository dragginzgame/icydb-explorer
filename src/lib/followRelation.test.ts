import { expect, test } from "vitest";

import {
  FOLLOW_LIMIT,
  followPlan,
  followStatement,
  primaryKeyOf,
  relationKeys,
} from "./followRelation";

const single = {
  field: "owner",
  targetEntity: "User",
  targetStorePath: "toko::user::store::UserStore",
  cardinality: "single",
};

const list = {
  field: "assets",
  targetEntity: "ProjectAsset",
  targetStorePath: "toko::project::store::AssetStore",
  cardinality: "list",
};

const KEY_A = "01JB8Z4KQ7Y3M2XV9P0N5RK2M";
const KEY_B = "01JB9C7TQ4N8W1ZD3H6L2QF4N";

/// A single relation's cell *is* the key.
test("a scalar cell yields its own value as the one key", () => {
  expect(relationKeys({ kind: "ulid", display: KEY_A })).toEqual([KEY_A]);
});

/// A list relation's keys arrive structured, so they are read rather than parsed
/// back out of the rendered `[a, b]` — a mis-parse would query the wrong row.
test("a list cell yields its elements, not its rendered text", () => {
  const cell = {
    kind: "list",
    display: `[${KEY_A}, ${KEY_B}]`,
    items: [
      { kind: "ulid", display: KEY_A },
      { kind: "ulid", display: KEY_B },
    ],
  };

  expect(relationKeys(cell)).toEqual([KEY_A, KEY_B]);
});

/// A key containing the separator would defeat any parse of `display`. This is
/// the case that makes the structured elements load-bearing rather than tidier.
test("a text key containing the list separator survives intact", () => {
  const cell = {
    kind: "list",
    display: "[a, b, c]",
    items: [
      { kind: "text", display: "a, b" },
      { kind: "text", display: "c" },
    ],
  };

  expect(relationKeys(cell)).toEqual(["a, b", "c"]);
});

/// A null inside a list is not a key. `value_to_dto` gives a null an empty
/// display, so this is how one arrives.
test("empty elements are dropped rather than becoming empty keys", () => {
  const cell = {
    kind: "list",
    display: "[a]",
    items: [
      { kind: "ulid", display: KEY_A },
      { kind: "null", display: "" },
    ],
  };

  expect(relationKeys(cell)).toEqual([KEY_A]);
});

/// A null single relation holds no key.
test("a null cell yields no keys", () => {
  expect(relationKeys({ kind: "null", display: "" })).toEqual([]);
});

/// An empty list relation is an ordinary state of a row — a project with no
/// assets — so there is nothing to follow and no affordance to offer.
test("an empty list yields no plan rather than a plan that would fail", () => {
  const cell = { kind: "list", display: "[]", items: [] };

  expect(followPlan(list, cell)).toBeNull();
});

test("a null single relation yields no plan", () => {
  expect(followPlan(single, { kind: "null", display: "" })).toBeNull();
});

/// Cardinality decides whether this lands on one row or many, so the UI can say
/// which before anything runs.
test("cardinality decides one-or-many, not the number of keys present", () => {
  const oneElement = {
    kind: "list",
    display: `[${KEY_A}]`,
    items: [{ kind: "ulid", display: KEY_A }],
  };

  // A one-element list is still a `list`: the UI must not promise a single row
  // it cannot guarantee just because this particular row holds one key.
  expect(followPlan(list, oneElement)?.many).toBe(true);
  expect(followPlan(single, { kind: "ulid", display: KEY_A })?.many).toBe(false);
});

test("a set behaves as many, like a list", () => {
  const cell = { kind: "list", display: `[${KEY_A}]`, items: [{ kind: "ulid", display: KEY_A }] };

  expect(followPlan({ ...list, cardinality: "set" }, cell)?.many).toBe(true);
});

/// One key is an equality, which is what a primary-key lookup should be.
test("one key produces an equality against the target's primary key", () => {
  const plan = followPlan(single, { kind: "ulid", display: KEY_A })!;

  expect(followStatement(plan, "id")).toBe(
    `SELECT * FROM User WHERE id = '${KEY_A}' ORDER BY id LIMIT ${FOLLOW_LIMIT}`,
  );
});

/// icydb supports `IN` as a predicate — unlike `JOIN` — so many keys are one
/// statement rather than one statement per key.
test("many keys produce a single IN predicate", () => {
  const cell = {
    kind: "list",
    display: "",
    items: [
      { kind: "ulid", display: KEY_A },
      { kind: "ulid", display: KEY_B },
    ],
  };
  const plan = followPlan(list, cell)!;

  expect(followStatement(plan, "id")).toBe(
    `SELECT * FROM ProjectAsset WHERE id IN ('${KEY_A}', '${KEY_B}') ` +
      `ORDER BY id LIMIT ${FOLLOW_LIMIT}`,
  );
});

/// The target's primary key is not assumed to be `id`. Assuming it would fail as
/// a confusing SQL error on any entity that names its key something else.
test("the statement matches whatever column the target calls its key", () => {
  const plan = followPlan(single, { kind: "ulid", display: KEY_A })!;

  expect(followStatement(plan, "user_id")).toContain("WHERE user_id =");
  expect(followStatement(plan, "user_id")).toContain("ORDER BY user_id");
});

/// icydb rejects LIMIT without an explicit ordering, so a bounded statement with
/// no ORDER BY would fail outright. Every followed relation is bounded.
test("every statement is both ordered and bounded", () => {
  const plan = followPlan(single, { kind: "ulid", display: KEY_A })!;
  const statement = followStatement(plan, "id");

  expect(statement).toMatch(/ORDER BY id LIMIT \d+$/);
  expect(statement).toContain(`LIMIT ${FOLLOW_LIMIT}`);
});

/// A key that closes the literal early would not be a display bug — it would be
/// a statement that reads something other than what was clicked.
test("a quote in a key is escaped rather than ending the literal", () => {
  const plan = followPlan(single, { kind: "text", display: "o'brien" })!;

  expect(followStatement(plan, "handle")).toContain("handle = 'o''brien'");
});

test("quotes are escaped inside an IN list too", () => {
  const cell = {
    kind: "list",
    display: "",
    items: [
      { kind: "text", display: "a'b" },
      { kind: "text", display: "c" },
    ],
  };
  const plan = followPlan(list, cell)!;

  expect(followStatement(plan, "id")).toContain("IN ('a''b', 'c')");
});

const schema = (columns: { name: string; primaryKey: boolean }[]) => ({
  entity: "User",
  columns: columns.map((c) => ({ ...c, typeName: "ulid", optional: false })),
  indexes: [],
  relations: [],
});

test("the primary key is read from the described target", () => {
  expect(
    primaryKeyOf(schema([{ name: "user_id", primaryKey: true }, { name: "handle", primaryKey: false }])),
  ).toBe("user_id");
});

/// Without a key column there is nothing to match against, and saying so beats
/// falling back to `id` and querying a column that may not exist.
test("an entity with no primary key has none, rather than defaulting to id", () => {
  expect(primaryKeyOf(schema([{ name: "id", primaryKey: false }]))).toBeNull();
});

/// A relation carries one value per key, so a composite key cannot be matched.
/// Matching one column of several would silently over-report.
test("a composite key is not followable and reports as much", () => {
  expect(
    primaryKeyOf(schema([{ name: "shard", primaryKey: true }, { name: "seq", primaryKey: true }])),
  ).toBeNull();
});
