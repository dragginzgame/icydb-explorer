import { useCallback, useEffect, useState } from "react";

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

const DEFAULT_LAYOUT: PaneLayout = {
  widths: { fleet: 240, tables: 280, schema: 320 },
  schemaCollapsed: false,
  sqlExpanded: false,
};

export function clampWidth(pane: PaneName, width: number): number {
  const [min, max] = PANE_BOUNDS[pane];
  if (!Number.isFinite(width)) return DEFAULT_LAYOUT.widths[pane];

  return Math.min(max, Math.max(min, Math.round(width)));
}

/** Reads the stored layout, repairing anything unusable. Never throws: a bad
 *  stored value must not be able to stop the app from starting, because a user
 *  who cannot start the app cannot clear the bad value either. */
export function readLayout(): PaneLayout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PANE_STORAGE_KEY);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (raw === null) return DEFAULT_LAYOUT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_LAYOUT;

  const source = parsed as Partial<PaneLayout>;
  const widths = { ...DEFAULT_LAYOUT.widths };
  for (const pane of Object.keys(PANE_BOUNDS) as PaneName[]) {
    const candidate = source.widths?.[pane];
    widths[pane] = typeof candidate === "number" ? clampWidth(pane, candidate) : widths[pane];
  }

  return {
    widths,
    schemaCollapsed: source.schemaCollapsed === true,
    sqlExpanded: source.sqlExpanded === true,
  };
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
  useEffect(() => persist(layout), [layout]);

  return {
    layout,
    setWidth: useCallback(
      (pane: PaneName, width: number) =>
        update((prev) => ({ ...prev, widths: { ...prev.widths, [pane]: clampWidth(pane, width) } })),
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
