# Phase 2b — Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three improvised panes into four real ones — Fleet, Tables, Rows, and Schema as a collapsible right inspector — with one scroll container each, draggable persisted boundaries, a collapsible SQL bar, and designed loading/empty/error states per pane.

**Architecture:** A new `Pane` component owns the header/scroll/handle structure so no pane invents its own, and `RowGrid` gives up the inner scroll container it currently owns (which is why the sticky header has never stuck). Pane widths live in one `usePaneLayout` hook persisted to `localStorage` beside the theme. The cell width cap becomes container-relative so collapsing the schema inspector actually buys un-elided identifiers rather than whitespace.

**Tech Stack:** React 19, Tailwind 4.3.3 (CSS-first `@theme`, native container queries), Vitest 4 + Testing Library, Tauri 2.

## Global Constraints

- **A literal colour outside `src/theme/tokens.css` is a defect.** No hex, `rgb(`, `hsl(`, `oklch(`, and no Tailwind built-in palette class (`bg-red-500`, `border-b-slate-700`, bare `bg-white`/`bg-black`) — they ignore the runtime `data-theme` switch and break two of three themes. `src/components/tokens-only.test.ts` enforces this across all of `src/` except `tokens.css`, including an existence check that a referenced token actually resolves.
- **Read-only app.** No new `invoke` call site; the only backend calls stay the existing two. No user-facing copy may claim the app *enforces* read-only access as a security boundary.
- **Data effects do not change.** The fetch effects in `App.tsx` (forest, entities, schema, rows, sql) keep their current logic and dependencies. This phase moves markup and adds layout state.
- **`AppError.explanation` is rendered verbatim and never truncated** — it is the most valuable thing the backend produces on failure.
- **Never fall back to an unbounded `SELECT`.** The generated SQL lane is trusted/admin and bypasses public-read admission.
- **No new dependency.** `package.json` / `package-lock.json` must not change. CodeMirror belongs to phase 3.
- **Keyboard is phase 3.** No `⌘K`, no `⌘⏎`, no arrow-key cell navigation, no `tabIndex` management here. Task 4 ships the SQL bar's *click* to expand and its close button; the shortcuts come later.
- Test idiom: bare top-level `test(...)`, import nothing from `vitest`, `fireEvent` over `user-event`.
- No AI attribution in commit messages — no `Co-Authored-By`, no "Generated with Claude Code".

**Baseline:** 252 frontend tests, 126 backend tests, `npm run build` clean, on branch `feat/ui-data-presentation` at `c8edc05`.

## File Structure

| File | Responsibility |
|---|---|
| `src/components/Pane.tsx` *(new)* | A titled pane: header row, exactly one scroll region, optional drag handle on its trailing edge |
| `src/layout/usePaneLayout.ts` *(new)* | Pane widths + schema-collapsed + sql-expanded state, persisted to `localStorage`, with clamping |
| `src/components/SchemaInspector.tsx` *(new)* | The right inspector: wraps `SchemaPanel`, owns the collapse control and the collapsed rail |
| `src/components/PaneStates.tsx` *(new)* | `PaneEmpty` — the designed empty state (title, one line, optional action) used by all four panes |
| `src/components/SchemaPanel.tsx` | Unchanged logic; only loses the outer `text-sm` wrapper's assumptions about being nested in a sidebar |
| `src/components/RowGrid.tsx` | Loses its inner `overflow-auto`; the sticky header starts working; `loading` becomes reachable |
| `src/components/ValueCell.tsx` | `max-w-88` becomes the container-relative `max-w-cell` |
| `src/theme/tokens.css` | Adds `--container-cell` and the pane-width bounds |
| `src/App.tsx` | Composition of four panes plus the SQL bar; wires `loading`; anchors errors per pane |

---

### Task 1: `Pane` and the end of nested scrolling

**Files:**
- Create: `src/components/Pane.tsx`
- Create: `src/components/Pane.test.tsx`
- Modify: `src/components/RowGrid.tsx` (remove the inner scroll container)
- Modify: `src/components/RowGrid.test.tsx` (the sticky-header assertion this makes possible)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Pane` — `{ title: string; children: ReactNode; width?: number; onResize?: (width: number) => void; trailing?: ReactNode; className?: string }`. Task 3 and Task 4 both render it.

Today `RowGrid` wraps its table in `<div className="overflow-auto">` while `App.tsx` also wraps the pane in `flex-1 overflow-auto`. Two nested scrollports means the inner one is the `thead`'s nearest scrollport, its `scrollTop` is always 0, and `sticky top-0` therefore never engages. The header has never stuck. Scroll ownership moves to the pane.

- [ ] **Step 1: Write the failing test for `Pane`**

```tsx
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- Pane`
Expected: FAIL — `Cannot find module './Pane'`.

- [ ] **Step 3: Write `Pane`**

```tsx
import type { ReactNode } from "react";

/** A pane: a header that stays put, one scroll region, and an optional drag
 *  handle on the trailing edge.
 *
 *  The single scroll region is the point. Before this, the rows pane had a
 *  scroll container in `App.tsx` *and* another inside `RowGrid`, so the inner
 *  one was the sticky header's nearest scrollport, its `scrollTop` never left
 *  0, and `sticky top-0` silently did nothing. One owner per pane, and the
 *  owner is the pane. */
export function Pane({
  title,
  children,
  width,
  onResize,
  trailing,
  className,
}: {
  title: string;
  children: ReactNode;
  width?: number;
  onResize?: (width: number) => void;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`relative flex min-w-0 flex-col ${width === undefined ? "flex-1" : "shrink-0"} ${className ?? ""}`}
      style={width === undefined ? undefined : { width }}
      aria-label={title}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">{title}</h2>
        {trailing}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {onResize && <PaneHandle width={width} onResize={onResize} label={title} />}
    </section>
  );
}
```

`PaneHandle` comes in Task 2 — for this task, stub it in the same file so the tests compile:

```tsx
function PaneHandle(_props: { width?: number; onResize: (width: number) => void; label: string }) {
  return null;
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `npm test -- Pane`
Expected: PASS.

- [ ] **Step 5: Strip `RowGrid`'s scroll container**

In `src/components/RowGrid.tsx`, the `<div className="overflow-auto">` wrapping the `<table>` becomes a plain `<div>` (keep the element — it is the table's block container and the `min-w-full` sizing depends on it). Leave `sticky top-0` on the `<th>`s exactly as it is; it now has a real scrollport above it.

- [ ] **Step 6: Add the assertion this unblocks**

Append to `src/components/RowGrid.test.tsx`:

```tsx
/// The sticky header only works when the pane owns the scrolling. While
/// `RowGrid` had its own `overflow-auto`, that inner box was the `thead`'s
/// nearest scrollport, its `scrollTop` was permanently 0, and `sticky top-0`
/// resolved to nothing. jsdom cannot scroll, so this pins the structural
/// precondition: the header is sticky and `RowGrid` contains no scrollport.
test("the grid does not own a scroll container, so its sticky header can stick", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  expect(document.querySelectorAll(".overflow-auto, .overflow-scroll")).toHaveLength(0);
  const header = document.querySelector("th");
  expect(header).toHaveClass("sticky");
  expect(header).toHaveClass("top-0");
});
```

- [ ] **Step 7: Verify, including the discriminate check**

Run: `npm test`
Expected: all pass. Then re-add `overflow-auto` to the `RowGrid` div and confirm the new test goes red; remove it again. Report the observed result.

- [ ] **Step 8: Commit**

```bash
git add src/components/Pane.tsx src/components/Pane.test.tsx src/components/RowGrid.tsx src/components/RowGrid.test.tsx
git commit -m "feat: add Pane and give it sole ownership of pane scrolling"
```

---

### Task 2: draggable, persisted pane widths

**Files:**
- Create: `src/layout/usePaneLayout.ts`
- Create: `src/layout/usePaneLayout.test.ts`
- Modify: `src/components/Pane.tsx` (real `PaneHandle`)
- Modify: `src/components/Pane.test.tsx`
- Modify: `src/theme/tokens.css` (width bounds)

**Interfaces:**
- Consumes: `Pane`'s `width`/`onResize` props from Task 1.
- Produces:
  ```ts
  export const PANE_STORAGE_KEY = "icydb-explorer.panes";
  export const PANE_BOUNDS = { fleet: [160, 480], tables: [160, 480], schema: [220, 560] } as const;
  export type PaneName = keyof typeof PANE_BOUNDS;
  export type PaneLayout = {
    widths: Record<PaneName, number>;
    schemaCollapsed: boolean;
    sqlExpanded: boolean;
  };
  export function usePaneLayout(): {
    layout: PaneLayout;
    setWidth: (pane: PaneName, width: number) => void;
    toggleSchema: () => void;
    setSqlExpanded: (expanded: boolean) => void;
  };
  ```
  Tasks 3 and 4 consume all of it.

Follow `src/theme/useTheme.ts` exactly for the persistence shape: a module-level `storedLayout()` that reads and validates once, a `try`/`catch` around every `localStorage` access (it throws in private mode), and a named exported key.

- [ ] **Step 1: Write the failing tests**

```ts
import { PANE_BOUNDS, PANE_STORAGE_KEY, clampWidth, readLayout } from "./usePaneLayout";

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
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- usePaneLayout`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `usePaneLayout`**

```ts
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
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- usePaneLayout`
Expected: PASS.

- [ ] **Step 5: Implement the real `PaneHandle`**

Replace the Task 1 stub in `src/components/Pane.tsx`:

```tsx
/** The drag handle on a pane's trailing edge.
 *
 *  A `separator` with `aria-orientation="vertical"` because that is what this
 *  is; the drag is tracked on `window` rather than on the handle so that moving
 *  the pointer faster than React re-renders does not drop the drag. */
function PaneHandle({
  width,
  onResize,
  label,
}: {
  width?: number;
  onResize: (width: number) => void;
  label: string;
}) {
  const start = (event: React.PointerEvent) => {
    const originX = event.clientX;
    const originWidth = width ?? 0;

    const move = (moveEvent: PointerEvent) =>
      onResize(originWidth + (moveEvent.clientX - originX));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      onPointerDown={start}
      className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-accent"
    />
  );
}
```

- [ ] **Step 6: Test the drag**

Append to `src/components/Pane.test.tsx`:

```tsx
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

  expect(widths.at(-1)).toBe(280);
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
```

Add `fireEvent` to the existing import from `@testing-library/react`.

- [ ] **Step 7: Verify and discriminate**

Run: `npm test`
Expected: all pass. Then make three mutations, confirming each turns its own test red and restoring after: (a) drop the `clampWidth` call from `setWidth`; (b) attach `pointermove`/`pointerup` to the handle instead of `window`; (c) make `readLayout` return `JSON.parse(raw)` directly with no validation. Report each observed result.

- [ ] **Step 8: Commit**

```bash
git add src/layout src/components/Pane.tsx src/components/Pane.test.tsx
git commit -m "feat: draggable pane widths persisted with clamping"
```

---

### Task 3: schema becomes the right inspector

**Files:**
- Create: `src/components/SchemaInspector.tsx`
- Create: `src/components/SchemaInspector.test.tsx`
- Modify: `src/components/SchemaPanel.tsx` (only if it assumes sidebar width)

**Interfaces:**
- Consumes: `Pane` (Task 1), `PaneLayout`/`toggleSchema` (Task 2).
- Produces: `SchemaInspector` — `{ schema: SchemaDto | null; error: AppErrorDto | null; entity: string | null; collapsed: boolean; onToggle: () => void; width: number; onResize: (width: number) => void }`. Task 4 renders it.

The real shapes, from `src/api/types.ts` — use these, do not restate them from memory:

```ts
type ColumnDto = { name: string; typeName: string; primaryKey: boolean; optional: boolean };
type SchemaDto = { entity: string; columns: ColumnDto[]; indexes: string[] };
type AppErrorDto = { kind: string; explanation: string };
```

Note `indexes` is `string[]`, not objects, and `AppErrorDto` has no `message`.

Two states. Expanded: a `Pane` titled "Schema" with a collapse control in its `trailing` slot, containing `SchemaPanel` (or the error, or the empty state). Collapsed: a ~30px rail that is still a labelled button, so the way back is obvious.

The collapsed rail is the state the spec expects a reader to keep it in, so it must be unmistakably re-openable — a vertical label plus an affordance, not a bare sliver.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";

import { SchemaInspector } from "./SchemaInspector";

const SCHEMA = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", optional: false, primaryKey: true },
    { name: "handle", typeName: "Text", optional: true, primaryKey: false },
  ],
  indexes: [],
};

const props = {
  schema: SCHEMA,
  error: null,
  entity: "User",
  width: 320,
  onResize: () => {},
};

test("the expanded inspector shows the schema and a way to collapse it", () => {
  render(<SchemaInspector {...props} collapsed={false} onToggle={() => {}} />);

  expect(screen.getByText("handle")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /collapse schema/i })).toBeInTheDocument();
});

/// Collapsed is the state the spec expects a reader to keep the inspector in,
/// so the way back has to be obvious. A bare sliver with no accessible name is
/// a dead end — the control keeps a name and the rail keeps a visible label.
test("the collapsed rail is still a labelled control that can reopen", () => {
  const toggles: number[] = [];
  render(
    <SchemaInspector {...props} collapsed onToggle={() => toggles.push(1)} />,
  );

  expect(screen.queryByText("handle")).not.toBeInTheDocument();
  const reopen = screen.getByRole("button", { name: /expand schema/i });
  expect(reopen).toHaveTextContent(/schema/i);

  fireEvent.click(reopen);
  expect(toggles).toHaveLength(1);
});

test("an error is shown inside the inspector, verbatim", () => {
  // `AppErrorDto` is exactly `{ kind, explanation }` — there is no `message`
  // field. `explanation` is the operator-facing prose and is rendered whole.
  const error = { kind: "backend", explanation: "E7: no such entity" };
  render(<SchemaInspector {...props} schema={null} error={error} collapsed={false} onToggle={() => {}} />);

  expect(screen.getByText(/E7: no such entity/)).toBeInTheDocument();
});

test("with no table selected the inspector says so rather than sitting blank", () => {
  render(
    <SchemaInspector {...props} schema={null} entity={null} collapsed={false} onToggle={() => {}} />,
  );

  expect(screen.getByText(/select a table/i)).toBeInTheDocument();
});
```

If `AppError`'s real shape differs, read `src/api/types.ts` and match it — do not change the type to suit the test.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- SchemaInspector`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SchemaInspector`**

```tsx
import type { AppErrorDto, SchemaDto } from "../api/types";
import { ErrorBanner } from "./ErrorBanner";
import { Pane } from "./Pane";
import { SchemaPanel } from "./SchemaPanel";

/** The schema, as the right-hand inspector.
 *
 *  Collapsed it becomes a labelled rail rather than a bare sliver: the spec
 *  expects a reader to keep it collapsed most of the time, so the way back has
 *  to be visible and named. The rail keeps its own `aria-label` and a rotated
 *  visible label for that reason. */
export function SchemaInspector({
  schema,
  error,
  entity,
  collapsed,
  onToggle,
  width,
  onResize,
}: {
  schema: SchemaDto | null;
  error: AppErrorDto | null;
  entity: string | null;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onResize: (width: number) => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand schema"
        aria-expanded={false}
        className="flex w-8 shrink-0 items-center justify-center border-l border-rule bg-surface-1 text-xs font-semibold uppercase tracking-wide text-text-2 hover:bg-surface-2"
      >
        <span className="[writing-mode:vertical-rl]">Schema</span>
      </button>
    );
  }

  return (
    <Pane
      title="Schema"
      width={width}
      onResize={onResize}
      className="border-l border-rule bg-surface-1"
      trailing={
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse schema"
          aria-expanded
          className="rounded-control px-1 text-xs text-text-3 hover:bg-surface-2"
        >
          ›
        </button>
      }
    >
      {error && <ErrorBanner error={error} />}
      {!error && schema && <SchemaPanel schema={schema} />}
      {!error && !schema && (
        <p className="p-3 text-sm text-text-3">
          {entity ? "Loading schema…" : "Select a table to see its schema."}
        </p>
      )}
    </Pane>
  );
}
```

The `onResize` handle sits on the pane's trailing (right) edge, which for the rightmost pane means dragging it *rightward* widens it — that is backwards. Pass the drag through negated for this pane, or give `Pane` an `edge?: "leading" | "trailing"` prop. Pick one, implement it, and state which in your report; a resize that moves the wrong way is worse than none.

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- SchemaInspector`
Expected: PASS.

- [ ] **Step 5: Verify against the token guard**

Run: `npm test -- tokens-only`
Expected: PASS. `[writing-mode:vertical-rl]` is a bracketed arbitrary property; confirm the guard's bracketed-colour-keyword check does not false-positive on it. If it does, that is a guard bug — fix the guard's pattern so it only matches colour keywords, and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add src/components/SchemaInspector.tsx src/components/SchemaInspector.test.tsx
git commit -m "feat: schema as a collapsible right inspector"
```

---

### Task 4: recompose the shell into four panes plus the SQL bar

**Files:**
- Modify: `src/App.tsx` (the render block from `{root !== null && (` to the closing `)}`, roughly lines 588-641)
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `Pane` (1), `usePaneLayout` (2), `SchemaInspector` (3).
- Produces: nothing downstream; this is the composition.

Four panes left to right — Fleet, Tables, Rows, Schema — then the SQL bar across the bottom. Schema moves out of the Tables aside entirely. Each pane anchors its own error *inside itself*, so a failure no longer pushes the layout down.

This is also where `RowGrid`'s `loading` prop finally gets a call site. Today `App.tsx` does `setRows(null)` before each fetch and renders `{rows && <RowGrid …/>}`, so the grid unmounts during a load and the skeleton branch is unreachable — which is why the words "Loading rows…" are still on screen. Keep `RowGrid` mounted across the fetch and pass `loading`.

**Two consequences to handle deliberately, not incidentally:**

1. Keeping the grid mounted means its expansion state survives a fetch. Phase 2a added identity-based invalidation in `RowGrid` for exactly this moment — verify it fires by switching entities with a cell expanded. Do not add a second invalidation mechanism.
2. `RowGrid` needs the column list while `rows` is null to size the skeletons, or they reflow when data lands — the exact thing the skeleton exists to prevent. Hold the last non-null `rows` in a ref and feed the grid that shape with an empty `rows` array while loading:

```tsx
// The last shape we saw, so a pending fetch can render skeletons at the real
// column count instead of guessing. Holding the previous *shape* (not its
// rows) is what keeps the grid from reflowing when the data lands.
const lastShape = useRef<RowsDto | null>(null);
if (rows !== null) lastShape.current = rows;

const gridRows: RowsDto | null =
  rows ?? (lastShape.current && { ...lastShape.current, rows: [], rowCount: 0, nextCursor: null });
```

Then render `{gridRows && <RowGrid rows={gridRows} loading={rows === null} … />}`. On the very first load `lastShape.current` is null and there is no column count to honour, so nothing renders and the pane shows its empty state — acceptable, and better than inventing a column count. Note in your report that the first load of a session therefore shows no skeletons.

- [ ] **Step 1: Write the failing tests**

```tsx
/// The four panes, each with its own accessible name, so a failure in one is
/// anchored in one. Before this the schema lived inside the Tables aside and
/// errors were inserted above the panes, shifting everything below them.
test("the shell presents four named panes", async () => {
  renderAppReady();

  for (const name of ["Canisters", "Tables", "Rows", "Schema"]) {
    expect(await screen.findByRole("region", { name })).toBeInTheDocument();
  }
});

/// The skeleton state was shipped in phase 2a with no call site: `App` set rows
/// to null before each fetch and only rendered the grid when rows existed, so
/// "mounted, loading, no rows" was unreachable and the words "Loading rows…"
/// stayed on screen. This is the test that would have caught that.
test("a pending row fetch shows skeletons, not the words Loading rows", async () => {
  renderAppLoadingRows();

  expect(await screen.findByTestId("row-skeletons")).toBeInTheDocument();
  expect(screen.queryByText(/loading rows/i)).not.toBeInTheDocument();
});
```

Match the existing helpers in `src/App.test.tsx` — read it first and reuse its `invoke` mocking rather than inventing a second style. If no `renderAppReady`-style helper exists, name yours after what the file already does.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- App`
Expected: FAIL — no `region` roles, and `Loading rows…` still present.

- [ ] **Step 3: Recompose**

```tsx
{root !== null && (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1">
      <Pane title="Canisters" width={layout.widths.fleet} onResize={(w) => setWidth("fleet", w)}
            className="border-r border-rule bg-surface-1">
        {treeError && <ErrorBanner error={treeError} />}
        {forest && <CanisterTree trees={forest} selectedPid={canister} onSelect={setCanister} />}
      </Pane>

      <Pane title="Tables" width={layout.widths.tables} onResize={(w) => setWidth("tables", w)}
            className="border-r border-rule bg-surface-1">
        {entitiesError && <ErrorBanner error={entitiesError} />}
        {entities && <TableList entities={entities} selected={entity} onSelect={setEntity} />}
      </Pane>

      <Pane title="Rows">
        {rowsError && <ErrorBanner error={rowsError} />}
        {!rowsError && gridRows && (
          <RowGrid rows={gridRows} hasMore={hasMore} onLoadMore={loadMore}
                   loading={rows === null} />
        )}
      </Pane>

      <SchemaInspector schema={schema} error={schemaError} entity={entity}
                       collapsed={layout.schemaCollapsed} onToggle={toggleSchema}
                       width={layout.widths.schema} onResize={(w) => setWidth("schema", w)} />
    </div>

    <SqlBar expanded={layout.sqlExpanded} onExpandedChange={setSqlExpanded}
            onRun={handleRunSql} error={sqlError} limitAppended={sqlLimitAppended}
            orderByMissing={sqlOrderByMissing} result={sqlResult} />
  </div>
)}
```

`SqlBar` is a small wrapper in `App.tsx` (not a new file — it is composition, and phase 3 replaces its contents with `SqlEditor`): collapsed, a single row with the pane's border and a button reading "SQL"; expanded, the existing `SqlConsole` plus `SqlResultView` inside one scroll region, with a close button. No keyboard shortcut — that is phase 3.

Keep `min-h-0` on every flex ancestor of a scroll region. Without it a flex child's `min-height: auto` refuses to shrink below its content and the pane grows instead of scrolling — this is the single most likely way to break this task.

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- App`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite and the build**

Run: `npm test` then `npm run build`
Expected: both clean. Fix any test that asserted the old three-pane structure — update the assertion to the new structure; do not delete the test.

- [ ] **Step 6: Check the expansion invalidation really fires**

With the grid now mounted across fetches, switch entities with a cell expanded and confirm no `TypeError` and no stale sub-row. Add a test if `App.test.tsx` can drive it; if it cannot, say so plainly and note that `RowGrid.test.tsx` covers the mechanism directly.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat: four panes, per-pane errors, and reachable row skeletons"
```

---

### Task 5: designed empty states

**Files:**
- Create: `src/components/PaneStates.tsx`
- Create: `src/components/PaneStates.test.tsx`
- Modify: `src/components/RowGrid.tsx` (the `No rows` branch)
- Modify: `src/components/SchemaInspector.tsx`, `src/App.tsx` (use it)

**Interfaces:**
- Produces: `PaneEmpty` — `{ title: string; children?: ReactNode; action?: ReactNode }`.

The spec asks for "an invitation naming the space, one explanatory line, and the action if there is one". Today the rows pane renders the two words `No rows` and the other panes render nothing at all.

Keep the existing amber-box copy for "no usable identity" and "no environments" exactly where it is — the spec says explicitly that those explanations are good and stay. This task is for the panes that currently say nothing.

- [ ] **Step 1: Write the failing test**

```tsx
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
```

- [ ] **Step 2: Run, confirm failure, implement, confirm pass**

Run: `npm test -- PaneStates`

- [ ] **Step 3: Adopt it in the three places that need it**

`RowGrid`'s empty branch (`No rows` → `PaneEmpty` with a line naming the table), `SchemaInspector`'s no-entity state, and the Tables pane when a canister has no entities. Update `RowGrid.test.tsx`'s existing `getByText(/no rows/i)` assertion if the copy changes — keep it asserting empty-vs-loading distinctness.

- [ ] **Step 4: Verify and commit**

Run: `npm test` then `npm run build`

```bash
git add src/components/PaneStates.tsx src/components/PaneStates.test.tsx src/components/RowGrid.tsx src/components/RowGrid.test.tsx src/components/SchemaInspector.tsx src/App.tsx
git commit -m "feat: designed empty states for the panes that had none"
```

---

### Task 6: make the cell cap container-relative

**Files:**
- Modify: `src/theme/tokens.css`
- Modify: `src/components/ValueCell.tsx`, `src/components/Identifier.tsx`
- Modify: `src/components/ValueCell.test.tsx`, `src/components/Identifier.test.tsx`

**Interfaces:**
- Consumes: the rows `Pane` from Task 4 as the query container.

`max-w-88` is a hard 352px that reads nothing about available width. The spec's stated payoff for collapsing the schema inspector is that "the rows pane takes the width back … it is where identifiers stop being elided" — but with a fixed cap, collapsing the inspector widens the table and hands the reclaimed space to whitespace. Identifiers stay elided and the collapse buys nothing.

Make the cap container-relative so the promise holds.

- [ ] **Step 1: Add the token**

In `src/theme/tokens.css`, inside the `@theme inline` block:

```css
/* The cell width cap. Container-relative so that collapsing the schema
   inspector actually widens cells rather than adding whitespace — that
   reclaimed width is the entire point of the collapse. Bounded above so a
   very wide window does not hand one column half the grid. */
--container-cell: min(22rem, 42cqw);
```

`--container-*` is Tailwind 4's `max-w-*` namespace, so this yields `max-w-cell`. Confirm in the built CSS (`npm run build`, then grep `dist/assets/*.css` for `max-w-cell`) that it emits a real rule — a token that does not resolve fails silently, which is the exact failure mode phase 2a's existence check was added for.

- [ ] **Step 2: Make the rows pane a container**

Add `@container` to the rows `Pane`'s scroll region (via a `className` prop on the rows pane in `App.tsx`, or on `Pane`'s scroll div when a new `container` prop is set — pick the narrower change). Without a container ancestor, `cqw` resolves against the viewport and the cap stops tracking the pane.

- [ ] **Step 3: Swap the class**

Replace `max-w-88` with `max-w-cell` in `ValueCell.tsx` (three branches: plain, numeric, expandable) and `Identifier.tsx` (one). Update the assertions in both test files.

- [ ] **Step 4: Verify, and be honest about what you cannot verify**

Run: `npm test`, `npm run build`
Expected: clean. Then confirm the emitted CSS contains a `max-w-cell` rule whose value is the `min()` expression.

jsdom cannot evaluate container queries, so the tests can only pin that the class is present and the token resolves. **Do not claim the cap tracks the pane width unless you have observed it.** If you can render the built app in a browser, resize the schema inspector and report what you saw; if you cannot, say so plainly — an honest "could not verify visually" is far more useful than an assumed pass.

- [ ] **Step 5: Commit**

```bash
git add src/theme/tokens.css src/components/ValueCell.tsx src/components/Identifier.tsx src/components/ValueCell.test.tsx src/components/Identifier.test.tsx
git commit -m "feat: cell cap tracks the rows pane instead of a fixed 352px"
```

---

## Carried forward to phase 3

Recorded here so they are not lost, and deliberately **not** in this phase:

- The full keyboard map: `⌘K` palette, `⌘⏎`/`Esc` for the SQL bar, arrow-key cell navigation, and `tabIndex={-1}` on the grid's controls. Phase 2a made every identifier and chevron a native tab stop — on a 100-row table that is ~200 tab presses to reach "Load more". The focus model has to land as one piece, not in fragments.
- `CommandPalette.tsx` and CodeMirror `SqlEditor.tsx` with schema-derived completion and the `ORDER BY` assist for icydb's `E5`.
- `aria-controls` from each expand button to its sub-row, and a role for the sub-row.
- Arrays as `N items` when collapsed (only the expanded half exists today).
- The tokens-only existence check's namespace-typo gap: `bg-surfce-1` still passes because its leading segment matches no known token family. A compile-based check would close it and subsume the file's other class-shape heuristics.
- Light themes' zebra sits at 1.047 contrast — the weakest relationship in the token file, below the 1.08 floor Terminal was held to.
