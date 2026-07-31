import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

import { SCHEMA_RAIL_WIDTH } from "../layout/usePaneLayout";
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
  const collapseControl = screen.getByRole("button", { name: /collapse schema/i });
  expect(collapseControl).toBeInTheDocument();
  // Expanded means the disclosure is open. `aria-expanded` on this control
  // is a bare JSX attribute (`aria-expanded` with no value, i.e. `={true}`),
  // easy to swap to `{false}` by accident with no visible symptom — assert
  // it directly rather than trusting the shorthand.
  expect(collapseControl).toHaveAttribute("aria-expanded", "true");
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
  // Collapsed means the disclosure is closed. Same rationale as the expanded
  // control's assertion above: both values are correct as shipped and not
  // contradictory (JSX's bare `aria-expanded` reads as `{true}`), but a swap
  // of either one would misannounce state to assistive tech silently.
  expect(reopen).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(reopen);
  expect(toggles).toHaveLength(1);
});

/// Collapsed, the inspector returns the rail and never reaches its error branch
/// — and `collapsed` persists across launches. So a reader who keeps it shut and
/// selects a table on a canister with introspection disabled used to get silence
/// in every pane: the failure had nowhere to land once the schema left the
/// always-visible Tables aside. The rail has to say something.
///
/// Asserted on the accessible NAME, not just a coloured glyph: the name is the
/// only part a screen reader gets, and a 32px rail is not somewhere a visual
/// marker alone will be noticed.
test("the collapsed rail announces a schema error rather than staying silent", () => {
  const error = { kind: "backend", explanation: "E7: introspection is disabled" };
  render(
    <SchemaInspector {...props} schema={null} error={error} collapsed onToggle={() => {}} />,
  );

  const rail = screen.getByRole("button", { name: /expand schema/i });
  expect(rail).toHaveAccessibleName(/failed to load/i);
  // Visible as well as announced.
  expect(rail).toHaveTextContent("!");
});

/// `usePaneLayout` subtracts this exact number from the window to decide how much
/// room is left for the other panes — collapsed, `widths.schema` occupies nothing
/// and the rail occupies this. So the rail's width has to come FROM that constant,
/// not from a `w-8` that happens to agree with it: a restyle that moved one and
/// not the other would surface as panes silently refusing to resize, nowhere near
/// this file.
test("the collapsed rail is sized from the constant the layout arithmetic uses", () => {
  render(<SchemaInspector {...props} collapsed onToggle={() => {}} />);

  const rail = screen.getByRole("button", { name: /expand schema/i });
  expect(rail.style.width).toBe(`${SCHEMA_RAIL_WIDTH}px`);
});

test("a healthy collapsed rail carries no failure marker", () => {
  render(<SchemaInspector {...props} collapsed onToggle={() => {}} />);

  const rail = screen.getByRole("button", { name: /expand schema/i });
  expect(rail).toHaveAccessibleName("Expand schema");
  expect(rail).not.toHaveTextContent("!");
});

test("an error is shown inside the inspector, verbatim", () => {
  // `AppErrorDto` is exactly `{ kind, explanation }` — there is no `message`
  // field. `explanation` is the operator-facing prose and is rendered whole.
  const error = { kind: "backend", explanation: "E7: no such entity" };
  render(<SchemaInspector {...props} schema={null} error={error} collapsed={false} onToggle={() => {}} />);

  expect(screen.getByText(/E7: no such entity/)).toBeInTheDocument();
});

/// The brief's own error test (above) pairs `error` with `schema: null`, which
/// never exercises the `!error &&` guard in front of `SchemaPanel` — a stale
/// schema sitting next to a fresh error would pass that test just as well.
/// The real scenario this guards: the user switches entities, the new
/// schema's describe fails, and the previous entity's schema must not linger
/// beside the failure.
test("an error takes precedence over a stale schema, rather than showing both", () => {
  const error = { kind: "backend", explanation: "E7: no such entity" };
  render(
    <SchemaInspector {...props} schema={SCHEMA} error={error} collapsed={false} onToggle={() => {}} />,
  );

  expect(screen.getByText(/E7: no such entity/)).toBeInTheDocument();
  expect(screen.queryByText("handle")).not.toBeInTheDocument();
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

/// A drag has to track the cursor across several moves, not just one: each
/// move reports a width relative to where the drag *started*, not relative to
/// the previous move, so this needs a stateful host that actually re-renders
/// `SchemaInspector` with each new `width` — a fixed `width` prop would let a
/// per-move accumulation bug pass unnoticed.
///
/// This also used to be the test that pinned a real hazard: with the earlier
/// implementation (negating the reported width inside `SchemaInspector`
/// itself, via `2 * width - proposed`), correctness depended on `width` and
/// `PaneHandle`'s captured `originWidth` staying in step across the whole
/// drag — which only held because `PaneHandle` rebuilt its listener once at
/// `pointerdown` and kept a stale closure. Making `PaneHandle` keep `onResize`
/// fresh through a ref (an entirely reasonable-looking change on its own)
/// broke that: a 20px-then-40px leftward drag widened the inspector to 400
/// instead of 360, accelerating away from the cursor. Now that `Pane` computes
/// the sign itself, next to `originWidth`, in the same place and at the same
/// time, that coupling is gone — this test stays green under the freshness
/// change, and is kept here as a plain multi-move correctness check.
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
