import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { SqlConsole } from "./SqlConsole";

const entities = [
  { name: "User", storePath: "", storage: "stable", columns: 3, indexes: 0, relations: 0, schemaVersion: 1 },
];

const schema = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    { name: "handle", typeName: "Text", primaryKey: false, optional: true },
  ],
  indexes: [],
};

/// Sets the statement the way a user typing would, through CodeMirror's own
/// public `findFromDOM`. Reaching for the editor's view rather than a textarea
/// is the cost of a real editor; using the documented entry point rather than
/// internals keeps it honest.
function typeSql(text: string) {
  const host = document.querySelector<HTMLElement>("[data-sql-editor]");
  if (!host) throw new Error("no editor mounted");
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error("no CodeMirror view found");
  // Inside `act`: the editor's update listener calls back into React state, and
  // without flushing that the console still holds the previous statement when
  // the assertion runs.
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}

test("the editor mounts and holds the statement", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User");

  expect(document.querySelector("[data-sql-editor]")?.textContent).toContain("SELECT * FROM User");
});

test("running sends what the editor holds", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User");

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(ran).toEqual(["SELECT * FROM User"]);
});

/// The most-hit failure in this app: icydb rejects LIMIT without an explicit
/// ordering. Offered as one click, using the real primary key.
test("a LIMIT with no ORDER BY offers the fix", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User LIMIT 100");

  expect(screen.getByRole("button", { name: /ORDER BY id/ })).toBeInTheDocument();
});

/// Appending would give `LIMIT 100 ORDER BY id`, which is not valid SQL. This
/// also proves the assist reaches the editor: it rewrites the statement from
/// outside, which a one-way editor would swallow.
test("taking the assist rewrites the statement into a runnable one", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User LIMIT 100");

  fireEvent.click(screen.getByRole("button", { name: /ORDER BY id/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  expect(ran).toEqual(["SELECT * FROM User ORDER BY id LIMIT 100"]);
});

test("a statement that already orders is offered no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User ORDER BY handle LIMIT 100");

  expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
});

/// Without a schema there is no honest primary key to propose.
test("no schema means no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={null} />);
  typeSql("SELECT * FROM User LIMIT 100");

  expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
});

test("the console works with no schema or entities at all", () => {
  render(<SqlConsole onRun={() => {}} />);

  expect(document.querySelector("[data-sql-editor]")).toBeInTheDocument();
});

/// Highlighting is what a plain textarea could not do. jsdom applies no styles,
/// so this pins that the language is parsed and tokens are marked up — the
/// precondition for colour — not that anything is a particular colour.
test("SQL is tokenised, which is what highlighting needs", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User");

  const marked = document.querySelectorAll("[data-sql-editor] .cm-line span");
  expect(marked.length).toBeGreaterThan(0);
});
