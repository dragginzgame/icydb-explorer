# UI redesign phase 2a — data presentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make row data readable — bounded cells that clip instead of shoving columns off-screen, expand-in-place for structured values, arrays one item per line, elided identifiers you can click to copy, and skeleton rows instead of the words "Loading rows…".

**Architecture:** Cell content gets a capped width so `truncate` finally engages, which bounds a `table-auto` column without needing to compute widths. Expansion state moves up to `RowGrid`, because only it owns the `<tr>` and so only it can render a sub-row spanning every column. Identifier elision and clipboard access become their own small units, since the tree, the grid and phase 3's palette all need them.

**Tech Stack:** React 19, Tailwind 4 with the phase-1 token layer, TypeScript, Vitest with `fireEvent` (no `user-event` in this repo), Vitest globals enabled.

**Spec:** `docs/design/2026-07-31-ui-redesign.md` — read its "Data presentation" and "States" sections before Task 1.

**This is phase 2a of two.** Phase 2b does the layout: four panes, the schema right-inspector, resizing, and error states anchored per-pane. **Do not touch layout here** — no pane restructuring, no `App.tsx` composition changes. The two are independent by design and 2b is planned after this ships.

## Global Constraints

- **Frontend only.** No Rust change, no new Tauri command, no new network call site. `cd src-tauri && cargo test` must stay at **126 passing** — that is the proof.
- **No layout restructuring.** Pane structure and scroll ownership are phase 2b's. This phase changes what a cell renders, not where the panes are.
- **A literal colour is a defect.** Only `src/theme/tokens.css` may contain hex, `rgb(`, `hsl(`, or the modern colour functions. Tailwind's built-in palette (`text-gray-500`, `bg-amber-50`…) is equally forbidden — it ignores `data-theme`. `src/components/tokens-only.test.ts` enforces this across every component. The permitted colour utilities are: `bg-surface-0/1/2/inset`, `text-text-1/2/3`, `border-rule`, `border-rule-strong`, `text-accent`, `bg-sel-bg`, `text-sel-text`, `text-pk`, and the `danger`/`warn` trios. Radii: `rounded-control`, `rounded-row`. Fonts: `font-ui`, `font-mono`, `font-prose`.
- **Any element with `bg-sel-bg` must also carry `text-sel-text`.** Terminal inverts selection (dark text on a moss fill) while the other themes use ordinary text on a tint, so an unpaired `bg-sel-bg` is illegible in Terminal only. Task 1 fixes the guard that is supposed to enforce this.
- **Tests may not import Node builtins.** There is no `@types/node` and `tsconfig.json`'s `types` is `["vitest/globals"]`, so `node:fs`/`node:path`/`process.cwd()` pass under Vitest but fail the `tsc` step of `npm run build`. Read a file with Vite's `?raw` and list files with `import.meta.glob`.
- **No new dependency**, JS or Rust. In particular **no clipboard plugin** — Task 2 explains how copy works without one.
- **No user-facing copy may claim the app enforces read-only access as a security boundary.**
- Test idiom: bare top-level `test(...)`, nothing imported from `vitest`, `fireEvent` from `@testing-library/react`.
- Suites at the start of this phase: **119 frontend passing, 126 backend passing**, `npm run build` clean.

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/tokens-only.test.ts` | Task 1 widens the `bg-sel-bg` guard so it sees all three call sites |
| `src/lib/copyText.ts` *(new)* | Copy to clipboard with a fallback, no plugin |
| `src/lib/copyText.test.ts` *(new)* | Both paths, and the both-fail case |
| `src/lib/elide.ts` *(new)* | Head-and-tail elision at a group boundary — pure, so it is table-testable |
| `src/lib/elide.test.ts` *(new)* | Real principals and ULIDs |
| `src/components/Identifier.tsx` *(new)* | Elided identifier, full value in `title`, click to copy |
| `src/components/Identifier.test.tsx` *(new)* | Elision, title, copy, copied-state |
| `src/components/ValueCell.tsx` | Presentational: kind routing, capped width, expand affordance. **Stops owning expansion state.** |
| `src/components/RowGrid.tsx` | Owns expansion state, renders the spanning sub-row, zebra rows, skeleton rows |

`src/lib/` is a new directory. These two helpers are not components and not theme code, and phase 3's palette will use `copyText` too.

---

## Task 1: Widen the selection guard so it sees every call site

**Files:**
- Modify: `src/components/tokens-only.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This is a test-only fix, carried over from phase 1's final review.

**Why.** The guard asserting that `bg-sel-bg` is always paired with `text-sel-text` uses this pattern:

```js
/class(?:Name)?=\{?["`][^"`]*\bbg-sel-bg\b[^"`]*["`]/g
```

Its `[^"`]*` window excludes both `"` and a backtick. Two of the three call sites write the class inside a template literal with a nested double-quoted ternary — `` className={`… ${isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"}`} `` — so the window terminates at the `"` **before** `bg-sel-bg` and never reaches it. Measured: `CanisterTree.tsx` 0 matches, `TableList.tsx` 0, `SettingsMenu.tsx` 1.

Demonstrated consequence: dropping `text-sel-text` from `CanisterTree.tsx` leaves the whole suite green, while a selected canister row in Terminal renders `--text-1` on `--sel-bg` at **1.69:1** — illegible.

- [ ] **Step 1: Prove the current guard is blind**

Temporarily remove `text-sel-text` from `CanisterTree.tsx`'s selected-row class, run `npm test`, and confirm it **passes** — 119 green with a real regression present. Note the result, then restore the class. This is the failure you are fixing; see it before you fix it.

- [ ] **Step 2: Widen the guard**

Replace the guard test's body. Rather than a quote-delimited window, scan the whole `className={…}` expression by balancing braces from `className=`:

```ts
/// Terminal inverts selection — dark text on a moss fill — while the other two
/// themes use ordinary text on a tint. So a `bg-sel-bg` without `text-sel-text`
/// is illegible in Terminal only, and no token-parity test can see it.
///
/// The window is the whole `className={…}` expression, not a quote-delimited
/// run: two of the three call sites write the class inside a template literal
/// with a nested double-quoted ternary, and a `[^"`]*` window terminates at the
/// quote *before* the class it is looking for. That blindness shipped once.
test.each(sources)("$name pairs bg-sel-bg with text-sel-text", ({ source }) => {
  const unpaired: string[] = [];
  const attribute = /class(?:Name)?=/g;
  let match: RegExpExecArray | null;

  while ((match = attribute.exec(source)) !== null) {
    const start = match.index + match[0].length;
    // Either `className={...}` (balanced braces) or `className="..."`.
    let expression: string;
    if (source[start] === "{") {
      let depth = 0;
      let index = start;
      do {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") depth -= 1;
        index += 1;
      } while (depth > 0 && index < source.length);
      expression = source.slice(start, index);
    } else {
      const quote = source[start];
      const end = source.indexOf(quote, start + 1);
      expression = source.slice(start, end === -1 ? source.length : end + 1);
    }
    if (/\bbg-sel-bg\b/.test(expression) && !/\btext-sel-text\b/.test(expression)) {
      unpaired.push(expression.replace(/\s+/g, " ").slice(0, 120));
    }
  }

  expect(unpaired).toEqual([]);
});
```

- [ ] **Step 3: Verify it now sees all three sites**

Repeat Step 1's mutation — remove `text-sel-text` from `CanisterTree.tsx` — and confirm the suite now goes **red**, naming `CanisterTree.tsx`. Then restore it and repeat for `TableList.tsx`, confirming red again. Both must fail; the old guard caught neither. Report both results, then restore.

- [ ] **Step 4: Confirm no false positives**

Run `npm test`. Expected: **119 passing** with the guard green against the correct current sources. If it flags a site that *is* correctly paired, the brace-balancing is wrong — stop and report rather than loosening the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/components/tokens-only.test.ts
git commit -m "test: widen the selection guard to see template-literal classNames"
```

---

## Task 2: Copying to the clipboard, without a plugin

**Files:**
- Create: `src/lib/copyText.ts`
- Create: `src/lib/copyText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `copyText(text: string): Promise<boolean>` — resolves `true` if the text was copied, `false` if every route failed. It never throws.

**Why a fallback rather than `navigator.clipboard` alone.** `navigator.clipboard` needs a secure context and transient user activation, and its behaviour in a Tauri webview varies by platform — Tauri ships an entire `tauri-plugin-clipboard-manager` precisely because of this. Adding that plugin would mean a new Rust dependency, a new JS dependency and a capability entry, for one small feature. So: try the modern API, and fall back to a hidden `<textarea>` plus `document.execCommand("copy")`, which is deprecated but works in every webview and needs nothing.

**I have not verified which route the real Tauri webview takes.** The fallback exists because I could not. Task 5's manual check is where that gets observed.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/copyText.test.ts`. Note jsdom implements neither `navigator.clipboard` nor `execCommand`, so both must be stubbed — and the stubs must be restored in `finally` so a failing assertion cannot cascade into later tests.

```ts
import { copyText } from "./copyText";

function withClipboard(writeText: (text: string) => Promise<void>, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return run().finally(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
  });
}

test("uses the clipboard API when it works", async () => {
  const seen: string[] = [];
  await withClipboard(
    async (text) => {
      seen.push(text);
    },
    async () => {
      expect(await copyText("bg33z-ib5mx")).toBe(true);
    },
  );
  expect(seen).toEqual(["bg33z-ib5mx"]);
});

/// The whole reason the fallback exists: the modern API is present but refuses,
/// which is what a webview without a secure context or user activation does.
test("falls back to execCommand when the clipboard API rejects", async () => {
  const original = document.execCommand;
  const calls: string[] = [];
  document.execCommand = ((command: string) => {
    calls.push(command);
    return true;
  }) as typeof document.execCommand;
  try {
    await withClipboard(
      () => Promise.reject(new Error("denied")),
      async () => {
        expect(await copyText("fallback me")).toBe(true);
      },
    );
    expect(calls).toEqual(["copy"]);
  } finally {
    document.execCommand = original;
  }
});

test("falls back when the clipboard API is absent entirely", async () => {
  const original = document.execCommand;
  document.execCommand = (() => true) as typeof document.execCommand;
  try {
    expect(await copyText("no clipboard here")).toBe(true);
  } finally {
    document.execCommand = original;
  }
});

/// Reporting failure honestly matters: the caller shows a "Copied" confirmation,
/// and confirming a copy that did not happen is worse than saying nothing.
test("reports false when every route fails, without throwing", async () => {
  const original = document.execCommand;
  document.execCommand = (() => {
    throw new Error("not implemented");
  }) as typeof document.execCommand;
  try {
    await withClipboard(
      () => Promise.reject(new Error("denied")),
      async () => {
        expect(await copyText("nope")).toBe(false);
      },
    );
  } finally {
    document.execCommand = original;
  }
});

test("leaves no textarea behind after the fallback runs", async () => {
  const original = document.execCommand;
  document.execCommand = (() => true) as typeof document.execCommand;
  try {
    await copyText("tidy up");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  } finally {
    document.execCommand = original;
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- copyText`
Expected: FAIL — cannot resolve `./copyText`.

- [ ] **Step 3: Implement it**

Create `src/lib/copyText.ts`:

```ts
/**
 * Copies `text`, resolving `true` only if it actually landed.
 *
 * Two routes, because neither is sufficient alone. `navigator.clipboard`
 * requires a secure context and transient user activation, and its behaviour in
 * a Tauri webview varies by platform — Tauri ships a whole clipboard plugin
 * because of this. Rather than take that dependency for one feature, this falls
 * back to a hidden textarea plus the deprecated `execCommand("copy")`, which
 * works in every webview and needs nothing.
 *
 * Never throws. The caller shows a "Copied" confirmation, so a route that
 * silently failed must report `false` rather than let the UI lie.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present but refused — fall through to the textarea route below.
  }

  let area: HTMLTextAreaElement | undefined;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen rather than hidden: a `display: none` textarea cannot be
    // selected, so the copy would silently do nothing.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area?.remove();
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- copyText`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copyText.ts src/lib/copyText.test.ts
git commit -m "feat: copy to clipboard with a no-dependency fallback"
```

---

## Task 3: Identifier elision

**Files:**
- Create: `src/lib/elide.ts`
- Create: `src/lib/elide.test.ts`
- Create: `src/components/Identifier.tsx`
- Create: `src/components/Identifier.test.tsx`

**Interfaces:**
- Consumes: `copyText` from `../lib/copyText` (Task 2).
- Produces:
  - `elide(value: string, max?: number): string` — pure, default `max` 24.
  - `Identifier` with props `{ value: string; className?: string }`.

**The elision rule.** Keep both ends recognisable, and never split inside a group. A principal is dash-separated groups of five, so with four or more groups keep the first two and last two: `bg33z-ib5mx-n4nvu-…-syrrd-acfnn-iqe` becomes `bg33z-ib5mx…acfnn-iqe`. A ULID has no separators, so fall back to a character split: 8 from the head, 4 from the tail. Values at or under `max` are returned untouched.

- [ ] **Step 1: Write the failing tests for `elide`**

Create `src/lib/elide.test.ts`. The values are real — a toko principal, a toko ULID, a canister id.

```ts
import { elide } from "./elide";

test("leaves a short value untouched", () => {
  expect(elide("aaaaa-aa")).toBe("aaaaa-aa");
});

test("keeps the first and last two groups of a principal", () => {
  const principal = "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe";
  expect(elide(principal)).toBe("bg33z-ib5mx…acfnn-iqe");
});

/// Both ends must stay recognisable: two principals often share a prefix, and
/// canister ids differ in the middle, so a head-only elision would make
/// distinct ids look identical.
test("keeps both ends of a canister id", () => {
  expect(elide("jx2ua-6t777-77774-qaaeq-cai")).toBe("jx2ua-6t777…qaaeq-cai");
});

test("splits on characters when there are no groups to keep", () => {
  expect(elide("01KYVVPD156GJG000000000001")).toBe("01KYVVPD…0001");
});

test("never splits inside a group", () => {
  const elided = elide("bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe");
  for (const group of elided.replace("…", "-").split("-")) {
    expect(group.length).toBeGreaterThan(0);
  }
  expect(elided.startsWith("bg33z-ib5mx")).toBe(true);
  expect(elided.endsWith("acfnn-iqe")).toBe(true);
});

test("respects an explicit max", () => {
  expect(elide("bg33z-ib5mx-n4nvu-xkuul", 100)).toBe("bg33z-ib5mx-n4nvu-xkuul");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- elide`
Expected: FAIL — cannot resolve `./elide`.

- [ ] **Step 3: Implement `elide`**

Create `src/lib/elide.ts`:

```ts
/**
 * Shortens a long identifier while keeping both ends recognisable.
 *
 * Both ends matter: principals frequently share a prefix and canister ids
 * differ in the middle, so a head-only elision would render distinct values
 * identically. Groups are never split — a partial group reads as a different
 * identifier rather than a shortened one.
 *
 * Dash-separated values (principals, canister ids) keep their first and last
 * two groups. Values with no separators (ULIDs, hex digests) fall back to a
 * character split. The full value is always available to the caller, which is
 * why `Identifier` puts it in `title` and copies it on click — this function is
 * for display only and is deliberately lossy.
 */
export function elide(value: string, max = 24): string {
  if (value.length <= max) return value;

  const groups = value.split("-");
  if (groups.length >= 4) {
    return `${groups[0]}-${groups[1]}…${groups[groups.length - 2]}-${groups[groups.length - 1]}`;
  }

  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- elide`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing tests for `Identifier`**

Create `src/components/Identifier.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { Identifier } from "./Identifier";

const PRINCIPAL = "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe";

beforeEach(() => {
  document.execCommand = (() => true) as typeof document.execCommand;
});

test("shows the elided value but exposes the full one", () => {
  render(<Identifier value={PRINCIPAL} />);
  const element = screen.getByRole("button");
  expect(element).toHaveTextContent("bg33z-ib5mx…acfnn-iqe");
  expect(element).toHaveAttribute("title", PRINCIPAL);
});

/// The elided text is lossy on purpose, so copying must yield the original —
/// copying what is on screen would hand the user a broken identifier.
test("copies the full value, not the elided one", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(copied).toEqual([PRINCIPAL]));
});

test("confirms after a successful copy", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  expect(await screen.findByText(/copied/i)).toBeInTheDocument();
});

/// Confirming a copy that did not happen is worse than saying nothing.
test("does not claim success when the copy failed", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: () => Promise.reject(new Error("denied")),
    },
    configurable: true,
  });
  document.execCommand = (() => false) as typeof document.execCommand;

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(screen.queryByText(/copied/i)).toBeNull());
});

test("leaves a short value unelided", () => {
  render(<Identifier value="aaaaa-aa" />);
  expect(screen.getByRole("button")).toHaveTextContent("aaaaa-aa");
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm test -- Identifier`
Expected: FAIL — cannot resolve `./Identifier`.

- [ ] **Step 7: Implement `Identifier`**

Create `src/components/Identifier.tsx`:

```tsx
import { useState } from "react";

import { copyText } from "../lib/copyText";
import { elide } from "../lib/elide";

/** An identifier shown elided, with the full value in `title` and copied on
 *  click.
 *
 *  A button rather than a span because it is genuinely actionable, which also
 *  makes it keyboard-reachable and gives it the global `:focus-visible` ring for
 *  free. `text-pk` marks it as identifier-shaped, matching `ValueCell`.
 *
 *  The confirmation only appears when the copy actually succeeded — `copyText`
 *  reports failure rather than throwing, and claiming success falsely would be
 *  worse than showing nothing. */
export function Identifier({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className={`font-mono text-xs text-pk ${className ?? ""}`}
    >
      {elide(value)}
      {copied && <span className="ml-1 not-italic text-text-3">copied</span>}
    </button>
  );
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `npm test -- Identifier` then `npm test`
Expected: PASS. Report the actual total.

- [ ] **Step 9: Commit**

```bash
git add src/lib/elide.ts src/lib/elide.test.ts src/components/Identifier.tsx src/components/Identifier.test.tsx
git commit -m "feat: add identifier elision with click-to-copy"
```

---

## Task 4: A bounded, presentational `ValueCell`

**Files:**
- Modify: `src/components/ValueCell.tsx`
- Modify: `src/components/ValueCell.test.tsx`

**Interfaces:**
- Consumes: `Identifier` (Task 3).
- Produces:
  - `formatExpanded(display: string): string` — exported for testing.
  - `ValueCell` with props `{ value: ValueDto; expanded?: boolean; onToggle?: () => void }`.
  - `isExpandable(value: ValueDto): boolean` — exported, so `RowGrid` can decide whether a cell has a sub-row without duplicating the rule.

**The central change.** Today's `ValueCell` has `truncate` on an unbounded box, so it never clips: a `table-auto` column grows to its content and one structured value shoves every later column off-screen. Capping the *content* width bounds the column without computing widths — short columns stay narrow, long ones clip.

**Expansion state moves out.** `ValueCell` stops owning it. Only `RowGrid` owns the `<tr>`, so only `RowGrid` can render a sub-row spanning every column, which is what the spec requires ("expansion is a sub-row, spanning all columns — not a tooltip, not a modal"). `ValueCell` renders the chevron and reports the click.

- [ ] **Step 1: Write the failing tests**

Replace `src/components/ValueCell.test.tsx`. Keep the four existing tests — they still describe correct behaviour — and add the rest.

```tsx
import { render, screen, fireEvent } from "@testing-library/react";

import { ValueCell, formatExpanded, isExpandable } from "./ValueCell";

const STRUCTURED =
  '{name: "Rem", socials: {github: "rem-code-s", bluesky: null}, tags: ["red", "primary"]}';

test("renders a text value verbatim", () => {
  render(<ValueCell value={{ kind: "text", display: "hello" }} />);
  expect(screen.getByText("hello")).toBeDefined();
});

test("renders null as a visible placeholder rather than empty space", () => {
  render(<ValueCell value={{ kind: "null", display: "" }} />);
  expect(screen.getByText("null")).toBeDefined();
});

test("right-aligns numeric kinds", () => {
  const { container } = render(<ValueCell value={{ kind: "nat", display: "42" }} />);
  expect(container.firstChild).toHaveClass("text-right");
});

/// Identifier kinds route through `Identifier`, which is what makes them
/// elided, copyable, and keyboard-reachable.
test("renders principals through Identifier", () => {
  render(<ValueCell value={{ kind: "principal", display: "aaaaa-aa-bbbbb-bb-ccccc-cc-ddddd" }} />);
  expect(screen.getByRole("button")).toBeInTheDocument();
});

test("a short value needs no expand affordance", () => {
  render(<ValueCell value={{ kind: "text", display: "short" }} />);
  expect(screen.queryByRole("button", { name: /expand|collapse/i })).toBeNull();
});

test("a long value offers an expand affordance and reports the click", () => {
  const onToggle = vi.fn();
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={onToggle} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));
  expect(onToggle).toHaveBeenCalled();
});

test("the affordance reflects the expanded state", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} expanded onToggle={vi.fn()} />);
  expect(screen.getByRole("button", { name: /collapse/i })).toBeInTheDocument();
});

/// Clipped text still has to be reachable without expanding.
test("a clipped value exposes its full text in title", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={vi.fn()} />);
  expect(screen.getByTitle(STRUCTURED)).toBeInTheDocument();
});

test("isExpandable is true only for values that would clip", () => {
  expect(isExpandable({ kind: "map", display: STRUCTURED })).toBe(true);
  expect(isExpandable({ kind: "text", display: "short" })).toBe(false);
  expect(isExpandable({ kind: "null", display: "" })).toBe(false);
});

/// Arrays read one item per line — a truncated bracket soup tells the reader
/// nothing, which is the complaint that started this phase.
test("formatExpanded puts each array item on its own line", () => {
  const lines = formatExpanded('["red", "primary", "blue"]').split("\n");
  expect(lines.filter((line) => line.includes("red"))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("primary"))).toHaveLength(1);
  expect(lines.some((line) => line.includes("red") && line.includes("primary"))).toBe(false);
});

test("formatExpanded indents by nesting depth", () => {
  const output = formatExpanded('{a: 1, b: {c: 2}}');
  const cLine = output.split("\n").find((line) => line.includes("c:")) ?? "";
  const aLine = output.split("\n").find((line) => line.includes("a:")) ?? "";
  expect(cLine.length - cLine.trimStart().length).toBeGreaterThan(
    aLine.length - aLine.trimStart().length,
  );
});

/// Lossy formatting would be a bug: the reader is expanding precisely because
/// they want the whole value.
test("formatExpanded preserves every non-whitespace character", () => {
  const strip = (text: string) => text.replace(/\s/g, "");
  expect(strip(formatExpanded(STRUCTURED))).toBe(strip(STRUCTURED));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- ValueCell`
Expected: FAIL — `formatExpanded` and `isExpandable` are not exported.

- [ ] **Step 3: Rewrite `ValueCell`**

Replace `src/components/ValueCell.tsx`:

```tsx
import type { ValueDto } from "../api/types";

import { Identifier } from "./Identifier";

// Numeric kinds get right-aligned, tabular-figure rendering so columns of
// numbers line up. Kept in sync with `OutputValue`'s numeric variants in
// `src-tauri/src/view/value.rs`.
const NUMERIC_KINDS = new Set([
  "int",
  "int128",
  "intbig",
  "nat",
  "nat128",
  "natbig",
  "float32",
  "float64",
  "decimal",
]);

// Identifier-shaped kinds route through `Identifier`: elided, copyable, and
// monospace so runs of base32 stay aligned.
const IDENTIFIER_KINDS = new Set(["principal", "ulid", "subaccount", "account", "blob"]);

// Above this many characters a value clips and gains an expand affordance.
// A length threshold rather than a measured overflow check: it needs no ref, no
// layout pass and no per-kind taxonomy, so it behaves identically in tests and
// in the app. A structured value runs to hundreds of characters, so the exact
// cutoff is not delicate.
const CLIP_AFTER = 48;

/** Whether this value would clip, and so warrants an expand affordance and a
 *  sub-row. Exported so `RowGrid` decides the same way this component does,
 *  rather than duplicating the rule and drifting from it. */
export function isExpandable(value: ValueDto): boolean {
  if (value.kind === "null" || NUMERIC_KINDS.has(value.kind)) return false;
  if (IDENTIFIER_KINDS.has(value.kind)) return false;
  return value.display.length > CLIP_AFTER;
}

/**
 * Re-indents a long value for the expanded view, purely on bracket depth.
 *
 * Deliberately content-agnostic. The `display` string is produced by icydb's own
 * renderer, not by this app, so parsing it semantically would couple the
 * frontend to an icydb-internal format — exactly the coupling
 * `src-tauri/src/view/` exists to contain. Splitting on brackets and commas
 * needs no knowledge of that format and cannot break when it changes.
 *
 * The trade-off: a text value containing a brace or comma is split there too.
 * That is a cosmetic oddity, never a loss — every character survives, in order,
 * which `formatExpanded preserves every non-whitespace character` pins.
 */
export function formatExpanded(display: string): string {
  const out: string[] = [];
  let depth = 0;
  let swallowSpace = false;

  for (const character of display) {
    if (swallowSpace) {
      swallowSpace = false;
      // The separator space after a comma would otherwise land as leading
      // whitespace on the next line, on top of the indent.
      if (character === " ") continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      out.push(character, "\n", "  ".repeat(depth));
      swallowSpace = true;
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      out.push("\n", "  ".repeat(depth), character);
    } else if (character === ",") {
      out.push(",", "\n", "  ".repeat(depth));
      swallowSpace = true;
    } else {
      out.push(character);
    }
  }

  return out.join("");
}

/** One table cell.
 *
 *  Presentational: it renders the chevron and reports the click, but does not
 *  own the expanded flag. `RowGrid` does, because only `RowGrid` owns the `<tr>`
 *  and so only it can render a sub-row spanning every column — which is what
 *  expansion is, rather than a tooltip or a modal. */
export function ValueCell({
  value,
  expanded = false,
  onToggle,
}: {
  value: ValueDto;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { kind, display } = value;

  if (kind === "null") {
    return <div className="italic text-text-3">null</div>;
  }

  if (NUMERIC_KINDS.has(kind)) {
    return <div className="text-right tabular-nums">{display}</div>;
  }

  if (IDENTIFIER_KINDS.has(kind)) {
    return <Identifier value={display} />;
  }

  if (!isExpandable(value) || !onToggle) {
    return <div className="max-w-88 truncate">{display}</div>;
  }

  return (
    <div className="flex max-w-88 items-start gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label={expanded ? "Collapse value" : "Expand value"}
        aria-expanded={expanded}
        className="shrink-0 rounded-row px-1 text-xs leading-5 text-text-3 hover:bg-surface-2"
      >
        {expanded ? "▾" : "▸"}
      </button>
      {/* `truncate` only clips inside a bounded box, which `max-w-88` on the
          parent and `min-w-0` here provide. Without them the cell grows to fit
          its content and shoves every later column off-screen — which is
          exactly what a structured value used to do. */}
      <div className="min-w-0 truncate" title={display}>
        {display}
      </div>
    </div>
  );
}
```

`max-w-88` is verified to compile in this project: Tailwind 4.3.3 emits `.max-w-88 { max-width: calc(var(--spacing) * 88) }`, i.e. 22rem. Use it as written — no arbitrary-value fallback is needed.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- ValueCell` then `npm test`
Expected: PASS. `RowGrid.test.tsx` may fail here — Task 5 owns `RowGrid`. If it does, note it and proceed; if any *other* pre-existing test fails, stop and report.

- [ ] **Step 5: Commit**

```bash
git add src/components/ValueCell.tsx src/components/ValueCell.test.tsx
git commit -m "feat: bound cell width and make ValueCell presentational"
```

---

## Task 5: `RowGrid` — expansion sub-rows, zebra, skeletons

**Files:**
- Modify: `src/components/RowGrid.tsx`
- Modify: `src/components/RowGrid.test.tsx`

**Interfaces:**
- Consumes: `ValueCell`, `isExpandable` (Task 4).
- Produces: `RowGrid` gains an optional `loading?: boolean` prop. Its existing `rows`/`hasMore`/`onLoadMore` props are unchanged, so `App.tsx` needs no edit in this phase.

- [ ] **Step 1: Write the failing tests**

Extend `src/components/RowGrid.test.tsx`, keeping its four existing tests.

```tsx
const STRUCTURED =
  '{name: "Rem", socials: {github: "rem-code-s", bluesky: null}, tags: ["red", "primary"]}';

const wide = {
  entity: "User",
  columns: ["id", "profile"],
  rows: [
    [
      { kind: "ulid", display: "01KYVVPD156GJG000000000001" },
      { kind: "map", display: STRUCTURED },
    ],
  ],
  rowCount: 1,
  nextCursor: null,
};

test("expanding a cell opens a sub-row spanning every column", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));

  const spanning = document.querySelector("td[colspan]");
  expect(spanning).not.toBeNull();
  expect(spanning?.getAttribute("colspan")).toBe("2");
});

test("collapsing removes the sub-row", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));
  fireEvent.click(screen.getByRole("button", { name: /collapse/i }));

  expect(document.querySelector("td[colspan]")).toBeNull();
});

/// One cell at a time: two open sub-rows in a wide table push the row you were
/// reading off-screen.
test("expanding a second cell closes the first", () => {
  const twoWide = {
    ...wide,
    rows: [
      [
        { kind: "map", display: STRUCTURED },
        { kind: "map", display: `${STRUCTURED} ` },
      ],
    ],
  };
  render(<RowGrid rows={twoWide} hasMore={false} onLoadMore={() => {}} />);

  const [first, second] = screen.getAllByRole("button", { name: /expand/i });
  fireEvent.click(first);
  fireEvent.click(second);

  expect(document.querySelectorAll("td[colspan]")).toHaveLength(1);
});

/// Skeletons keep the column count so the grid does not reflow when data lands.
test("loading renders skeleton rows at the known column count", () => {
  render(
    <RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} loading />,
  );

  // The requirement is that skeletons carry the REAL column count, so the grid
  // does not reflow when data lands. A bare "more than zero" would pass for a
  // single placeholder cell and test nothing about reflow.
  const skeletonRows = [...document.querySelectorAll("tbody tr")];
  expect(skeletonRows.length).toBeGreaterThan(1);
  for (const row of skeletonRows) {
    expect(row.querySelectorAll('[data-skeleton="true"]')).toHaveLength(wide.columns.length);
  }
  expect(screen.queryByText(/no rows/i)).toBeNull();
});

/// "No rows" and "still loading" are different states and must not be confused.
test("an empty result is not mistaken for loading", () => {
  render(<RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText(/no rows/i)).toBeInTheDocument();
  expect(document.querySelectorAll('[data-skeleton="true"]')).toHaveLength(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- RowGrid`
Expected: FAIL — no `colspan` sub-row, no `loading` prop.

- [ ] **Step 3: Rewrite `RowGrid`**

Replace `src/components/RowGrid.tsx`:

```tsx
import { useState } from "react";

import type { RowsDto } from "../api/types";

import { ValueCell, formatExpanded, isExpandable } from "./ValueCell";

// Enough rows to fill the pane without implying a page size we do not know.
const SKELETON_ROWS = 8;

/** Which cell is expanded, if any. One at a time: two open sub-rows in a wide
 *  table push the row you were reading off-screen. */
type Expanded = { row: number; column: number } | null;

// `hasMore` is a prop, not something this component derives: scalar paging
// is LIMIT/OFFSET, and only the caller — which knows the requested page size
// and current offset — can tell whether another page may exist. That keeps
// this component a dumb, trivially testable renderer.
export function RowGrid({
  rows,
  hasMore,
  onLoadMore,
  loading = false,
}: {
  rows: RowsDto;
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState<Expanded>(null);

  const toggle = (row: number, column: number) =>
    setExpanded((current) =>
      current && current.row === row && current.column === column ? null : { row, column },
    );

  // Loading and empty are different states. Skeletons carry the real column
  // count so the grid does not reflow when data lands.
  if (loading && rows.rows.length === 0) {
    return (
      <table className="min-w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-surface-inset">
          <tr>
            {rows.columns.map((column) => (
              <th
                key={column}
                className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
            <tr key={rowIndex} className="border-b border-rule">
              {rows.columns.map((column) => (
                <td key={column} className="px-2 py-1">
                  <div
                    data-skeleton="true"
                    aria-hidden="true"
                    className="h-3 w-24 rounded-row bg-surface-2"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (rows.rows.length === 0) {
    return <p className="p-4 text-sm text-text-3">No rows</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-surface-inset">
            <tr>
              {rows.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((row, rowIndex) => {
              const openColumn =
                expanded && expanded.row === rowIndex ? expanded.column : null;
              return (
                // eslint-disable-next-line react/no-array-index-key
                <ExpandableRow
                  key={rowIndex}
                  row={row}
                  rowIndex={rowIndex}
                  openColumn={openColumn}
                  onToggle={toggle}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          className="self-start rounded-control border border-rule px-3 py-1 text-sm hover:bg-surface-2"
        >
          Load more
        </button>
      )}
    </div>
  );
}

/** One data row plus, when a cell is expanded, the sub-row beneath it.
 *
 *  Split out because a row renders as two sibling `<tr>`s, which a `.map` in the
 *  parent cannot express without a fragment per row — and the fragment would
 *  need the key, obscuring which element it belongs to. */
function ExpandableRow({
  row,
  rowIndex,
  openColumn,
  onToggle,
}: {
  row: RowsDto["rows"][number];
  rowIndex: number;
  openColumn: number | null;
  onToggle: (row: number, column: number) => void;
}) {
  return (
    <>
      {/* Zebra on `surface-1`, not `surface-inset`: the sticky header uses
          `surface-inset`, so zebra there would make every other data row the
          same colour as the header and defeat both cues at once. */}
      <tr className="border-b border-rule odd:bg-surface-1">
        {row.map((cell, columnIndex) => (
          // eslint-disable-next-line react/no-array-index-key
          <td key={columnIndex} className="px-2 py-1 align-top">
            <ValueCell
              value={cell}
              expanded={openColumn === columnIndex}
              onToggle={
                isExpandable(cell) ? () => onToggle(rowIndex, columnIndex) : undefined
              }
            />
          </td>
        ))}
      </tr>
      {openColumn !== null && (
        <tr className="border-b border-rule">
          <td colSpan={row.length} className="bg-surface-2 px-2 py-2 pl-8">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-2">
              {formatExpanded(row[openColumn].display)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run everything**

Run: `npm test` — report the actual total.
Run: `npm run build` — expected success.
Run: `cd src-tauri && cargo test` — expected **126 passing**, proving the frontend-only constraint held.

- [ ] **Step 5: Verify the bounded column actually bounds — by eye**

No test can confirm this; it is a layout property. Run the app:

```bash
npm run tauri dev
```

Open a project, select a table with a `structured` column — toko's `user_shard` → `User` is the case that started this phase, its `profile` column being the offender. Confirm:

1. The `profile` column **clips with an ellipsis** rather than expanding, and every later column is still on screen. This is the whole point of the phase; if the column still blows out, `max-w-*` is not constraining the `table-auto` column and I want to hear that rather than have you switch the table to `table-fixed` on your own judgement.
2. Clicking the chevron opens an indented sub-row **spanning the full table width**, with the array's items on separate lines.
3. Clicking a chevron in a different cell closes the first.
4. Clicking a principal copies it — check the clipboard actually received the **full** value, not the elided one. **This is the one thing I could not verify at all:** whether the real Tauri webview satisfies `navigator.clipboard` or falls through to `execCommand`. Report which happened if you can tell, and whether the "copied" confirmation appeared.
5. Switch to Terminal via the gear and confirm the expanded sub-row and the skeletons are legible there too.

Report what you observe for each, including anything that looks wrong. Do not adjust a token to fix an appearance problem — that belongs in one deliberate place.

- [ ] **Step 6: Commit**

```bash
git add src/components/RowGrid.tsx src/components/RowGrid.test.tsx
git commit -m "feat: expand cells in place, zebra rows, and skeleton loading"
```

---

## Manual verification (after Task 5)

Beyond Task 5's step 5, one behaviour spans the phase: with the schema panel still in the middle pane (phase 2b moves it), the rows pane is narrow. Confirm the bounded columns behave sensibly at that width too — clipping earlier is correct; a horizontal scrollbar on the rows pane is acceptable; the panes themselves shifting is not.
