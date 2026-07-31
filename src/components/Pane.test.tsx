import { render, screen } from "@testing-library/react";

import { Pane } from "./Pane";

test("a pane has exactly one scroll container, and its content lives inside it", () => {
  render(
    <Pane title="Rows">
      <p>content</p>
    </Pane>,
  );

  const scrollers = document.querySelectorAll(".overflow-auto, .overflow-y-auto, .overflow-scroll");
  expect(scrollers).toHaveLength(1);
  expect(scrollers[0].textContent).toContain("content");
  // The title sits outside the scroll region, so it does not scroll away.
  expect(scrollers[0].textContent).not.toContain("Rows");
  expect(screen.getByText("Rows")).toBeInTheDocument();
});
