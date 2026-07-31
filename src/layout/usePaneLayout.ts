import { useCallback, useEffect, useRef, useState } from "react";

export const PANE_STORAGE_KEY = "icydb-explorer.panes";

/** Min and max width per pane, in CSS pixels. A pane narrower than its min is
 *  unreadable rather than compact; wider than its max it starves the rows pane,
 *  which is the one the user came for. */
export const PANE_BOUNDS = {
  fleet: [160, 480],
  tables: [160, 480],
  schema: [220, 560],
} as const;

export type PaneName = keyof typeof PANE_BOUNDS;

export type PaneLayout = {
  widths: Record<PaneName, number>;
  schemaCollapsed: boolean;
  sqlExpanded: boolean;
};

/** Exported so the shipped window size can be checked against it rather than
 *  against a second copy of the same three numbers. */
export const DEFAULT_LAYOUT: PaneLayout = {
  widths: { fleet: 240, tables: 280, schema: 320 },
  schemaCollapsed: false,
  sqlExpanded: false,
};

/** The three fixed panes' individual maxima (see `PANE_BOUNDS`) sum to 1520px,
 *  but the Rows pane is `flex-1` and gets whatever is left of the window —
 *  it is the pane the user came for, so it must always keep a usable share
 *  rather than being squeezed to nothing. 320px is roughly the narrowest a
 *  results grid stays legible (a handful of columns plus a scrollbar). */
export const ROWS_MIN_WIDTH = 320;

/** The width the Schema pane actually occupies while collapsed: `SchemaInspector`
 *  renders a narrow labelled rail instead of the pane, so `widths.schema` is a
 *  remembered preference in that state, not a claim on the row. Every place that
 *  reasons about how much of the window the fixed panes consume has to use this
 *  instead — which is why it lives here, next to `ROWS_MIN_WIDTH`, and is what
 *  the rail itself is sized from rather than a `w-8` that could drift from it. */
export const SCHEMA_RAIL_WIDTH = 32;

/** The current window width, or +Infinity if none is usable (so callers that
 *  divide the window's fixed-pane budget never spuriously trigger).
 *
 *  Positive, not merely finite: `Number.isFinite(0)` is `true`, and 0 is exactly
 *  the "not laid out yet" reading this guard exists to reject. Letting it through
 *  makes the fixed-pane budget `max(0, 0 - ROWS_MIN_WIDTH) === 0`, which drives
 *  every pane to its minimum on a window that was never measured. */
function currentWindowWidth(): number {
  return typeof window !== "undefined" && Number.isFinite(window.innerWidth) && window.innerWidth > 0
    ? window.innerWidth
    : Number.POSITIVE_INFINITY;
}

/** `maxAvailable`, when given, additionally caps the pane at whatever room is
 *  left in the window for it specifically — but never below the pane's own
 *  `PANE_BOUNDS` minimum, since a pane narrower than that is unreadable and no
 *  amount of window pressure makes that the better trade. */
export function clampWidth(pane: PaneName, width: number, maxAvailable?: number): number {
  const [min, max] = PANE_BOUNDS[pane];
  if (!Number.isFinite(width)) return DEFAULT_LAYOUT.widths[pane];

  const effectiveMax = maxAvailable === undefined ? max : Math.max(min, Math.min(max, maxAvailable));
  return Math.min(effectiveMax, Math.max(min, Math.round(width)));
}

/** Repairs a set of already bounds-legal widths that collectively leave the
 *  Rows pane no room: every value can be individually legal per
 *  `PANE_BOUNDS` (480 + 480 + 560 = 1520) and still starve a narrower window,
 *  pushing panes' own controls off-screen. This only steps in once that's
 *  actually about to happen — once the fixed panes would consume the entire
 *  window (Rows at or below 0px) — not merely whenever Rows would end up
 *  smaller than `ROWS_MIN_WIDTH`. That distinction matters because this runs
 *  on every mount: a layout that is tight but still positive is one the user
 *  arrived at deliberately on whatever window they had, and silently
 *  reshaping it on every read (even by a few px) would be as wrong as never
 *  repairing the genuinely broken case. Once triggered, the repair aims for
 *  the full `ROWS_MIN_WIDTH`, not just barely positive, so the fix doesn't
 *  immediately teeter on the same edge again.
 *
 *  The shrink is distributed across the panes in proportion to how much slack
 *  each has above its own minimum, so a pane already near its floor gives up
 *  less than one still sitting at its maximum.
 *
 *  `schemaCollapsed` is not a detail: while collapsed the Schema pane occupies
 *  `SCHEMA_RAIL_WIDTH`, not `widths.schema`, and shrinking `widths.schema` frees
 *  no room at all. Summing it unconditionally produced both halves of the same
 *  mistake — a repair firing on a layout that fits perfectly well (1400px window,
 *  collapsed, 480/480/560: real occupancy 992, Rows at 408), and the reshaping
 *  the paragraph above says this avoids. Collapsed, the pane is left out of both
 *  the occupancy sum and the set that gives up slack; the rail is added instead. */
function fitWidthsToWindow(
  widths: Record<PaneName, number>,
  schemaCollapsed: boolean,
): Record<PaneName, number> {
  const windowWidth = currentWindowWidth();
  const panes = (Object.keys(PANE_BOUNDS) as PaneName[]).filter(
    (pane) => !(pane === "schema" && schemaCollapsed),
  );
  const total =
    panes.reduce((sum, pane) => sum + widths[pane], 0) + (schemaCollapsed ? SCHEMA_RAIL_WIDTH : 0);
  if (total < windowWidth) return widths;

  const budget = Math.max(0, windowWidth - ROWS_MIN_WIDTH);
  const excess = total - budget;
  const slack = panes.map((pane) => Math.max(0, widths[pane] - PANE_BOUNDS[pane][0]));
  const totalSlack = slack.reduce((sum, s) => sum + s, 0);
  if (excess <= 0 || totalSlack <= 0) return widths;

  // Floor (not round) each reduced width: the exact reductions sum to
  // precisely `excess`, so flooring every pane only ever removes a little
  // more than planned, which keeps the total safely at or under budget
  // instead of risking rounding drift pushing it back over.
  const scale = Math.min(1, excess / totalSlack);
  const next = { ...widths };
  panes.forEach((pane, i) => {
    next[pane] = Math.max(PANE_BOUNDS[pane][0], Math.floor(widths[pane] - slack[i] * scale));
  });
  return next;
}

/** A layout with its widths fitted to the current window. Every path out of
 *  `readLayout` goes through this, `DEFAULT_LAYOUT` included: the default sums to
 *  840px of fixed panes, so a first launch — or any corrupt stored value, which
 *  lands on the same default — is just as capable of overflowing a narrow window
 *  as a stored layout is. Four of the five paths used to return the default raw,
 *  which is why an 800px window turned `"{{{"` into 240/280/320 while
 *  `'{"widths":{}}'` (one branch further down, past the repair) became
 *  160/160/220 from the identical starting widths. */
function fittedToWindow(layout: PaneLayout): PaneLayout {
  return { ...layout, widths: fitWidthsToWindow(layout.widths, layout.schemaCollapsed) };
}

/** Reads the stored layout, repairing anything unusable. Never throws: a bad
 *  stored value must not be able to stop the app from starting, because a user
 *  who cannot start the app cannot clear the bad value either. */
export function readLayout(): PaneLayout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PANE_STORAGE_KEY);
  } catch {
    return fittedToWindow(DEFAULT_LAYOUT);
  }
  if (raw === null) return fittedToWindow(DEFAULT_LAYOUT);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fittedToWindow(DEFAULT_LAYOUT);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fittedToWindow(DEFAULT_LAYOUT);
  }

  const source = parsed as Partial<PaneLayout>;
  const widths = { ...DEFAULT_LAYOUT.widths };
  for (const pane of Object.keys(PANE_BOUNDS) as PaneName[]) {
    const candidate = source.widths?.[pane];
    widths[pane] = typeof candidate === "number" ? clampWidth(pane, candidate) : widths[pane];
  }

  return fittedToWindow({
    widths,
    schemaCollapsed: source.schemaCollapsed === true,
    sqlExpanded: source.sqlExpanded === true,
  });
}

function persist(layout: PaneLayout): void {
  try {
    localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Private mode, or the quota is full. The layout still works for this
    // session; losing the preference is strictly better than crashing.
  }
}

export function usePaneLayout() {
  const [layout, setLayout] = useState<PaneLayout>(readLayout);

  // The layout exactly as it came out of `readLayout`, held by identity so the
  // effect below can tell "nobody has touched this yet" from "the user changed
  // something". `useState`'s initial object keeps its identity until a setter
  // runs, so this is a reference check, not a deep compare — and it survives
  // StrictMode's remount, where the same committed object is handed to the
  // effect a second time.
  const asRead = useRef(layout);

  // The functional-updater form is load-bearing: two setters called in the
  // same tick (e.g. a resize immediately followed by `toggleSchema()`) must
  // each derive from the *other's* result, not from `layout` as captured at
  // render time, or the second call silently discards the first — in React
  // state and in what gets persisted.
  const update = useCallback(
    (updater: (prev: PaneLayout) => PaneLayout) => setLayout(updater),
    [],
  );

  // Persisting belongs here, not inside the updater. A state updater must be
  // pure: StrictMode double-invokes it in development, and — the reason that
  // matters beyond a duplicate write — React is free to discard a render it
  // has already begun, which would leave `localStorage` holding a layout the
  // user never actually saw applied. Writing from an effect means only a
  // committed layout is ever stored, and it coalesces a burst of same-tick
  // updates into one write instead of one per setter.
  //
  // What is deliberately NOT written is the mount-time result of
  // `fitWidthsToWindow`. Storage holds a *preference* — widths the user dragged
  // to on whatever window they had. The repair is a presentation fix for the
  // window in front of them right now, and writing it back made the pair a
  // one-way ratchet: widths only ever shrink, the shrink was persisted before
  // the user did anything at all, and nothing ever restored them, so a single
  // launch on a laptop screen permanently destroyed a layout built on an
  // external display. Skipping that first write means a narrow launch renders
  // a fitted layout without overwriting the wider one, and the next launch on
  // the wide window finds it intact.
  //
  // The alternative — store the preference and render a separately-derived
  // fitted copy — was rejected: `PaneHandle` measures a drag from the width it
  // was rendered with, so a drag on an over-constrained window would write a
  // fitted-space number into a preference-space field, and the fitted copy
  // recomputed from it moves the *opposite* way to the pointer. Keeping one
  // layout means what the user sees is what they get; the accepted cost is that
  // a drag performed while the window is too narrow persists the fitted widths
  // of the panes the user did not touch, which is at least an outcome they can
  // see and undo.
  //
  // No `resize` listener, deliberately. `setWidth` already re-checks the live
  // window on every commit, so the interaction that matters is covered without
  // one; a listener would instead re-render (and, to be any use, re-fit) from
  // the live window width during a pointer drag, competing with the drag's own
  // stream of `setWidth` calls for the same field, and would reopen the
  // question this comment just closed of whether its output gets persisted.
  useEffect(() => {
    if (layout === asRead.current) return;
    persist(layout);
  }, [layout]);

  return {
    layout,
    // Window-aware on top of `clampWidth`'s own bounds: a value legal for this
    // pane in isolation can still, added to the *other* two panes' current
    // widths, leave Rows no room. This covers the case a mount-time repair
    // alone cannot — the window shrinking after the layout was already loaded,
    // with no relaunch in between to re-run `readLayout` — by re-checking
    // against the live window on every commit. When there's ample room,
    // `maxAvailable` exceeds the pane's own max and this is a no-op, identical
    // to the plain two-argument clamp.
    //
    // Two things keep that cap from turning into a dead drag handle.
    //
    // It is floored at the pane's *current* width, so window pressure can refuse
    // GROWTH but can never force a pane below where it already is. Without the
    // floor, a negative or tiny `maxAvailable` collapsed `clampWidth`'s effective
    // max onto the pane's minimum, and the handle then returned that same
    // constant wherever the pointer went — the pane snapped to its minimum on the
    // first pixel of movement and the user could neither grow nor shrink it from
    // there. Shrinking has to keep working precisely when room is scarce: it is
    // the move that resolves the scarcity.
    //
    // And `others` counts the collapsed Schema pane as its rail, not as
    // `widths.schema`, for the same reason `fitWidthsToWindow` does. With the
    // inspector shut — the state the spec expects a reader to be in most of the
    // time — summing a remembered 560px that nothing renders made
    // `maxAvailable` negative while hundreds of pixels were genuinely free, so
    // every handle in the window went dead at once.
    setWidth: useCallback(
      (pane: PaneName, width: number) =>
        update((prev) => {
          const others = (Object.keys(PANE_BOUNDS) as PaneName[])
            .filter((p) => p !== pane)
            .reduce(
              (sum, p) =>
                sum + (p === "schema" && prev.schemaCollapsed ? SCHEMA_RAIL_WIDTH : prev.widths[p]),
              0,
            );
          const maxAvailable = Math.max(
            prev.widths[pane],
            currentWindowWidth() - ROWS_MIN_WIDTH - others,
          );
          return { ...prev, widths: { ...prev.widths, [pane]: clampWidth(pane, width, maxAvailable) } };
        }),
      [update],
    ),
    toggleSchema: useCallback(
      () => update((prev) => ({ ...prev, schemaCollapsed: !prev.schemaCollapsed })),
      [update],
    ),
    setSqlExpanded: useCallback(
      (expanded: boolean) => update((prev) => ({ ...prev, sqlExpanded: expanded })),
      [update],
    ),
  };
}
