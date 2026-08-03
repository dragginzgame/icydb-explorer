import {
  applyOrderByAssist,
  applySuggestion,
  orderByAssist,
  starterQuery,
  suggestSql,
} from "./suggestSql";

const entities = [
  { name: "User", storePath: "", storage: "stable", columns: 5, indexes: 1, relations: 0, schemaVersion: 1 },
  { name: "UserFriends", storePath: "", storage: "stable", columns: 3, indexes: 0, relations: 0, schemaVersion: 1 },
];

const schema = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    { name: "handle", typeName: "Text", primaryKey: false, optional: true },
    { name: "created_at", typeName: "Nat64", primaryKey: false, optional: false },
    { name: "__icydb_primary_key", typeName: "Unit", primaryKey: false, optional: false },
  ],
  indexes: [],
};

const texts = (sql: string) => suggestSql(sql, entities, schema).map((s) => s.text);

test("an empty console offers only statements this app will send", () => {
  expect(texts("")).toEqual(["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"]);
});

/// A flat dictionary of every identifier is not help — it is the scrolling the
/// schema pane already offers. After FROM, tables are the answer.
test("after FROM it offers tables", () => {
  const suggestions = suggestSql("SELECT * FROM ", entities, schema);

  expect(suggestions.filter((s) => s.kind === "table").map((s) => s.text)).toEqual([
    "User",
    "UserFriends",
  ]);
});

test("after DESCRIBE it offers tables", () => {
  expect(texts("DESCRIBE ")).toContain("User");
});

test("in a column position it offers the named table's columns", () => {
  const suggestions = suggestSql("SELECT * FROM User WHERE ", entities, schema);
  const columns = suggestions.filter((s) => s.kind === "column").map((s) => s.text);

  expect(columns).toContain("handle");
  expect(columns).toContain("id");
});

/// icydb's own bookkeeping columns show up in a schema but are not something to
/// write into a query.
test("icydb internal columns are never suggested", () => {
  expect(texts("SELECT * FROM User WHERE ")).not.toContain("__icydb_primary_key");
});

/// This app holds a full schema only for the selected entity. Offering another
/// table's columns would be a confident lie, so it offers none.
test("a statement naming a different table gets no columns", () => {
  const suggestions = suggestSql("SELECT * FROM UserFriends WHERE ", entities, schema);

  expect(suggestions.filter((s) => s.kind === "column")).toEqual([]);
});

test("a partial word filters, case-insensitively", () => {
  expect(texts("SELECT * FROM us")).toEqual(["User", "UserFriends"]);
});

/// Suggesting the word already typed is noise.
test("an exact match is not suggested back", () => {
  expect(texts("SELECT * FROM User")).not.toContain("User");
});

test("the primary key is marked, so the reader can see which column it is", () => {
  const id = suggestSql("SELECT * FROM User WHERE ", entities, schema).find((s) => s.text === "id");

  expect(id?.detail).toMatch(/primary key/);
});

test("taking a suggestion replaces the partial word", () => {
  expect(applySuggestion("SELECT * FROM us", "User")).toBe("SELECT * FROM User ");
  expect(applySuggestion("SELECT * FROM ", "User")).toBe("SELECT * FROM User ");
});

// --- the ORDER BY assist ---

/// icydb rejects LIMIT without an ordering, so the ordering alone is the fix.
test("a LIMIT with no ORDER BY is offered the primary key", () => {
  const assist = orderByAssist("SELECT * FROM User LIMIT 100", schema);

  expect(assist?.insertion).toBe("ORDER BY id");
  expect(assist?.withLimit).toBeNull();
});

/// The case that produced the unhelpful prose. A bare SELECT needs *both* a
/// bound and an ordering — this app will not send an unbounded read, and icydb
/// will not take the bound without the ordering — so the offer covers both
/// rather than fixing half and leaving the reader to find the rest.
test("a statement with neither bound nor ordering is offered both", () => {
  const assist = orderByAssist("SELECT * FROM User", schema);

  expect(assist?.insertion).toBe("ORDER BY id LIMIT 100");
  expect(assist?.withLimit).toBe(100);
});

test("a composite key orders by every part", () => {
  const composite = {
    ...schema,
    columns: [
      { name: "tenant", typeName: "Text", primaryKey: true, optional: false },
      { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    ],
  };

  expect(orderByAssist("SELECT * FROM User LIMIT 10", composite)?.clause).toBe(
    "ORDER BY tenant, id",
  );
});

test("a statement that already orders is left alone", () => {
  expect(orderByAssist("SELECT * FROM User ORDER BY handle LIMIT 100", schema)).toBeNull();
});

/// Offering a clause while the reader is still typing the table name is noise,
/// and the table is what makes this key the right key to offer.
test("an incomplete statement is not second-guessed", () => {
  expect(orderByAssist("SELECT * FROM", schema)).toBeNull();
  expect(orderByAssist("SELECT ", schema)).toBeNull();
});

/// Only SELECT paginates. SHOW and DESCRIBE need none of this.
test("a non-SELECT is left alone", () => {
  expect(orderByAssist("SHOW ENTITIES", schema)).toBeNull();
  expect(orderByAssist("DESCRIBE User", schema)).toBeNull();
});

/// OFFSET requires an ordering for the same reason LIMIT does.
test("OFFSET alone also triggers the assist", () => {
  expect(orderByAssist("SELECT * FROM User OFFSET 20", schema)?.insertion).toBe("ORDER BY id");
});

/// Nothing honest to propose without a known key.
test("no known primary key means no assist", () => {
  expect(orderByAssist("SELECT * FROM User LIMIT 100", null)).toBeNull();
});

/// Appending would produce `LIMIT 100 ORDER BY id`, which is not valid SQL —
/// the ordering has to precede the window it orders.
test("the assist is inserted before LIMIT, not appended", () => {
  const assist = orderByAssist("SELECT * FROM User LIMIT 100", schema)!;

  expect(applyOrderByAssist("SELECT * FROM User LIMIT 100", assist)).toBe(
    "SELECT * FROM User ORDER BY id LIMIT 100",
  );
});

test("with no window yet, the whole clause goes on the end", () => {
  const assist = orderByAssist("SELECT * FROM User", schema)!;

  expect(applyOrderByAssist("SELECT * FROM User", assist)).toBe(
    "SELECT * FROM User ORDER BY id LIMIT 100",
  );
});

// --- the starter query ---

/// The shortest correct statement is longer than a newcomer would guess: the
/// bound is required by this app, the ordering by icydb. So it is offered whole
/// rather than described.
test("the starter query is complete and runnable", () => {
  expect(starterQuery("User", schema)).toBe("SELECT * FROM User ORDER BY id LIMIT 100");
});

test("the starter query still bounds itself with no known key", () => {
  expect(starterQuery("User", null)).toBe("SELECT * FROM User LIMIT 100");
});
