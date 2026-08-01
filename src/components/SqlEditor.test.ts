import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";

import { sqlCompletionSource } from "./SqlEditor";

const entities = [
  { name: "User", storePath: "", storage: "stable", columns: 3, indexes: 0, relations: 0, schemaVersion: 1 },
  { name: "UserFriends", storePath: "", storage: "stable", columns: 2, indexes: 0, relations: 0, schemaVersion: 1 },
];

const schema = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    { name: "handle", typeName: "Text", primaryKey: false, optional: true },
  ],
  indexes: [],
};

/// Drives the completion source the way CodeMirror does: a document, a cursor,
/// and whether the user asked explicitly.
function complete(doc: string, explicit = false) {
  const state = EditorState.create({ doc });
  const context = new CompletionContext(state, doc.length, explicit);

  return sqlCompletionSource(() => ({ entities, schema }))(context);
}

test("after FROM it offers the canister's tables", () => {
  const result = complete("SELECT * FROM ");

  expect(result?.options.map((o) => o.label)).toContain("User");
});

test("a partial word narrows the options", () => {
  const result = complete("SELECT * FROM Userf", true);

  expect(result?.options.map((o) => o.label)).toEqual(["UserFriends"]);
});

/// `from` must point at the start of the partial word. Pointing at the cursor
/// would insert beside it, completing `us` to `usUser`.
test("the replacement range covers the partial word", () => {
  const doc = "SELECT * FROM Use";
  const result = complete(doc, true);

  expect(result?.from).toBe(doc.length - "Use".length);
});

test("with no partial word the range starts at the cursor", () => {
  const doc = "SELECT * FROM ";
  const result = complete(doc);

  expect(result?.from).toBe(doc.length);
});

/// The popup must not open mid-punctuation, where there is nothing useful to
/// offer — but must still open when the user asks for it explicitly.
test("no unprompted popup mid-punctuation", () => {
  expect(complete("SELECT * FROM User,")).toBeNull();
  expect(complete("SELECT * FROM User,", true)).not.toBeNull();
});

test("columns carry their type and mark the primary key", () => {
  const result = complete("SELECT * FROM User WHERE ");
  const id = result?.options.find((o) => o.label === "id");

  expect(id?.detail).toMatch(/primary key/);
});

/// The editor is constructed once, so a schema arriving later must still reach
/// the completion source — hence the getter rather than a captured value.
test("a schema that arrives after construction is still used", () => {
  let live: { entities: typeof entities | null; schema: typeof schema | null } = {
    entities: null,
    schema: null,
  };
  const source = sqlCompletionSource(() => live);

  const before = source(new CompletionContext(EditorState.create({ doc: "SELECT * FROM " }), 14, false));
  expect(before?.options.map((o) => o.label) ?? []).not.toContain("User");

  live = { entities, schema };
  const after = source(new CompletionContext(EditorState.create({ doc: "SELECT * FROM " }), 14, false));
  expect(after?.options.map((o) => o.label)).toContain("User");
});
