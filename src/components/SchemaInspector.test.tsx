import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

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

/// The inversion has to survive a *continuous* drag, not just one move. The two
/// tests above each fire a single `pointerMove`, which cannot see the hazard
/// here: `invertResize` computes `2 * width - proposed`, so it depends on
/// `width` and on `PaneHandle`'s captured `originWidth` staying in step.
///
/// They do stay in step, but only because `PaneHandle` registers its listener
/// once at `pointerdown` and that listener keeps a *stale* closure — both values
/// freeze together, so they cannot diverge. That makes an ordinary React
/// "improvement" to `PaneHandle` (keeping `onResize` fresh through a ref, so the
/// listener always calls the newest prop) silently break this pane: verified by
/// doing exactly that, after which a 20px-then-40px leftward drag widened the
/// inspector to 400 instead of 360 — accelerating away from the cursor.
///
/// So this test guards a coupling between two files that is invisible in either
/// one alone. A stateful host is required; with a fixed `width` prop the feedback
/// never happens and the test proves nothing.
test("a continuous drag tracks the cursor instead of accelerating away from it", () => {
  function Host() {
    const [width, setWidth] = useState(320);
    return (
      <>
        <span data-testid="schema-width">{width}</span>
        <SchemaInspector
          {...props}
          width={width}
          onResize={setWidth}
          collapsed={false}
          onToggle={() => {}}
        />
      </>
    );
  }

  render(<Host />);
  const handle = screen.getByRole("separator", { name: /resize schema/i });

  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 280 }); // 20px left of the origin
  expect(screen.getByTestId("schema-width")).toHaveTextContent("340");

  // 40px left of the *origin*, not a further 40px from the last position.
  fireEvent.pointerMove(window, { clientX: 260 });
  expect(screen.getByTestId("schema-width")).toHaveTextContent("360");
});
