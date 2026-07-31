import { render, screen, fireEvent } from "@testing-library/react";

import { SchemaInspector } from "./SchemaInspector";

const SCHEMA = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", optional: false, primaryKey: true },
    { name: "handle", typeName: "Text", optional: true, primaryKey: false },
  ],
  indexes: [],
};

const props = {
  schema: SCHEMA,
  error: null,
  entity: "User",
  width: 320,
  onResize: () => {},
};

test("the expanded inspector shows the schema and a way to collapse it", () => {
  render(<SchemaInspector {...props} collapsed={false} onToggle={() => {}} />);

  expect(screen.getByText("handle")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /collapse schema/i })).toBeInTheDocument();
});

/// Collapsed is the state the spec expects a reader to keep the inspector in,
/// so the way back has to be obvious. A bare sliver with no accessible name is
/// a dead end — the control keeps a name and the rail keeps a visible label.
test("the collapsed rail is still a labelled control that can reopen", () => {
  const toggles: number[] = [];
  render(
    <SchemaInspector {...props} collapsed onToggle={() => toggles.push(1)} />,
  );

  expect(screen.queryByText("handle")).not.toBeInTheDocument();
  const reopen = screen.getByRole("button", { name: /expand schema/i });
  expect(reopen).toHaveTextContent(/schema/i);

  fireEvent.click(reopen);
  expect(toggles).toHaveLength(1);
});

test("an error is shown inside the inspector, verbatim", () => {
  // `AppErrorDto` is exactly `{ kind, explanation }` — there is no `message`
  // field. `explanation` is the operator-facing prose and is rendered whole.
  const error = { kind: "backend", explanation: "E7: no such entity" };
  render(<SchemaInspector {...props} schema={null} error={error} collapsed={false} onToggle={() => {}} />);

  expect(screen.getByText(/E7: no such entity/)).toBeInTheDocument();
});

test("with no table selected the inspector says so rather than sitting blank", () => {
  render(
    <SchemaInspector {...props} schema={null} entity={null} collapsed={false} onToggle={() => {}} />,
  );

  expect(screen.getByText(/select a table/i)).toBeInTheDocument();
});

/// `Pane`'s drag handle lives on its trailing (right) edge, which for every
/// other pane is a real shared boundary — but the schema inspector is the
/// rightmost pane, so its trailing edge is the window's outer edge and the
/// boundary the user actually means to grab is this pane's *left* edge,
/// shared with the pane to its left. Left uncorrected, dragging the handle
/// rightward would widen the inspector — backwards, since that motion is
/// away from the shared boundary. This pins the corrected direction: moving
/// the handle right must shrink the inspector, and moving it left must grow
/// it. A sign error here would flip both assertions.
test("dragging the handle rightward shrinks the inspector, since the real boundary is on its left", () => {
  const widths: number[] = [];
  render(
    <SchemaInspector
      {...props}
      collapsed={false}
      onToggle={() => {}}
      onResize={(width) => widths.push(width)}
    />,
  );

  const handle = screen.getByRole("separator", { name: /resize schema/i });

  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 340 }); // dragged 40px rightward
  fireEvent.pointerUp(window);

  expect(widths[widths.length - 1]).toBe(280); // 320 - 40, not 320 + 40
});

test("dragging the handle leftward grows the inspector", () => {
  const widths: number[] = [];
  render(
    <SchemaInspector
      {...props}
      collapsed={false}
      onToggle={() => {}}
      onResize={(width) => widths.push(width)}
    />,
  );

  const handle = screen.getByRole("separator", { name: /resize schema/i });

  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 260 }); // dragged 40px leftward
  fireEvent.pointerUp(window);

  expect(widths[widths.length - 1]).toBe(360); // 320 + 40, not 320 - 40
});
