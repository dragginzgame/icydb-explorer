# Phase 3a — Carried Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps phases 1–2b carried forward, so phase 3b's features (command palette, CodeMirror editor, `ORDER BY` assist) land on a sound base rather than on top of known holes.

**Architecture:** Six independent tasks, mostly small. Two are real behaviour fixes (window-aware width clamping, a bounded banner region), two are accessibility (`aria-busy` on the loading grid, `aria-controls` between an expand button and its sub-row), one is a structural test that pins a property jsdom otherwise cannot see, and one is housekeeping plus a token contrast correction.

**Tech Stack:** React 19, Tailwind 4.3.3 (CSS-first `@theme`), Vitest 4 + Testing Library, Tauri 2.

## Global Constraints

- **A literal colour outside `src/theme/tokens.css` is a defect**, as is any Tailwind built-in palette class — they ignore the runtime `data-theme` switch and break two of the three themes. `src/components/tokens-only.test.ts` enforces this across `src/`, including token-existence checks for `bg-`/`text-`/`border-`/`rounded-`/`max-w-`.
- **The five fetch effects and their stale-response guards stay byte-identical**: stale `listTables` never overwriting a newer canister, stale SQL run never overwriting a newer result, environment switch abandoning an in-flight identity selection, identity switch not resurrecting a stale error, and the `projectGeneration` counter. Two whole-branch reviews have confirmed these byte-for-byte; that must remain true.
- **Read-only app.** No new `invoke` call site. No user-facing copy may claim the app *enforces* read-only access as a security boundary. Never an unbounded `SELECT`.
- **`AppErrorDto.explanation` renders verbatim and is never truncated.**
- **No new dependency.** `package.json` / `package-lock.json` must not change.
- **No keyboard map here.** `⌘K`, `⌘⏎`, `Esc`, arrow-key cell navigation and `tabIndex` management all belong to phase 3b, which must land them as one piece. Task 2 adds ARIA relationships only — no key handlers.
- Test idiom: bare top-level `test(...)`, import nothing from `vitest` (`vi` is a configured global), `fireEvent` over `user-event`. `src/App.test.tsx` has **no** `renderApp`-style helper: build setup inline from `environmentFixture()`, `entity(name, columns)`, `rowsFixture()`, `deferred<T>()`, `usableIdentity` and `vi.mocked(commands.*)`.
- No AI attribution in commit messages.

**Baseline:** `main` at the phase-2b merge — `npm test` **319 passing** (17 files), `cd src-tauri && cargo test` **129 passing**, clippy clean, `npm run build` clean.

## Already closed — do not redo

The final phase-2b fix round closed four items the whole-branch review had listed as carried:

- `max-w` / `--container-*` are now inside the token-existence guard (`tokens-only.test.ts:157-169`).
- Every `.max-w-cell` is asserted to have an `@container` ancestor, covering **both** `RowGrid` call sites (`App.test.tsx:1091`).
- The pane row's `overflow-hidden` has a class-presence guard (`App.test.tsx:799`).
- The Canisters and Tables panes have loading and empty states (`App.tsx:663`, `:670`, `:692`, `:697`).

## Unresolved and NOT in this plan

**Which fallback `cqw` takes with no query container.** CSS Containment Level 3 says container query length units resolve against the **small viewport size** when no eligible container exists; a phase-2b implementer measured Chromium resolving them to **0**. The measurement is more credible than it first looks — a block-level `<div>` with a `max-width` cap stretches to that cap, so a rendered width of 0 does suggest the cap itself computed to 0 rather than being an empty-element artifact. But the shipping runtime is **WKWebView**, a third engine nobody has measured, and browser tooling was unavailable when this plan was written (three attempts, each timing out).

This does not block anything: both `RowGrid` call sites now have containers and a test guards the invariant. Settle it opportunistically when the app is next run for real, and record the answer in `README.md` rather than in a plan.

---

### Task 1: pin the `min-h-0` chain structurally

**Files:**
- Modify: `src/App.test.tsx`

**Interfaces:** consumes nothing; produces nothing. Test-only.

A flex item defaults to `min-height: auto` and refuses to shrink below its content, so a scroll region whose flex ancestors lack `min-h-0` makes the pane *grow* instead of scrolling. Phase 2b measured this in a browser — the page ballooning from 800px to 11312px with **no** region scrolling — and left it as a documented standing gap because jsdom has no layout engine.

It does not need one. The property is **structural**, so a DOM walk can pin it: from every scroll region up to `<main>`, each ancestor that is a flex item of a `flex-col` parent and does not opt out with `shrink-0` must carry `min-h-0`.

- [ ] **Step 1: Write the failing test**

```tsx
/// A flex item's default `min-height: auto` refuses to shrink below its content,
/// so a scroll region whose column-flex ancestors lack `min-h-0` makes its pane
/// grow instead of scrolling. Phase 2b measured that in a browser (an 800px page
/// becoming 11312px, with nothing scrolling) and left it unguarded because jsdom
/// has no layout engine.
///
/// It does not need one: the requirement is structural. Walk up from each scroll
/// region and assert every column-flex ancestor either carries `min-h-0` or opts
/// out with `shrink-0`. This is the real property, not a proxy for it.
///
/// `Pane`'s own `<section>` is deliberately exempt and must stay that way: it is a
/// flex item in a ROW container, where per CSS Flexbox §4.5 the automatic minimum
/// applies only on the main axis — so `min-width` binds (covered by its `min-w-0`)
/// and `min-height: auto` computes to 0. That is why the walk tests the parent's
/// direction rather than blindly demanding `min-h-0` everywhere.
test("every scroll region can actually shrink: its column-flex ancestors carry min-h-0", async () => {
  // ...arrange a project with a canister, a table selected, and the SQL bar open,
  // so all pane scroll regions plus the bar's are mounted at once. Build setup
  // inline from environmentFixture()/entity()/rowsFixture()/vi.mocked as the
  // neighbouring tests do.

  const scrollers = document.querySelectorAll(".overflow-auto");
  expect(scrollers.length).toBeGreaterThan(3);

  const offenders: string[] = [];
  for (const scroller of scrollers) {
    for (let node = scroller as HTMLElement | null; node && node !== document.body; ) {
      const parent = node.parentElement;
      if (!parent) break;
      const inColumn = parent.classList.contains("flex-col");
      const isFlexItem = parent.classList.contains("flex");
      const exempt = node.classList.contains("shrink-0") || node.classList.contains("min-h-0");
      if (isFlexItem && inColumn && !exempt) {
        offenders.push(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`);
      }
      node = parent;
    }
  }

  expect(offenders).toEqual([]);
});
```

Adjust the walk if the real class shapes differ — read `src/App.tsx`'s render block first. What must not change is that the assertion is derived from the DOM, not from a hardcoded list of elements.

- [ ] **Step 2: Run it**

Run: `npm test -- App`
Expected: PASS against the current tree, since phase 2b measured the chain as correct. **A passing new test proves nothing on its own** — go straight to step 3.

- [ ] **Step 3: Discriminate**

Remove `min-h-0` from the shell column (`src/App.tsx:627`), run the test, confirm it fails and names that element. Restore. Repeat for the pane row and for the SQL bar's `min-h-0`. Report all three observed results. If any mutation does not fail, the walk is not reaching that element — fix the walk, and say so.

- [ ] **Step 4: Commit**

```bash
git add src/App.test.tsx
git commit -m "test: pin the min-h-0 chain structurally instead of by measurement"
```

---

### Task 2: announce the loading grid and connect each expand control to its sub-row

**Files:**
- Modify: `src/components/RowGrid.tsx`, `src/components/RowGrid.test.tsx`
- Modify: `src/components/ValueCell.tsx`, `src/components/ValueCell.test.tsx`

**Interfaces:**
- Consumes: `RowGrid` owns the expansion state `{ row, column } | null` and renders the sub-row; `ValueCell` renders the expand button and already receives `expanded` and the column name.
- Produces: `ValueCell` gains a required-when-expandable `subRowId` prop (or equivalent); state ownership does not move.

Two gaps, both found in review and both cheap:

1. **The loading grid is silent.** Skeleton bars are `aria-hidden` and the grid sets no `aria-busy`, so a screen-reader user meets an apparently empty table for the whole fetch.
2. **`aria-expanded` has nothing to point at.** Each expand button sets `aria-expanded` but there is no `aria-controls`, and the sub-row `<tr>` has no `id`. The relationship exists visually and not programmatically.

- [ ] **Step 1: Write the failing tests**

```tsx
/// A skeleton conveys "loading" visually and nothing at all to a screen reader:
/// the bars are aria-hidden, so without `aria-busy` the grid reads as an empty
/// table for the whole fetch — indistinguishable from a table with no rows.
test("the loading grid announces itself as busy", () => {
  render(<RowGrid rows={null} skeletonColumns={3} loading hasMore={false} onLoadMore={() => {}} />);

  expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
});

test("a loaded grid is not busy", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy", "true");
});

/// `aria-expanded` says a control discloses something; `aria-controls` says what.
/// Without the pair, a screen-reader user is told a button is expanded and given
/// no way to reach what it expanded.
test("an expanded cell's control points at the sub-row it opened", () => {
  render(<RowGrid rows={structured} hasMore={false} onLoadMore={() => {}} />);

  const control = screen.getAllByRole("button", { name: /expand/i })[0];
  fireEvent.click(control);

  const target = control.getAttribute("aria-controls");
  expect(target).toBeTruthy();
  const subRow = document.getElementById(target!);
  expect(subRow).not.toBeNull();
  expect(subRow!.tagName.toLowerCase()).toBe("tr");
});
```

Use the fixtures already in `RowGrid.test.tsx` rather than adding new ones; `structured` above stands for whichever existing fixture has an expandable cell.

- [ ] **Step 2: Run, confirm failure, implement**

Run: `npm test -- RowGrid`
Expected: FAIL on the missing attributes.

Then: put `aria-busy={loading}` on the `<table>` in **both** the skeleton grid and the real grid (a single source is better than two literals — if the skeleton is a separate component, pass it through). Derive the sub-row `id` from the row and column indices so it is stable and unique within the grid, set it on the sub-row `<tr>`, and pass the same value to `ValueCell` for its `aria-controls`. Only the *open* cell needs `aria-controls`; a collapsed control pointing at a non-existent id is worse than none, so omit it when closed.

- [ ] **Step 3: Confirm pass, then discriminate**

Run: `npm test`
Then break each: drop `aria-busy`; make the `id` and the `aria-controls` disagree; set `aria-controls` while collapsed. Each must fail its own test — the third needs an assertion, so add one if it does not exist. Report what you observed.

- [ ] **Step 4: Commit**

```bash
git add src/components/RowGrid.tsx src/components/RowGrid.test.tsx src/components/ValueCell.tsx src/components/ValueCell.test.tsx
git commit -m "fix: announce the loading grid and connect expand controls to their sub-rows"
```

---

### Task 3: clamp persisted widths against the window

**Files:**
- Modify: `src/layout/usePaneLayout.ts`, `src/layout/usePaneLayout.test.ts`

**Interfaces:**
- Consumes: `PANE_BOUNDS`, `clampWidth`, `readLayout`, `usePaneLayout` as they exist.
- Produces: no signature change to `usePaneLayout`'s return shape. `clampWidth` may gain an optional available-width parameter; if it does, every existing caller must keep working.

`clampWidth` checks `PANE_BOUNDS` only. Those bounds permit 480 + 480 + 560 = **1520px** of fixed pane width. On a 1280px window with all three stored at maximum — every value individually legal — the `flex-1` Rows pane resolves to **0px**, and the Schema pane spans 960–1520, putting its own collapse button *and* its drag handle off-screen. It persists across launches, and the only recovery is dragging the other two panes left first.

Make the fixed panes collectively fit, leaving the Rows pane a usable minimum. Decide where that belongs — a read-time repair in `readLayout`, a clamp at drag time, or both — and justify the choice in your report. Consider that the window can be resized *after* a layout is stored, so a read-time-only fix is not sufficient on its own; and that `window.innerWidth` is available in jsdom and settable in a test.

Do not add a resize listener unless you can show it is needed; a repair applied when the layout is read and when a drag is committed covers the reachable cases more cheaply.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

Pick the 320px floor deliberately or choose a different one and say why — but do not let the Rows pane reach zero, since it is the pane the user came for.

- [ ] **Step 2: Run, confirm failure, implement, confirm pass**

Run: `npm test -- usePaneLayout`

- [ ] **Step 3: Discriminate**

Remove the window-aware repair and confirm the first test fails while the second still passes; then make the repair unconditional (shrinking widths that already fit) and confirm the *second* test fails. Both directions matter: a repair that always fires is as wrong as one that never does. Report both.

- [ ] **Step 4: Commit**

```bash
git add src/layout/usePaneLayout.ts src/layout/usePaneLayout.test.ts
git commit -m "fix: keep the fixed panes collectively inside the window"
```

---

### Task 4: bound the top-level banner region

**Files:**
- Modify: `src/App.tsx`, `src/App.test.tsx`

**Interfaces:** consumes nothing new; presentational.

The header and five conditional banner blocks are direct children of `<main>` with no `shrink-0` and no cap, while the pane shell is `min-h-0 flex-1`. A very long `explanation` — or `noUsableIdentitySummary` joining many unusable identities — keeps the banners at content height and shrinks the shell toward zero, so the panes become unreachable.

This is **pre-existing**, not introduced by phase 2b: measured at an 8042px explanation, the pre-phase shell collapsed the pane area to 0 exactly as the current one does, because the old pane row's `overflow-hidden` floored its automatic minimum to 0 just as `min-h-0` now does. It is still worth fixing, and it is why it gets its own task rather than being folded in as a minor.

Give the banner blocks a bounded, scrollable region so a long explanation scrolls within its own box instead of consuming the window. **`AppErrorDto.explanation` must still render verbatim and untruncated** — bounding the *container* is allowed; clipping the text is not. A `max-height` plus `overflow-auto` satisfies both; `line-clamp` does not.

Note the constraint interaction: phase 2b's rule is one scroll container per pane, and this adds one outside every pane. That is consistent — the banner region is not a pane — but say so in your report so the next reader does not read it as a regression.

- [ ] **Step 1: Write the failing test**

```tsx
/// A long explanation must scroll inside its own region rather than pushing the
/// panes out of the window. Bounding the container is fine; truncating the text
/// is not — the backend's explanation is the most useful thing it produces on a
/// failure and is rendered verbatim.
test("a very long error explanation scrolls in its own region instead of squeezing the panes", async () => {
  const explanation = "SQL surface disabled. ".repeat(400);
  // ...arrange so that explanation reaches a top-level banner.

  expect(await screen.findByText(new RegExp(explanation.slice(0, 40)))).toBeInTheDocument();
  const region = document.querySelector("[data-banner-region]");
  expect(region).not.toBeNull();
  expect(region!.className).toMatch(/overflow-(?:auto|y-auto)/);
  expect(region!.className).toMatch(/max-h-/);
  // The panes are still mounted, not squeezed out of existence.
  expect(await screen.findByRole("region", { name: "Rows" })).toBeInTheDocument();
});
```

jsdom cannot measure the squeeze, so this pins the mechanism — the bounded scrollable container — and the verbatim text. Say that plainly in your report rather than implying the layout was observed.

- [ ] **Step 2: Run, confirm failure, implement, confirm pass, discriminate**

Remove the `max-h-*`, then the `overflow-auto`, then replace the verbatim render with a truncation; each must fail. Report all three.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "fix: bound the banner region so a long explanation cannot squeeze out the panes"
```

---

### Task 5: give the light themes' zebra an assertion of its own

**Files:**
- Modify: `src/theme/tokens.test.ts` only. **Do not change `tokens.css` unless a test you write proves a value is wrong.**

**Interfaces:** consumes nothing; test-layer only.

**Read `src/theme/tokens.test.ts:115-127` before doing anything.** The whole-branch review listed "light themes' 1.047 zebra contrast" as a carried gap, and the first draft of this plan told you to raise it to 1.08. That was wrong, and the correction is the substance of this task.

The 1.08 floor is asserted only for `:root`, Console and Terminal, and the test says why: *"the light blocks sit at 1.047, which is why the floor is asserted for the dark blocks where a flat near-black can hide a stripe completely."* That is a deliberate exemption, and the reasoning holds — contrast ratio understates separation at high luminance. The light stripe is `#fcfcfa` (L≈0.972) against `#f7f7f1` (L≈0.928), an absolute luminance gap of **0.044**; Terminal's is `#0f1211` (L≈0.0058) against `#181d1c` (L≈0.0116), a gap of **0.0058**. The light stripe is separated about 7.5× more in absolute terms while scoring lower as a ratio. So 1.047 there is a *larger* perceptual step than 1.10 in near-black, and raising it would flatten a theme that is currently correct.

The real gap is different, and smaller: **the light blocks have no stripe-visibility assertion at all.** The only thing covering them is the pairwise-distinct test, which compares exact strings — so two hexes one unit apart pass it, and a future retune could make the light zebra genuinely invisible with the suite green.

Close that instead: assert the property that actually applies to a light surface. An absolute luminance separation is the right metric here for the reason above; pick a floor from the current values with a little headroom, so the test fails on a real flattening but not on a small deliberate retune.

- [ ] **Step 1: Extend the test**

Add an assertion covering the two light blocks — the `prefers-color-scheme: light` block and `:root[data-theme="instrument"]` — that `|luminance(--surface-1) − luminance(--surface-0)|` is at least your chosen floor. Reuse the existing `luminance()` and `declarationsIn()` helpers; do not add a second copy. Comment *why* the metric differs from the dark blocks' ratio floor, including the numbers above, so the next reader does not "unify" the two tests and reintroduce the mistake this task exists to correct.

- [ ] **Step 2: Confirm it passes, then discriminate**

Run: `npm test -- tokens`
Expected: PASS against the current values — this task is closing a coverage hole, not fixing a defect, so a pass here is correct.

Then prove it discriminates: set the light `--surface-1` equal to `--surface-0`, and separately one hex unit apart, and confirm your new assertion fails in **both** cases where the existing distinct-values test only catches the first. Restore. Report both observed results, and report the actual separation figures for both light blocks.

- [ ] **Step 3: Commit**

```bash
git add src/theme/tokens.test.ts
git commit -m "test: cover the light themes' zebra with the metric that suits a light surface"
```

---

### Task 6: housekeeping

**Files:**
- Modify: `src/index.css`, `src/components/Pane.tsx`, `src/layout/usePaneLayout.test.ts`

**Interfaces:** none.

Four small items, each independently justified. Do them in one commit.

1. **Scope Tailwind's content detection.** `.max-w-88` still ships in the bundle because Tailwind scans `docs/design/plans/*.md`, which quote the old class name in prose. Add an explicit `@source` for `src` in `src/index.css`. The dead rule is trivial; the real problem is that "grep the built CSS for the class" — a verification method phase 2b relied on — cannot currently distinguish a class used in source from one merely mentioned in a document. Confirm after the change that `.max-w-88` is gone from `dist/assets/*.css` and `.max-w-cell` remains.
2. **`Pane`'s trailing space.** `${className ?? ""}` leaves a trailing space in the class list. Harmless, one line.
3. **`usePaneLayout.test.ts` has no `beforeEach` reset**, relying on individual tests calling `removeItem`. Add one, so a future test cannot inherit another's stored layout.
4. **The corruption-repair test is an idempotence check.** `expect(layout.widths.fleet).toBe(clampWidth("fleet", layout.widths.fleet))` holds for *any* in-bounds value, so a defaults mixup returning schema's 320 for fleet would pass. Assert the actual default instead.

- [ ] **Step 1: Make all four changes, then verify**

Run: `npm test`, `npm run build`
Then confirm item 1 from the built output as described, and item 4 by mutating `readLayout` to return the wrong pane's default and watching that test fail. Report both.

- [ ] **Step 2: Commit**

```bash
git add src/index.css src/components/Pane.tsx src/layout/usePaneLayout.test.ts
git commit -m "chore: scope Tailwind's sources, and close three small test and class-list gaps"
```

---

## Carried forward to phase 3b

- The keyboard map as one piece: `⌘K` palette, `⌘⏎`/`Esc` for the SQL bar, arrow-key cell navigation, and `tabIndex={-1}` on the grid's controls. Phase 2a made every identifier and chevron a native tab stop, so reaching "Load more" on a 100-row table takes ~200 presses. Task 2's `aria-controls` work is a prerequisite, not a substitute.
- `CommandPalette.tsx` over canisters, tables and recent queries.
- CodeMirror `SqlEditor.tsx` with schema-derived completion and the `ORDER BY` assist for icydb's `E5`.
- Arrays as `N items` when collapsed — only the expanded half exists.
- The `tokens-only` namespace-typo gap: `bg-surfce-1` and `max-w-celll` still pass, because a typo in the leading segment reads as one of Tailwind's own utilities. A compile-based check would close it and subsume the file's other class-shape heuristics.
- Whether the SQL bar's height should be draggable and persisted; it is currently a fixed third.
- Settling the `cqw`-with-no-container question against WKWebView, and recording the answer in `README.md`.
