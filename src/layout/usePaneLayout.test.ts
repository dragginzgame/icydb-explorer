import { act, renderHook } from "@testing-library/react";

import { PANE_BOUNDS, PANE_STORAGE_KEY, clampWidth, readLayout, usePaneLayout } from "./usePaneLayout";

test("a stored layout round-trips", () => {
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths: { fleet: 200, tables: 300, schema: 320 }, schemaCollapsed: true, sqlExpanded: false }),
  );

  const layout = readLayout();
  expect(layout.widths.fleet).toBe(200);
  expect(layout.schemaCollapsed).toBe(true);
});

test("a width outside its bounds is clamped, not accepted", () => {
  expect(clampWidth("fleet", 10)).toBe(PANE_BOUNDS.fleet[0]);
  expect(clampWidth("fleet", 10_000)).toBe(PANE_BOUNDS.fleet[1]);
  expect(clampWidth("fleet", 240)).toBe(240);
});

/// A layout written by a future version — or hand-edited, or truncated by a
/// crash mid-write — must not take the app down on boot. Every branch falls
/// back to the default rather than throwing, because the alternative is an app
/// that cannot start and gives the user no way to clear the bad value.
test("a corrupt or partial stored layout falls back to the default", () => {
  for (const raw of ["{{{", "null", "[]", '{"widths":{"fleet":"wide"}}', '{"widths":{}}']) {
    localStorage.setItem(PANE_STORAGE_KEY, raw);
    const layout = readLayout();
    expect(layout.widths.fleet).toBe(clampWidth("fleet", layout.widths.fleet));
    expect(typeof layout.schemaCollapsed).toBe("boolean");
  }
});

/// `clampWidth` being correct in isolation says nothing about whether the hook
/// actually calls it: `setWidth` could forward a raw, unclamped value straight
/// into state and every test above would stay green. This is the one that
/// exercises the wiring, not just the pure function.
test("setWidth clamps a request that falls outside the pane's bounds", () => {
  localStorage.removeItem(PANE_STORAGE_KEY);
  const { result } = renderHook(() => usePaneLayout());

  act(() => result.current.setWidth("fleet", 10_000));
  expect(result.current.layout.widths.fleet).toBe(PANE_BOUNDS.fleet[1]);

  act(() => result.current.setWidth("fleet", 1));
  expect(result.current.layout.widths.fleet).toBe(PANE_BOUNDS.fleet[0]);
});
