import { fireEvent, render, screen } from "@testing-library/react";

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

test("dragging the handle reports the new width", () => {
  const widths: number[] = [];
  render(
    <Pane title="Fleet" width={240} onResize={(width) => widths.push(width)}>
      <p>content</p>
    </Pane>,
  );

  const handle = screen.getByRole("separator", { name: /resize fleet/i });
  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 340 });
  fireEvent.pointerUp(window);

  expect(widths[widths.length - 1]).toBe(280);
});

/// The listeners live on `window`, so a drag that ends outside the handle still
/// ends. If they were on the handle, releasing the pointer over another pane
/// would leave the drag live and the pane would follow the cursor forever.
test("a drag stops affecting the pane once the pointer is released", () => {
  const widths: number[] = [];
  render(
    <Pane title="Fleet" width={240} onResize={(width) => widths.push(width)}>
      <p>content</p>
    </Pane>,
  );

  const handle = screen.getByRole("separator", { name: /resize fleet/i });
  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 320 });
  fireEvent.pointerUp(window);
  const afterRelease = widths.length;

  fireEvent.pointerMove(window, { clientX: 500 });
  expect(widths).toHaveLength(afterRelease);
});
