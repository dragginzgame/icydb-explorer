import { act, renderHook } from "@testing-library/react";

import { PANE_BOUNDS, PANE_STORAGE_KEY, clampWidth, readLayout, usePaneLayout } from "./usePaneLayout";

// jsdom defaults `window.innerWidth` to 1024, which is narrow enough to
// collide with fixtures elsewhere in this file that were never written with
// window-awareness in mind (e.g. the DEFAULT_LAYOUT widths plus a
// maxed-out pane already total 1080px). Resetting to a generously wide value
// before every test keeps those pre-existing cases exercising only what they
// were written to exercise, regardless of test order; the tests below that
// care about a specific window size set `window.innerWidth` explicitly.
beforeEach(() => {
  window.innerWidth = 1920;
});

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

/// Two setters called in the same tick (a resize immediately followed by a
/// schema toggle, say) must each land, not just the last one. Both calls are
/// inside ONE `act` on purpose: two separate `act` blocks would each flush a
/// render before the next call runs, so the second setter would already see
/// the first's result even with a captured-snapshot implementation — the
/// test would pass against broken code and prove nothing. Only forcing both
/// calls into the same batch/tick exercises the stale-closure hazard.
test("two setters invoked in the same tick both take effect, in state and in storage", () => {
  localStorage.removeItem(PANE_STORAGE_KEY);
  const { result } = renderHook(() => usePaneLayout());

  act(() => {
    result.current.setWidth("fleet", 300);
    result.current.toggleSchema();
  });

  expect(result.current.layout.widths.fleet).toBe(300);
  expect(result.current.layout.schemaCollapsed).toBe(true);

  const persisted = JSON.parse(localStorage.getItem(PANE_STORAGE_KEY)!);
  expect(persisted.widths.fleet).toBe(300);
  expect(persisted.schemaCollapsed).toBe(true);
});

/// Persisting happens in an effect, not inside the state updater, and this is
/// what pins that. A React state updater must be pure: StrictMode
/// double-invokes it, and — the reason that matters beyond a duplicate write —
/// React may discard a render it has already begun, which from inside the
/// updater would leave storage holding a layout the user never saw applied.
/// Writing after commit also coalesces a burst of setters into one write.
///
/// Note this asserts the coalescing, not the StrictMode behaviour: these tests
/// render without StrictMode, so a double-invoked updater would not show up
/// here at all.
test("a burst of same-tick updates writes once, not once per setter", () => {
  localStorage.removeItem(PANE_STORAGE_KEY);
  // Spy on the prototype, not the instance: jsdom's `localStorage` is
  // Proxy-based, so assigning an own `setItem` does not shadow the prototype
  // method and the spy silently never fires — which reads exactly like "no
  // writes happened" and would make this test pass against a broken effect.
  const spy = vi.spyOn(Storage.prototype, "setItem");
  const writesOfOurs = () =>
    spy.mock.calls.filter(([key]) => key === PANE_STORAGE_KEY).map(([, value]) => value as string);

  try {
    const { result } = renderHook(() => usePaneLayout());
    const afterMount = writesOfOurs().length;

    act(() => {
      result.current.setWidth("fleet", 300);
      result.current.setWidth("tables", 320);
      result.current.toggleSchema();
    });

    const writes = writesOfOurs();
    expect(writes.length - afterMount).toBe(1);
    const persisted = JSON.parse(writes[writes.length - 1]);
    // The single write still carries every change, so coalescing loses nothing.
    expect(persisted.widths.fleet).toBe(300);
    expect(persisted.widths.tables).toBe(320);
    expect(persisted.schemaCollapsed).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

/// Every one of these widths is individually legal, and together they exceed the
/// window: 480 + 480 + 560 = 1520 on a 1280px window leaves the flex-1 Rows pane
/// at 0px and pushes the Schema pane's own collapse control and drag handle off
/// screen — persisted, so it survives a relaunch, and unrecoverable except by
/// dragging the other two panes left first.
test("stored widths that collectively exceed the window are repaired", () => {
  window.innerWidth = 1280;
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths: { fleet: 480, tables: 480, schema: 560 }, schemaCollapsed: false, sqlExpanded: false }),
  );

  const layout = readLayout();
  const fixed = layout.widths.fleet + layout.widths.tables + layout.widths.schema;

  expect(fixed).toBeLessThan(window.innerWidth);
  // And the rows pane keeps a usable share, not one pixel.
  expect(window.innerWidth - fixed).toBeGreaterThanOrEqual(320);
});

test("widths that already fit are left exactly as stored", () => {
  window.innerWidth = 1600;
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths: { fleet: 240, tables: 280, schema: 320 }, schemaCollapsed: false, sqlExpanded: false }),
  );

  expect(readLayout().widths).toEqual({ fleet: 240, tables: 280, schema: 320 });
});
