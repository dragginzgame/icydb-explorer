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

/// CodeMirror binds keys on its content element, so events go there rather than
/// to the host div.
function pressKey(key: string, modifiers: Record<string, boolean> = {}) {
  const content = document.querySelector<HTMLElement>("[data-sql-editor] .cm-content");
  if (!content) throw new Error("no editor content element");
  act(() => {
    fireEvent.keyDown(content, { key, ...modifiers });
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

  fireEvent.click(screen.getByRole("button", { name: /^run/i }));
  expect(ran).toEqual(["SELECT * FROM User"]);
});

/// The most-hit failure in this app: icydb rejects LIMIT without an explicit
/// ordering. The hint names the rule, says why, and offers the keystroke — in
/// that order, because a reader who has understood the rule needs the key, not
/// the prose, next time.
test("a LIMIT with no ORDER BY states the rule and offers the keystroke", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User LIMIT 100");

  expect(screen.getByText("ORDER BY required")).toBeInTheDocument();
  // Names the actual clause it would insert, derived from the real primary key.
  expect(screen.getByText(/ORDER BY id/)).toBeInTheDocument();
  // The reasoning is on hover: worth reading once, not worth a line of the bar
  // every time. It still has to exist somewhere.
  expect(screen.getByTitle(/icydb rejects LIMIT without an explicit ordering/)).toBeInTheDocument();
});

/// Appending would give `LIMIT 100 ORDER BY id`, which is not valid SQL. This
/// also proves the assist reaches the editor: it rewrites the statement from
/// outside, which a one-way editor would swallow.
test("pressing Tab takes the assist and produces a runnable statement", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User LIMIT 100");

  pressKey("Tab");
  fireEvent.click(screen.getByRole("button", { name: /^run/i }));

  expect(ran).toEqual(["SELECT * FROM User ORDER BY id LIMIT 100"]);
});

/// Tab must not swallow itself when there is nothing to insert, or the editor
/// loses ordinary indentation and focus movement.
test("Tab does nothing when no assist is pending", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User ORDER BY id LIMIT 100");

  pressKey("Tab");

  expect(document.querySelector("[data-sql-editor]")?.textContent).toContain(
    "SELECT * FROM User ORDER BY id LIMIT 100",
  );
});

/// The design puts run on Mod-Enter, so the reader never has to leave the
/// keyboard to execute what they just typed.
test("Mod-Enter runs the statement", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  typeSql("SELECT 1");

  // CodeMirror's `Mod-` is Cmd on macOS and Ctrl elsewhere, resolved by its own
  // platform detection — which under jsdom reports the non-Mac branch. Firing
  // both keeps this test about the binding rather than about the host.
  pressKey("Enter", { metaKey: true });
  if (ran.length === 0) pressKey("Enter", { ctrlKey: true });

  expect(ran).toEqual(["SELECT 1"]);
});

test("a statement that already orders is offered no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  typeSql("SELECT * FROM User ORDER BY handle LIMIT 100");

  expect(screen.queryByText("ORDER BY required")).not.toBeInTheDocument();
});

/// Without a schema there is no honest primary key to propose.
test("no schema means no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={null} />);
  typeSql("SELECT * FROM User LIMIT 100");

  expect(screen.queryByText("ORDER BY required")).not.toBeInTheDocument();
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

const target = { canister: "user_shard", entity: "User" };

/// Every statement here reaches one canister — each is its own icydb database —
/// and nothing else on screen said which.
test("the console names what it is querying", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);

  expect(screen.getByText("user_shard")).toBeInTheDocument();
  expect(screen.getByText("User")).toBeInTheDocument();
  expect(screen.getByText(/separate database/)).toBeInTheDocument();
});

/// An empty editor is where someone who does not write SQL gives up. The
/// shortest correct statement needs a bound and an ordering — longer than a
/// newcomer would guess — so it is offered whole rather than described.
test("an empty editor offers a complete runnable statement", () => {
  const ran: string[] = [];
  render(
    <SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} target={target} />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Start with/ }));
  fireEvent.click(screen.getByRole("button", { name: /^run/i }));

  expect(ran).toEqual(["SELECT * FROM User ORDER BY id LIMIT 100"]);
});

test("the starter offer disappears once something is typed", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);
  typeSql("SELECT 1");

  expect(screen.queryByRole("button", { name: /Start with/ })).not.toBeInTheDocument();
});

/// The case that produced the unhelpful prose: no bound and no ordering. It is
/// now the same one-keystroke offer as the LIMIT case, with a real clause in it.
test("a bare SELECT offers both the order and the limit", () => {
  const ran: string[] = [];
  render(
    <SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} target={target} />,
  );
  typeSql("SELECT * FROM User");

  expect(screen.getByText("Needs a limit and an order")).toBeInTheDocument();
  expect(screen.getByText("ORDER BY id LIMIT 100")).toBeInTheDocument();

  pressKey("Tab");
  fireEvent.click(screen.getByRole("button", { name: /^run/i }));

  expect(ran).toEqual(["SELECT * FROM User ORDER BY id LIMIT 100"]);
});

/// The old prose is a fallback for when no key is known, never the plan — and it
/// must not appear alongside an offer that already does the job.
test("the prose fallback never competes with the offer", () => {
  render(
    <SqlConsole
      onRun={() => {}}
      entities={entities}
      schema={schema}
      target={target}
      orderByMissing
    />,
  );
  typeSql("SELECT * FROM User");

  expect(screen.queryByText(/Needs an ORDER BY before icydb/)).not.toBeInTheDocument();
  expect(screen.getByText("Needs a limit and an order")).toBeInTheDocument();
});

test("with no schema the prose fallback is what is left", () => {
  render(
    <SqlConsole onRun={() => {}} entities={entities} schema={null} target={target} orderByMissing />,
  );
  typeSql("SELECT * FROM User");

  expect(screen.getByText(/Needs an ORDER BY before icydb/)).toBeInTheDocument();
});

/// Run sits beside the input, not under it. The editor is usually one line, so a
/// button on its own row below reads as a second, separate thing — where next to
/// the input it reads as what you do with what you typed.
test("run sits beside the input, on the same row", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);

  const run = screen.getByRole("button", { name: /^run/i });
  const editorWrapper = document.querySelector("[data-sql-editor]")?.parentElement;

  // The same *immediate* parent, so they are genuinely siblings on one row.
  // `contains` was the first version of this and it passed with the button moved
  // anywhere inside the console — every ancestor contains the editor.
  expect(editorWrapper?.parentElement).toBe(run.parentElement);
});

/// And the row below carries only what the statement needs next, so it costs
/// nothing when there is nothing to say.
test("the row below the input holds the hint and not the run control", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);
  typeSql("SELECT * FROM User LIMIT 100");

  const assist = screen.getByText("ORDER BY required").closest("button");
  const run = screen.getByRole("button", { name: /^run/i });

  expect(assist?.parentElement?.contains(run)).toBe(false);
});

/// The shortcut is a property of the button, so it belongs on it rather than in a
/// separate hint about a control elsewhere.
test("the run control carries its own shortcut", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);

  const run = screen.getByRole("button", { name: /^run/i });
  expect(run.textContent).toMatch(/⌘⏎/);
});

/// The editor takes the room and the button takes only what it needs, so a long
/// statement widens the input rather than squeezing the control.
test("the input takes the space and run takes only what it needs", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);

  const run = screen.getByRole("button", { name: /^run/i });
  const editorWrapper = document.querySelector("[data-sql-editor]")?.parentElement;

  expect(run.className).toMatch(/\bshrink-0\b/);
  expect(editorWrapper?.className).toMatch(/\bflex-1\b/);
  expect(editorWrapper?.className).toMatch(/\bmin-w-0\b/);
});

/// Only one thing is offered at a time. A starter query and an ORDER BY assist
/// both competing for the same row would be two answers to "what do I do next".
test("the starter offer yields to the assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} target={target} />);
  typeSql("SELECT * FROM User");

  expect(screen.getByText("Needs a limit and an order")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Start with/ })).not.toBeInTheDocument();
});
