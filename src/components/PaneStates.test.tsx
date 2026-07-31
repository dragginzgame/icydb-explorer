import { render, screen } from "@testing-library/react";

import { PaneEmpty } from "./PaneStates";

test("an empty pane names the space and explains it", () => {
  render(<PaneEmpty title="No rows">This table has no rows yet.</PaneEmpty>);

  expect(screen.getByText("No rows")).toBeInTheDocument();
  expect(screen.getByText(/no rows yet/i)).toBeInTheDocument();
});

/// An empty state must not be mistakable for a loading one — that ambiguity is
/// exactly what the phase set out to remove.
test("an empty pane carries no skeleton", () => {
  render(<PaneEmpty title="No rows">This table has no rows yet.</PaneEmpty>);

  expect(document.querySelectorAll('[data-skeleton="true"]')).toHaveLength(0);
});

/// `action` is only ever passed where a real action exists — nothing in this
/// phase's four call sites has one yet — but the slot itself has to actually
/// work, or a future caller would discover that the hard way.
test("an action renders when one is supplied", () => {
  render(
    <PaneEmpty title="No table selected" action={<button type="button">Open Tables</button>}>
      Choose a table from the list.
    </PaneEmpty>,
  );

  expect(screen.getByRole("button", { name: /open tables/i })).toBeInTheDocument();
});

/// No action means no action — this must not render a stray empty wrapper
/// that assistive tech or a snapshot could mistake for a control.
test("no action means nothing extra renders", () => {
  render(<PaneEmpty title="No rows">This table has no rows yet.</PaneEmpty>);

  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
