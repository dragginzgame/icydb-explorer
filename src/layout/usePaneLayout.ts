import { useCallback, useState } from "react";

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

  const update = useCallback((next: PaneLayout) => {
    setLayout(next);
    persist(next);
  }, []);

  return {
    layout,
    setWidth: useCallback(
      (pane: PaneName, width: number) =>
        update({ ...layout, widths: { ...layout.widths, [pane]: clampWidth(pane, width) } }),
      [layout, update],
    ),
    toggleSchema: useCallback(
      () => update({ ...layout, schemaCollapsed: !layout.schemaCollapsed }),
      [layout, update],
    ),
    setSqlExpanded: useCallback(
      (expanded: boolean) => update({ ...layout, sqlExpanded: expanded }),
      [layout, update],
    ),
  };
}
