import { act, renderHook } from "@testing-library/react";

// The shipped window size is part of this module's contract — `DEFAULT_LAYOUT`
// is only a sane default if the window it opens in can hold it — so it is read
// here rather than trusted. `?raw` for the same reason `tokens.test.ts` uses it:
// no `@types/node`, and the path resolves relative to this file.
import tauriConfigRaw from "../../src-tauri/tauri.conf.json?raw";

import {
  DEFAULT_LAYOUT,
  PANE_BOUNDS,
  PANE_STORAGE_KEY,
  ROWS_MIN_WIDTH,
  SCHEMA_RAIL_WIDTH,
  clampWidth,
  readLayout,
  usePaneLayout,
} from "./usePaneLayout";

const sumOf = (widths: Record<"fleet" | "tables" | "schema", number>) =>
  widths.fleet + widths.tables + widths.schema;

// jsdom defaults `window.innerWidth` to 1024, which is narrow enough to
// collide with fixtures elsewhere in this file that were never written with
// window-awareness in mind (e.g. the DEFAULT_LAYOUT widths plus a
// maxed-out pane already total 1080px). Resetting to a generously wide value
// before every test keeps those pre-existing cases exercising only what they
// were written to exercise, regardless of test order; the tests below that
// care about a specific window size set `window.innerWidth` explicitly.
beforeEach(() => {
  window.innerWidth = 1920;
  // Also clear the stored layout. Every test that needs a specific one sets it,
  // and vitest shares one jsdom per file — without this, a test added later
  // inherits whichever layout the previous test happened to leave behind, and
  // passes or fails on declaration order rather than on its own subject.
  localStorage.removeItem(PANE_STORAGE_KEY);
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
    // Asserted against the actual default, not against `clampWidth` of whatever
    // came back — that form is an idempotence check that holds for ANY in-bounds
    // number, so a defaults mixup handing fleet the schema pane's 320 would sit
    // inside fleet's [160, 480] bounds and pass.
    expect(layout.widths.fleet).toBe(240);
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

/// The shipped window shipped at 800x600, and `DEFAULT_LAYOUT` is 240 + 280 + 320
/// = 840px of fixed panes before the Rows pane asks for anything — so the default
/// window could not fit its own default layout, and every user's first launch was
/// the degenerate case. Asserted against the constants rather than against 1280 so
/// a future widening of any pane's default has to widen the window with it.
test("the shipped default window can hold the default layout with Rows still usable", () => {
  const { width, height } = JSON.parse(tauriConfigRaw).app.windows[0];
  expect(width).toBeGreaterThanOrEqual(sumOf(DEFAULT_LAYOUT.widths) + ROWS_MIN_WIDTH);

  // The end that matters: on the shipped window a first launch renders the
  // default layout untouched, rather than a repaired one.
  window.innerWidth = width;
  expect(readLayout().widths).toEqual(DEFAULT_LAYOUT.widths);

  // Nothing in this codebase pins the vertical stack the way `ROWS_MIN_WIDTH`
  // pins the horizontal one, so this is a regression floor rather than a
  // derivation: the shell stacks a header, a banner region capped at `40vh`, the
  // pane row, and an SQL bar at `basis-1/3`, which leaves the pane row roughly a
  // quarter of the window. At the shipped 800 that quarter is a legible grid; at
  // the old 600 it was about four rows.
  expect(height).toBeGreaterThanOrEqual(720);
});

/// `readLayout` has five ways out and four of them used to hand back
/// `DEFAULT_LAYOUT` raw, skipping the window fit that the fifth applied. So a
/// first launch, or any corrupt value, delivered 840px of fixed panes on any
/// window at all — and the four paths did not even agree with each other.
test("every fallback path is fitted to the window, not only the parsed one", () => {
  // The app's own default window until this round, and too narrow for
  // `DEFAULT_LAYOUT`. The panes end at their minima and Rows gets 260 rather
  // than the full `ROWS_MIN_WIDTH`: at 800px the minima alone (160 + 160 + 220 =
  // 540) already exceed the 480px budget, so this is as close as the repair can
  // get. The point is that all five paths get there.
  window.innerWidth = 800;
  const fitted = { fleet: 160, tables: 160, schema: 220 };

  // No stored value at all: a first launch.
  expect(readLayout().widths).toEqual(fitted);

  // Unparseable JSON, `null`, a non-object, and a parsed object carrying no
  // usable widths. All four fall back to `DEFAULT_LAYOUT`'s widths, and they
  // must not disagree about what those become: at this window `"{{{"` returned
  // 240/280/320 while `'{"widths":{}}'` — one branch further down, past the fit
  // — returned 160/160/220 from the identical starting numbers.
  for (const raw of ["{{{", "null", "[]", '{"widths":{}}']) {
    localStorage.setItem(PANE_STORAGE_KEY, raw);
    expect(readLayout().widths).toEqual(fitted);
  }

  // And the path where `localStorage` itself throws, as it does in a locked-down
  // private mode.
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("access denied");
  });
  try {
    expect(readLayout().widths).toEqual(fitted);
  } finally {
    spy.mockRestore();
  }
});

/// `Number.isFinite(0)` is `true`, so a window that has not been laid out yet
/// slipped straight through the guard written to catch exactly that: a budget of
/// `max(0, 0 - 320) === 0` drove every pane to its minimum. Zero is not a narrow
/// window, it is the absence of a measurement.
test("an unmeasured window does not drive every pane to its minimum", () => {
  window.innerWidth = 0;
  const widths = { fleet: 480, tables: 480, schema: 560 };
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths, schemaCollapsed: false, sqlExpanded: false }),
  );

  expect(readLayout().widths).toEqual(widths);

  localStorage.removeItem(PANE_STORAGE_KEY);
  expect(readLayout().widths).toEqual(DEFAULT_LAYOUT.widths);
});

/// Collapsed, `SchemaInspector` renders a `SCHEMA_RAIL_WIDTH` rail and
/// `widths.schema` is a remembered preference that occupies nothing. Summing it
/// anyway made the fit fire on a layout with hundreds of pixels to spare and
/// rewrite panes the user had deliberately arranged — the very outcome
/// `fitWidthsToWindow`'s own doc comment claims it avoids.
test("a collapsed schema pane is measured as its rail, so a layout that fits is left alone", () => {
  window.innerWidth = 1400;
  const widths = { fleet: 480, tables: 480, schema: 560 };
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths, schemaCollapsed: true, sqlExpanded: false }),
  );

  // Real occupancy is 480 + 480 + 32 = 992, leaving Rows 408 — healthy.
  expect(widths.fleet + widths.tables + SCHEMA_RAIL_WIDTH).toBeLessThanOrEqual(
    1400 - ROWS_MIN_WIDTH,
  );
  expect(readLayout().widths).toEqual(widths);
});

/// The same blind spot on the drag path, where it shows up as dead handles: with
/// the inspector shut — the state the spec expects a reader to be in most of the
/// time — `setWidth` subtracted a remembered `widths.schema` that nothing
/// renders, made `maxAvailable` negative, and returned the pane's minimum
/// wherever the pointer went.
test("with the inspector collapsed, a narrow window still leaves the handles room", () => {
  window.innerWidth = 800;
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({
      widths: { fleet: 160, tables: 160, schema: 220 },
      schemaCollapsed: true,
      sqlExpanded: false,
    }),
  );
  const { result } = renderHook(() => usePaneLayout());

  // Rows needs 320 and the other two panes plus the rail occupy 192, so 288px is
  // genuinely available to Canisters — not the 160 a schema-blind sum reports.
  act(() => result.current.setWidth("fleet", 400));
  expect(result.current.layout.widths.fleet).toBe(800 - ROWS_MIN_WIDTH - 160 - SCHEMA_RAIL_WIDTH);
});

/// Window pressure may refuse to let a pane GROW; it must never shove a pane
/// below where it already sits. When `maxAvailable` went negative,
/// `clampWidth`'s effective max collapsed onto the pane's minimum and the handle
/// returned that one constant for every pointer position — the pane snapped to
/// its floor on the first pixel of movement, and from there the user could
/// neither grow nor shrink it. Shrinking has to keep working precisely when room
/// is scarce, because it is the move that resolves the scarcity.
test("a window too narrow for the current layout caps growth but still allows shrinking", () => {
  // Loaded on a window that fits, so the widths reach state unrepaired, then the
  // window narrows with no relaunch to re-read them — the case `setWidth`'s
  // live-window check exists for.
  window.innerWidth = 1600;
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({
      widths: { fleet: 480, tables: 480, schema: 560 },
      schemaCollapsed: false,
      sqlExpanded: false,
    }),
  );
  const { result } = renderHook(() => usePaneLayout());
  expect(result.current.layout.widths.fleet).toBe(480);

  window.innerWidth = 900;

  // No room to grow into: held where it is, not thrown to 160.
  act(() => result.current.setWidth("fleet", 520));
  expect(result.current.layout.widths.fleet).toBe(480);

  // And the drag that helps still lands, at the width asked for.
  act(() => result.current.setWidth("fleet", 400));
  expect(result.current.layout.widths.fleet).toBe(400);
  act(() => result.current.setWidth("fleet", 300));
  expect(result.current.layout.widths.fleet).toBe(300);
});

/// The fit is a presentation fix for the window in front of the user; storage
/// holds a preference. Writing the fit back made the two a one-way ratchet —
/// widths only ever shrank, the shrink was persisted before the user did
/// anything at all, and nothing restored them — so one launch on a laptop screen
/// permanently destroyed a layout built on an external display.
test("a narrow launch renders a fitted layout without overwriting the stored one", () => {
  window.innerWidth = 900;
  const widths = { fleet: 480, tables: 480, schema: 560 };
  localStorage.setItem(
    PANE_STORAGE_KEY,
    JSON.stringify({ widths, schemaCollapsed: false, sqlExpanded: false }),
  );

  const { result, unmount } = renderHook(() => usePaneLayout());

  // What renders is fitted: 1520px of fixed panes cannot share 900px with a
  // usable Rows pane.
  expect(sumOf(result.current.layout.widths)).toBeLessThanOrEqual(900 - ROWS_MIN_WIDTH);
  // What is stored is the user's own arrangement, untouched.
  expect(JSON.parse(localStorage.getItem(PANE_STORAGE_KEY)!).widths).toEqual(widths);
  unmount();

  // So the next launch on the window it was built for gets it back.
  window.innerWidth = 1920;
  expect(readLayout().widths).toEqual(widths);
});
