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

  // Without these two the test is vacuous. If the drag never started at all,
  // `afterRelease` is 0 and the final assertion trivially holds — it cannot
  // tell "the drag stopped on release" from "the drag never ran", which is
  // exactly how it passed when the listeners were mis-bound to the handle.
  expect(afterRelease).toBeGreaterThan(0);
  expect(widths[afterRelease - 1]).toBe(260);

  fireEvent.pointerMove(window, { clientX: 500 });
  expect(widths).toHaveLength(afterRelease);
});

/// `window` listeners outlive the React tree that registered them. If the pane
/// unmounts mid-drag (the user switches projects before releasing), the drag
/// must not keep calling a dead instance's `onResize` until some later,
/// possibly-never `pointerup` arrives.
test("unmounting mid-drag stops the drag from continuing to resize", () => {
  const widths: number[] = [];
  const { unmount } = render(
    <Pane title="Fleet" width={240} onResize={(width) => widths.push(width)}>
      <p>content</p>
    </Pane>,
  );

  const handle = screen.getByRole("separator", { name: /resize fleet/i });
  fireEvent.pointerDown(handle, { clientX: 300 });
  fireEvent.pointerMove(window, { clientX: 320 });
  const beforeUnmount = widths.length;
  expect(beforeUnmount).toBeGreaterThan(0);

  unmount();

  fireEvent.pointerMove(window, { clientX: 500 });
  fireEvent.pointerUp(window);
  expect(widths).toHaveLength(beforeUnmount);
});

/// A live drag whose `pointerup` never arrived (dropped by the OS, or lost to
/// a focus change) must not leave its listener pair registered forever: a
/// second drag beginning afterward has to replace it, not stack alongside it,
/// or a single pointer move would report two resizes for one gesture.
test("starting a new drag replaces a still-live one rather than stacking", () => {
  const widths: number[] = [];
  render(
    <Pane title="Fleet" width={240} onResize={(width) => widths.push(width)}>
      <p>content</p>
    </Pane>,
  );

  const handle = screen.getByRole("separator", { name: /resize fleet/i });
  fireEvent.pointerDown(handle, { clientX: 300 }); // first drag begins, never released
  fireEvent.pointerDown(handle, { clientX: 300 }); // a second begins before the first ends

  fireEvent.pointerMove(window, { clientX: 340 });

  expect(widths).toHaveLength(1);
});
