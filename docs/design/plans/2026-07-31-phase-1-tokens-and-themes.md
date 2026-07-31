# UI redesign phase 1 — tokens, themes, settings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a real design system — a CSS token layer, three selectable themes (Console, Terminal, Instrument), a follow-system default, and a gear menu to change it — with no layout change.

**Architecture:** One CSS file defines semantic tokens and redefines them per theme. Tailwind 4's `@theme inline` maps those tokens onto utility classes, so `bg-surface-1` compiles to `background-color: var(--surface-1)` and a runtime `data-theme` swap re-themes the whole app with no JavaScript re-render. Every component is then restyled to use only token utilities, and a test enforces that no component contains a literal colour.

**Tech Stack:** Tailwind CSS 4.3.3 (`@tailwindcss/vite`), React 19, TypeScript, Vitest with `fireEvent` (no `user-event` in this repo), Vitest globals enabled.

**Spec:** `docs/design/2026-07-31-ui-redesign.md` — read the "Architecture → The token layer" section before Task 1. This plan is **phase 1 of three**; phases 2 (layout) and 3 (power features) are planned separately, after this ships.

## Global Constraints

- **Frontend only.** No Rust change, no new Tauri command, no new network call site. If a task appears to need one, stop — the design is wrong, not the boundary.
- **No layout change in this phase.** Pane structure, scroll behaviour and the DOM shape stay exactly as they are. Colour, type, spacing tokens and the gear menu only. Moving the schema panel is phase 2.
- **A literal colour in a component is a defect.** Only `src/theme/tokens.css` may contain hex, `rgb(`, or `hsl(` values. Task 4 adds the test that enforces this.
- **Every theme defines every token.** A theme missing one silently inherits another theme's value. Task 1 adds the test that enforces this.
- **Verified mechanism:** `@theme inline { --color-x: var(--x) }` makes `bg-x` emit `background-color: var(--x)`. Confirmed against the installed tailwindcss 4.3.3 by compiling it. Do **not** drop `inline` — without it the utility references `--color-x` instead, which still works but moves the switchable layer away from the semantic names this plan uses.
- **Semantic token names must not collide with Tailwind's theme namespace.** Tailwind owns `--font-*`, `--radius-*` and `--color-*` as theme keys, so the semantic tokens are named `--ui-font`, `--mono-font`, `--r-control`, `--r-row` and bridged onto Tailwind's names in `@theme inline`. Naming them `--font-ui`/`--radius-control` directly makes Tailwind emit a circular `--font-ui: var(--font-ui)` that only works by cascade accident, and would silently override Tailwind's own `font-mono` utility. Verified by compiling tailwindcss 4.3.3 both ways.
- **Tailwind 4 has no `tailwind.config.js`** in this project and must not gain one. Configuration is CSS-first, inside `src/index.css` / `src/theme/tokens.css`.
- **Existing tests must keep passing** — 39 frontend, 129 backend. They mock `./api/commands` at the module boundary, so a pure presentation change should not disturb them. If one breaks, that is a real signal, not a test to update.
- **Test idiom:** bare top-level `test(...)`, no imports from `vitest`, `fireEvent` from `@testing-library/react`, `jest-dom` matchers via the existing `vitest.setup.ts`. Do not add a testing dependency.
- **No user-facing copy may claim the app enforces read-only access as a security boundary.**

---

## File structure

| File | Responsibility |
|---|---|
| `src/theme/tokens.css` *(new)* | Every token, the three theme blocks, the follow-system media query, and the `@theme inline` bridge |
| `src/theme/tokens.test.ts` *(new)* | Theme parity: every theme defines every token |
| `src/theme/useTheme.ts` *(new)* | Preference read/write, `data-theme` application, follow-system resolution |
| `src/theme/useTheme.test.ts` *(new)* | Stored wins, absent follows system, unknown falls back |
| `src/components/SettingsMenu.tsx` *(new)* | Gear button + popover with the four theme choices |
| `src/components/SettingsMenu.test.tsx` *(new)* | Opens, closes on Esc, marks current, calls the setter |
| `src/index.css` | Imports `theme/tokens.css` after Tailwind |
| `src/components/*.tsx` (9 files) | Restyled onto token utilities |
| `src/components/tokens-only.test.ts` *(new)* | No literal colours outside the theme file |
| `src/App.tsx` | Shell restyled; gear wired into the header |

---

## Task 1: The token layer and three themes

**Files:**
- Create: `src/theme/tokens.css`
- Create: `src/theme/tokens.test.ts`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: nothing.
- Produces: the token names below. Every later task styles through these and no others.

**The complete token set.** Later tasks may not invent tokens; if one is genuinely missing, stop and report it.

| Token | Meaning |
|---|---|
| `--surface-0` | App ground, behind everything |
| `--surface-1` | Pane and header background |
| `--surface-2` | Raised: popover, menu, expanded row |
| `--surface-inset` | Recessed: grid header, status bar, editor |
| `--text-1` | Primary text |
| `--text-2` | Secondary text |
| `--text-3` | Muted: hints, metadata, `null` |
| `--rule` | Hairline divider |
| `--rule-strong` | Emphasised divider, control border |
| `--accent` | Accent text and focus ring |
| `--accent-bg` | Accent fill behind text |
| `--accent-border` | Border on accented controls |
| `--sel-bg` | Selected-row background |
| `--sel-text` | Text on a selected row — **load-bearing:** Terminal inverts selection, so this is not always `--text-1` |
| `--pk` | Primary-key / identifier emphasis |
| `--danger-text`, `--danger-bg`, `--danger-border` | Error banner |
| `--warn-text`, `--warn-bg`, `--warn-border` | Advisory notices |
| `--ui-font` | Chrome typeface — **Terminal sets this to the mono stack**, which is the whole of its character. Bridged to Tailwind's `--font-ui`, hence the different name. |
| `--mono-font` | Data typeface. Bridged to Tailwind's `--font-mono`. |
| `--r-control` | Header controls: `7px`. Bridged to Tailwind's `--radius-control`. |
| `--r-row` | Row selection: `5px`. Bridged to Tailwind's `--radius-row`. |
| `--row-h` | Row height: `24px` |

- [ ] **Step 1: Write the failing test**

Create `src/theme/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/theme/tokens.css"), "utf8");

/** Every `--token: value;` declared inside the given selector's block. */
function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) return [];
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

const BASE = ":root {";
const THEMES = [
  ':root[data-theme="console"]',
  ':root[data-theme="terminal"]',
  ':root[data-theme="instrument"]',
];
const SYSTEM_LIGHT = ":root:not([data-theme])";

test("the base :root block declares a non-trivial token set", () => {
  expect(tokensIn(BASE).length).toBeGreaterThan(20);
});

/// The failure this guards is silent: a theme that omits a token inherits the
/// previous theme's value, so it looks *almost* right and nobody notices which
/// one is wrong. Parity is the only cheap way to catch it.
test.each(THEMES)("%s declares exactly the same tokens as :root", (selector) => {
  expect(tokensIn(selector)).toEqual(tokensIn(BASE));
});

/// The follow-system light block deliberately overrides only the colour tokens,
/// inheriting fonts, radii and row height from :root — so equality is the wrong
/// assertion here. Subset still catches the failure that matters: a token name
/// typed wrongly, which would silently never apply.
test("the follow-system light block declares only tokens that exist in :root", () => {
  const base = new Set(tokensIn(BASE));
  const unknown = tokensIn(SYSTEM_LIGHT).filter((token) => !base.has(token));
  expect(unknown).toEqual([]);
});

test("the follow-system light block overrides every colour token", () => {
  const declared = new Set(tokensIn(SYSTEM_LIGHT));
  const colourish = tokensIn(BASE).filter(
    (token) => !/^--(?:ui-font|mono-font|r-control|r-row|row-h)$/.test(token),
  );
  expect(colourish.filter((token) => !declared.has(token))).toEqual([]);
});

test("only the theme file carries literal colours", () => {
  expect(/#[0-9a-f]{3,8}\b/i.test(css)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tokens`
Expected: FAIL — `ENOENT: no such file or directory … src/theme/tokens.css`.

- [ ] **Step 3: Write the token file**

Create `src/theme/tokens.css`. The `:root` block holds Console's values (the default when the OS reports dark); the media query supplies Instrument for a light OS; the three explicit blocks are what the gear menu selects.

```css
/* Semantic tokens. The one file in this project allowed to contain literal
   colours — see src/components/tokens-only.test.ts, which enforces that.

   Themes work by redefining these, never by branching in a component. That is
   why a third theme costs a block here instead of an edit everywhere. */

:root {
  --surface-0: #191a1f;
  --surface-1: #202228;
  --surface-2: #23262c;
  --surface-inset: #1d1f24;
  --text-1: #dfe1e6;
  --text-2: #c3c7cf;
  --text-3: #767c88;
  --rule: #23252b;
  --rule-strong: #2d3037;
  --accent: #a8c6ea;
  --accent-bg: #2a3340;
  --accent-border: #3d5878;
  --sel-bg: #2b3543;
  --sel-text: #dfe1e6;
  --pk: #a8c6ea;
  --danger-text: #f0a9a9;
  --danger-bg: #2c1e20;
  --danger-border: #5c3336;
  --warn-text: #e8c98a;
  --warn-bg: #2a2418;
  --warn-border: #574a2e;
  --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --r-control: 7px;
  --r-row: 5px;
  --row-h: 24px;
}

/* Follow-system, light half. No `data-theme` attribute is set in this mode, so
   these win over :root's dark defaults by virtue of the media query. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --surface-0: #fcfcfa;
    --surface-1: #f2f2ee;
    --surface-2: #fcfcfa;
    --surface-inset: #f4f4ef;
    --text-1: #1c1e1b;
    --text-2: #6f6f62;
    --text-3: #8a8a7c;
    --rule: #e3e3db;
    --rule-strong: #dcdcd4;
    --accent: #5c7a49;
    --accent-bg: #eff3ea;
    --accent-border: #9aab8f;
    --sel-bg: #e7ecdf;
    --sel-text: #1c1e1b;
    --pk: #5c7a49;
    --danger-text: #8a2f2f;
    --danger-bg: #fbeceb;
    --danger-border: #e4b4b1;
    --warn-text: #7a5a13;
    --warn-bg: #fbf3e2;
    --warn-border: #e3d0a4;
  }
}

:root[data-theme="console"] {
  --surface-0: #191a1f;
  --surface-1: #202228;
  --surface-2: #23262c;
  --surface-inset: #1d1f24;
  --text-1: #dfe1e6;
  --text-2: #c3c7cf;
  --text-3: #767c88;
  --rule: #23252b;
  --rule-strong: #2d3037;
  --accent: #a8c6ea;
  --accent-bg: #2a3340;
  --accent-border: #3d5878;
  --sel-bg: #2b3543;
  --sel-text: #dfe1e6;
  --pk: #a8c6ea;
  --danger-text: #f0a9a9;
  --danger-bg: #2c1e20;
  --danger-border: #5c3336;
  --warn-text: #e8c98a;
  --warn-bg: #2a2418;
  --warn-border: #574a2e;
  --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --r-control: 7px;
  --r-row: 5px;
  --row-h: 24px;
}

/* Terminal: monospace chrome and inverse selection. `--font-ui` pointing at the
   mono stack is the entire mechanism — no component branches on the theme. */
:root[data-theme="terminal"] {
  --surface-0: #0f1211;
  --surface-1: #0f1211;
  --surface-2: #171b1a;
  --surface-inset: #0f1211;
  --text-1: #cfd6d2;
  --text-2: #9aa5a0;
  --text-3: #5e6866;
  --rule: #1c2120;
  --rule-strong: #232927;
  --accent: #8fae5d;
  --accent-bg: #1b2113;
  --accent-border: #3c4a28;
  --sel-bg: #8fae5d;
  --sel-text: #0f1211;
  --pk: #8fae5d;
  --danger-text: #e88b8b;
  --danger-bg: #1e1413;
  --danger-border: #4a2a28;
  --warn-text: #d8b46a;
  --warn-bg: #1c1810;
  --warn-border: #453a22;
  --ui-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --mono-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --r-control: 4px;
  --r-row: 0px;
  --row-h: 24px;
}

:root[data-theme="instrument"] {
  --surface-0: #fcfcfa;
  --surface-1: #f2f2ee;
  --surface-2: #fcfcfa;
  --surface-inset: #f4f4ef;
  --text-1: #1c1e1b;
  --text-2: #6f6f62;
  --text-3: #8a8a7c;
  --rule: #e3e3db;
  --rule-strong: #dcdcd4;
  --accent: #5c7a49;
  --accent-bg: #eff3ea;
  --accent-border: #9aab8f;
  --sel-bg: #e7ecdf;
  --sel-text: #1c1e1b;
  --pk: #5c7a49;
  --danger-text: #8a2f2f;
  --danger-bg: #fbeceb;
  --danger-border: #e4b4b1;
  --warn-text: #7a5a13;
  --warn-bg: #fbf3e2;
  --warn-border: #e3d0a4;
  --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --r-control: 7px;
  --r-row: 5px;
  --row-h: 24px;
}

/* Keyboard focus. One global rule rather than per-component classes, so no
   component can forget it and every theme gets it from --accent. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* The Tailwind bridge. `inline` is load-bearing: it makes `bg-surface-1` emit
   `background-color: var(--surface-1)` — a live reference — so a runtime
   `data-theme` swap re-themes everything. Without `inline` the utility points at
   `--color-surface-1` instead, moving the switchable layer off these names.
   Verified by compiling tailwindcss 4.3.3 directly. */
@theme inline {
  --color-surface-0: var(--surface-0);
  --color-surface-1: var(--surface-1);
  --color-surface-2: var(--surface-2);
  --color-surface-inset: var(--surface-inset);
  --color-text-1: var(--text-1);
  --color-text-2: var(--text-2);
  --color-text-3: var(--text-3);
  --color-rule: var(--rule);
  --color-rule-strong: var(--rule-strong);
  --color-accent: var(--accent);
  --color-accent-bg: var(--accent-bg);
  --color-accent-border: var(--accent-border);
  --color-sel-bg: var(--sel-bg);
  --color-sel-text: var(--sel-text);
  --color-pk: var(--pk);
  --color-danger-text: var(--danger-text);
  --color-danger-bg: var(--danger-bg);
  --color-danger-border: var(--danger-border);
  --color-warn-text: var(--warn-text);
  --color-warn-bg: var(--warn-bg);
  --color-warn-border: var(--warn-border);
  --font-ui: var(--ui-font);
  --font-mono: var(--mono-font);
  --radius-control: var(--r-control);
  --radius-row: var(--r-row);
}
```

- [ ] **Step 4: Import it**

`src/index.css` becomes:

```css
@import "tailwindcss";
@import "./theme/tokens.css";
```

Order matters: Tailwind first, tokens second, so `@theme inline` is processed with Tailwind's machinery already loaded.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tokens`
Expected: PASS, 7 tests (1 base + 3 theme parity + 2 follow-system checks + 1 literal check).

Then: `npm run build`
Expected: success. This is the real proof the CSS compiles — a malformed token file fails here, not in the unit test.

- [ ] **Step 6: Commit**

```bash
git add src/theme/tokens.css src/theme/tokens.test.ts src/index.css
git commit -m "feat: add a semantic token layer with three themes"
```

---

## Task 2: The theme preference hook

**Files:**
- Create: `src/theme/useTheme.ts`
- Create: `src/theme/useTheme.test.ts`

**Interfaces:**
- Consumes: the `data-theme` values `console` / `terminal` / `instrument` from Task 1.
- Produces:
  - `type ThemeChoice = "system" | "console" | "terminal" | "instrument"`
  - `const THEME_CHOICES: readonly ThemeChoice[]`
  - `function useTheme(): { choice: ThemeChoice; setChoice: (next: ThemeChoice) => void }`
  - `const THEME_STORAGE_KEY = "icydb-explorer.theme"`

**Behaviour, exactly:**
1. A stored, recognised choice wins.
2. No stored choice means `"system"`, which sets **no** `data-theme` attribute and lets the media query in Task 1 decide.
3. An unrecognised stored value (hand-edited, or written by an older build) falls back to `"system"` rather than throwing or applying a bogus attribute.
4. `setChoice` writes storage and applies the attribute immediately.
5. A `localStorage` that throws — Safari private mode does this — must not break the app; the choice applies for the session and is simply not remembered.

- [ ] **Step 1: Write the failing tests**

Create `src/theme/useTheme.test.ts`:

```ts
import { renderHook, act } from "@testing-library/react";
import { THEME_STORAGE_KEY, useTheme } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

test("with nothing stored, the choice is system and no attribute is set", () => {
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("a stored choice wins and is applied as an attribute", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "terminal");
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("terminal");
  expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
});

/// A hand-edited or stale value must not apply a bogus attribute, which would
/// match no theme block and leave the app rendering :root's defaults while the
/// menu showed something else.
test("an unrecognised stored value falls back to system", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "solarized-pink");
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("setChoice applies the attribute and persists", () => {
  const { result } = renderHook(() => useTheme());
  act(() => result.current.setChoice("instrument"));
  expect(document.documentElement.getAttribute("data-theme")).toBe("instrument");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("instrument");
});

test("choosing system again removes the attribute", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "console");
  const { result } = renderHook(() => useTheme());
  act(() => result.current.setChoice("system"));
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

/// Storage can throw outright (Safari private browsing). Losing the preference
/// is acceptable; failing to render is not.
test("a throwing localStorage does not break theme selection", () => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error("denied");
  };
  try {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setChoice("terminal"));
    expect(result.current.choice).toBe("terminal");
    expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
  } finally {
    Storage.prototype.setItem = setItem;
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- useTheme`
Expected: FAIL — cannot resolve `./useTheme`.

- [ ] **Step 3: Implement the hook**

Create `src/theme/useTheme.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "icydb-explorer.theme";

/** `system` sets no `data-theme`, letting the media query in tokens.css pick
 *  between the Instrument (light) and Console (dark) values. */
export type ThemeChoice = "system" | "console" | "terminal" | "instrument";

export const THEME_CHOICES: readonly ThemeChoice[] = [
  "system",
  "console",
  "terminal",
  "instrument",
];

function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Reads the stored preference, falling back to `system` for anything absent or
 *  unrecognised. An unrecognised value would otherwise be applied verbatim as a
 *  `data-theme` matching no block, leaving the app on :root's defaults while the
 *  menu claimed otherwise. */
function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function useTheme(): {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);

  // Applies on mount too, so a stored preference takes effect without waiting
  // for an interaction.
  useEffect(() => {
    apply(choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    // Persisting is a convenience; a storage that refuses must not stop the
    // theme applying for this session.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* preference not remembered; the attribute is still applied above */
    }
  }, []);

  return { choice, setChoice };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- useTheme`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/theme/useTheme.ts src/theme/useTheme.test.ts
git commit -m "feat: add the theme preference hook"
```

---

## Task 3: The gear settings menu

**Files:**
- Create: `src/components/SettingsMenu.tsx`
- Create: `src/components/SettingsMenu.test.tsx`

**Interfaces:**
- Consumes: `ThemeChoice`, `THEME_CHOICES` from `../theme/useTheme` (Task 2).
- Produces: `SettingsMenu` with props `{ choice: ThemeChoice; onChoose: (next: ThemeChoice) => void }`.

It is a controlled component: it holds only its own open/closed state, never the theme. `App.tsx` owns the theme via `useTheme` and passes it down, so there is one source of truth.

- [ ] **Step 1: Write the failing tests**

Create `src/components/SettingsMenu.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsMenu } from "./SettingsMenu";

test("the menu is closed until the gear is clicked", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("every theme choice is offered", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /follow system/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /console/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /instrument/i })).toBeInTheDocument();
});

test("the current choice is marked, and only that one", () => {
  render(<SettingsMenu choice="terminal" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByRole("menuitemradio", { name: /console/i })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("choosing a theme reports it and closes the menu", () => {
  const onChoose = vi.fn();
  render(<SettingsMenu choice="system" onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /instrument/i }));

  expect(onChoose).toHaveBeenCalledWith("instrument");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape closes the menu without choosing", () => {
  const onChoose = vi.fn();
  render(<SettingsMenu choice="system" onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onChoose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- SettingsMenu`
Expected: FAIL — cannot resolve `./SettingsMenu`.

- [ ] **Step 3: Implement it**

Create `src/components/SettingsMenu.tsx`. Note every colour is a token utility.

```tsx
import { useEffect, useRef, useState } from "react";

import type { ThemeChoice } from "../theme/useTheme";

const LABELS: Record<ThemeChoice, { name: string; hint: string }> = {
  system: { name: "Follow system", hint: "Instrument or Console" },
  console: { name: "Console", hint: "dark" },
  terminal: { name: "Terminal", hint: "dark · mono" },
  instrument: { name: "Instrument", hint: "light" },
};

const ORDER: ThemeChoice[] = ["system", "console", "terminal", "instrument"];

/** The gear popover. Controlled: it owns only open/closed, never the theme —
 *  `App` holds that through `useTheme`, so there is one source of truth. */
export function SettingsMenu({
  choice,
  onChoose,
}: {
  choice: ThemeChoice;
  onChoose: (next: ThemeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a click anywhere outside. Both are listeners on
  // the document rather than a backdrop element, so the menu adds nothing to
  // the layout and cannot shift the header.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="rounded-control px-2 py-1 text-text-2 hover:bg-surface-2"
      >
        <span aria-hidden="true">⚙</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 z-20 mt-1 w-56 rounded-control border border-rule-strong bg-surface-2 py-1"
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-3">Theme</div>
          {ORDER.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === choice}
              onClick={() => {
                onChoose(option);
                setOpen(false);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm text-text-1 hover:bg-sel-bg hover:text-sel-text"
            >
              <span aria-hidden="true" className="w-3 text-accent">
                {option === choice ? "●" : ""}
              </span>
              <span>{LABELS[option].name}</span>
              <span className="ml-auto font-mono text-[10px] text-text-3">
                {LABELS[option].hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- SettingsMenu`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsMenu.tsx src/components/SettingsMenu.test.tsx
git commit -m "feat: add the gear settings menu for theme selection"
```

---

## Task 4: Restyle the nine components onto tokens

**Files:**
- Create: `src/components/tokens-only.test.ts`
- Modify: `src/components/ValueCell.tsx`, `ErrorBanner.tsx`, `TableList.tsx`, `CanisterTree.tsx`, `IdentitySelector.tsx`, `SqlConsole.tsx`, `RowGrid.tsx`, `SchemaPanel.tsx`, `ProjectSelector.tsx`

**Interfaces:**
- Consumes: the token utilities from Task 1.
- Produces: nothing new. **No props, no logic and no DOM structure may change** — this task is presentation only. Every existing test must still pass untouched.

**The substitution table.** Apply it mechanically; these are the only colour utilities that should remain afterwards.

| Current | Becomes |
|---|---|
| `bg-white` | `bg-surface-1` |
| `bg-gray-100` (grid header, hover) | `bg-surface-inset` for headers, `hover:bg-surface-2` for hover |
| `bg-gray-50` | `bg-surface-inset` |
| `bg-blue-100` (selection) | `bg-sel-bg text-sel-text` |
| `text-gray-900` | `text-text-1` |
| `text-gray-500` | `text-text-2` |
| `text-gray-400` | `text-text-3` |
| `border`, `border-b`, `border-r`, `border-t` | keep the side, add `border-rule` |
| `border-red-300 bg-red-50 text-red-800` | `border-danger-border bg-danger-bg text-danger-text` |
| `border-amber-300 bg-amber-50 text-amber-800` | `border-warn-border bg-warn-bg text-warn-text` |
| `rounded` on header controls | `rounded-control` |
| `rounded` on list rows | `rounded-row` |
| `font-mono` | keep — it now resolves through `--font-mono` |

Two additional changes, both from the spec:

- `ValueCell`'s identifier and primary-key emphasis uses `text-pk`.
- `ValueCell`'s `null` stays italic but becomes `text-text-3`.

- [ ] **Step 1: Write the failing test**

Create `src/components/tokens-only.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/components");

/** Every component source, excluding tests — a test may legitimately assert on
 *  a literal, and `.test.tsx` files ship to nobody. */
const sources = readdirSync(DIR)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .sort();

test("there are components to check", () => {
  expect(sources.length).toBeGreaterThan(5);
});

/// The rule that keeps the second and third themes alive. A literal colour is
/// invisible in one theme and wrong in another, and the failure is silent — the
/// component simply looks off in a theme nobody was testing when they wrote it.
/// src/theme/tokens.css is the one place literals belong.
test.each(sources)("%s contains no literal colour", (name) => {
  const source = readFileSync(join(DIR, name), "utf8");
  const literals = [
    ...source.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...source.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/gi),
  ].map((match) => match[0]);
  expect(literals).toEqual([]);
});

/// Tailwind's built-in palette is just as theme-hostile as a hex literal:
/// `text-gray-500` is a fixed value that ignores `data-theme` entirely.
test.each(sources)("%s uses no built-in Tailwind palette colour", (name) => {
  const source = readFileSync(join(DIR, name), "utf8");
  const palette = [
    ...source.matchAll(
      /\b(?:bg|text|border|ring|from|to|via)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    ),
  ].map((match) => match[0]);
  expect(palette).toEqual([]);
});

test.each(sources)("%s uses no bare bg-white or bg-black", (name) => {
  const source = readFileSync(join(DIR, name), "utf8");
  expect(source).not.toMatch(/\b(?:bg|text|border)-(?:white|black)\b/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tokens-only`
Expected: FAIL on most components — `ErrorBanner.tsx` on `border-red-300`, `TableList.tsx` on `bg-blue-100` and `text-gray-400`, and so on. Note the failing list; it is your work queue.

- [ ] **Step 3: Restyle each component**

Work through the failures using the substitution table. Nothing but `className` strings should change. As one worked example, `ErrorBanner.tsx`'s single element becomes:

```tsx
    <div
      role="alert"
      className="rounded-control border border-danger-border bg-danger-bg p-3 text-sm text-danger-text"
    >
```

and `TableList.tsx`'s row button becomes:

```tsx
              className={`block w-full rounded-row px-2 py-1 text-left ${
                isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"
              }`}
```

Leave every doc comment in place. Several carry hard-won reasoning — `CanisterTree`'s note on why the forest has no single root, `ErrorBanner`'s on rendering `explanation` verbatim, `ValueCell`'s on numeric alignment — and none of it is about colour.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tokens-only`
Expected: PASS, 4 × 9 + 1 tests.

Then the whole suite: `npm test`
Expected: PASS. The pre-existing count is 39 plus what Tasks 1-3 added; **no existing test may have been edited to achieve this.** If one fails, the change was not presentation-only — stop and report it.

Then: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/components
git commit -m "refactor: style every component through theme tokens"
```

---

## Task 5: Restyle the shell and wire the gear in

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/tokens-only.test.ts`

**Interfaces:**
- Consumes: `useTheme` (Task 2), `SettingsMenu` (Task 3), token utilities (Task 1).
- Produces: nothing downstream. This is the last task of phase 1.

- [ ] **Step 1: Extend the test to cover App.tsx**

In `src/components/tokens-only.test.ts`, add `src/App.tsx` to the checked set. Replace the `sources` construction with:

```ts
const ROOT = process.cwd();
const DIR = join(ROOT, "src/components");

/** Component sources plus the app shell. Tests are excluded — a test may
 *  legitimately assert on a literal, and it ships to nobody. */
const sources: { name: string; path: string }[] = [
  ...readdirSync(DIR)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .sort()
    .map((name) => ({ name, path: join(DIR, name) })),
  { name: "App.tsx", path: join(ROOT, "src/App.tsx") },
];
```

and change each `test.each` to iterate `sources` reading `path`, reporting `name`. For example:

```ts
test.each(sources)("$name contains no literal colour", ({ path }) => {
  const source = readFileSync(path, "utf8");
  const literals = [
    ...source.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...source.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/gi),
  ].map((match) => match[0]);
  expect(literals).toEqual([]);
});
```

Note the `$name` interpolation — `test.each` over objects uses `$property`, not `%s`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tokens-only`
Expected: FAIL on `App.tsx` — it contains `bg-white`, `text-gray-900`, `text-gray-500`, `bg-amber-50`, `border-amber-300`, `text-amber-800` and several `border` utilities without a colour.

- [ ] **Step 3: Restyle the shell and add the gear**

Apply the same substitution table from Task 4 across `App.tsx`'s `className` strings. The root element becomes:

```tsx
    <main className="flex h-screen flex-col bg-surface-0 font-ui text-text-1">
```

`font-ui` on the root is what gives Terminal its monospace chrome, since every descendant inherits it.

Then add the theme hook beside the other state:

```tsx
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
```

and put the gear at the right-hand end of the header, after `IdentitySelector`:

```tsx
        <div className="ml-auto">
          <SettingsMenu choice={themeChoice} onChoose={setThemeChoice} />
        </div>
```

Import both:

```tsx
import { SettingsMenu } from "./components/SettingsMenu";
import { useTheme } from "./theme/useTheme";
```

Do **not** change any layout class — no `grid`, no width, no `overflow` alteration. The `ml-auto` wrapper is the only structural addition in this phase, and it exists to push the gear right within the existing flex header.

- [ ] **Step 4: Add a test that the gear is reachable from the app**

Append to `src/App.test.tsx`, using the file's existing idiom (bare `test`, `vi.mocked(commands.X)`, `fireEvent`):

```tsx
test("the settings gear offers theme choices from the header", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toBeInTheDocument();
});
```

- [ ] **Step 5: Run everything**

Run: `npm test`
Expected: PASS, all suites. No pre-existing test edited.

Run: `npm run build`
Expected: success.

Run: `cd src-tauri && cargo test`
Expected: PASS, 129 passing — proving the frontend-only constraint held.

- [ ] **Step 6: Verify all three themes by eye**

This is the step no test replaces. Run:

```bash
npm run tauri dev
```

Open the gear and select each theme in turn. For each, confirm: text is legible against its background, the selected row is distinguishable, the error and advisory colours read as error and advisory, and focus rings are visible. **Terminal specifically:** confirm chrome is monospace and that selected rows use dark text on the moss fill rather than light-on-light — that is what `--sel-text` exists for and the one thing a token-parity test cannot catch.

Note anything that looks wrong in your report rather than fixing tokens ad hoc; a colour that needs changing is a token edit in one place, and worth doing deliberately.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/tokens-only.test.ts
git commit -m "feat: theme the app shell and add the settings gear"
```

---

## Manual verification (after Task 5)

The suites prove tokens are used; they cannot prove the result looks right.

1. Launch with the OS in light mode and no stored preference — expect Instrument.
2. Switch the OS to dark with the preference still on "Follow system" — expect Console, live, with no reload.
3. Pick Terminal, quit, relaunch — expect Terminal, applied before first paint rather than flashing another theme first.
4. Hand-edit `localStorage` to `"nonsense"` in devtools and reload — expect a silent fall back to follow-system, not a broken render.
