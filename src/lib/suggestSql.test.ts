import { applyOrderByAssist, applySuggestion, orderByAssist, suggestSql } from "./suggestSql";

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

/// The single most-hit failure in this app: icydb rejects LIMIT without an
/// explicit ordering. This turns reading an error into taking an offer.
test("a LIMIT with no ORDER BY is offered the primary key", () => {
  expect(orderByAssist("SELECT * FROM User LIMIT 100", schema)).toBe("ORDER BY id");
});

test("a composite key orders by every part", () => {
  const composite = {
    ...schema,
    columns: [
      { name: "tenant", typeName: "Text", primaryKey: true, optional: false },
      { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    ],
  };

  expect(orderByAssist("SELECT * FROM User LIMIT 10", composite)).toBe("ORDER BY tenant, id");
});

test("a statement that already orders is left alone", () => {
  expect(orderByAssist("SELECT * FROM User ORDER BY handle LIMIT 100", schema)).toBeNull();
});

test("a statement with no LIMIT needs no assist", () => {
  expect(orderByAssist("SELECT * FROM User", schema)).toBeNull();
});

/// OFFSET requires an ordering for the same reason LIMIT does.
test("OFFSET alone also triggers the assist", () => {
  expect(orderByAssist("SELECT * FROM User OFFSET 20", schema)).toBe("ORDER BY id");
});

/// Nothing honest to propose without a known key.
test("no known primary key means no assist", () => {
  expect(orderByAssist("SELECT * FROM User LIMIT 100", null)).toBeNull();
});

/// Appending would produce `LIMIT 100 ORDER BY id`, which is not valid SQL —
/// the ordering has to precede the window it orders.
test("the assist is inserted before LIMIT, not appended", () => {
  expect(applyOrderByAssist("SELECT * FROM User LIMIT 100", "ORDER BY id")).toBe(
    "SELECT * FROM User ORDER BY id LIMIT 100",
  );
});

test("the assist is inserted before OFFSET too", () => {
  expect(applyOrderByAssist("SELECT * FROM User OFFSET 20", "ORDER BY id")).toBe(
    "SELECT * FROM User ORDER BY id OFFSET 20",
  );
});
