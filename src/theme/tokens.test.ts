// Read through Vite's `?raw` rather than `node:fs`. This project has no
// `@types/node` and `tsconfig.json`'s `types` is `["vitest/globals"]`, so a Node
// builtin passes under Vitest but fails the `tsc` step of `npm run build`.
// `?raw` is declared by `vite/client` (referenced from `src/vite-env.d.ts`),
// needs no dependency, and resolves relative to this file rather than the cwd.
import css from "./tokens.css?raw";

/** Every `--token: value;` declared inside the given selector's block. */
function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) return [];
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

/** Every `--token: value` pair declared in the given selector's block. */
function declarationsIn(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) return {};
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return Object.fromEntries(
    [...css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(
      (match) => [match[1], match[2].trim()],
    ),
  );
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
    (token) => !/^--(?:ui-font|mono-font|prose-font|r-control|r-row)$/.test(token),
  );
  expect(colourish.filter((token) => !declared.has(token))).toEqual([]);
});

test("only the theme file carries literal colours", () => {
  expect(/#[0-9a-f]{3,8}\b/i.test(css)).toBe(true);
});

/// The `:root` block IS Console — that is what makes "follow system" on a dark
/// OS identical to choosing Console explicitly. Name parity cannot catch a value
/// edited in one block and not the other, which would silently make those two
/// states render differently. This is the only test that guards it.
test("the console theme and the :root default hold identical values", () => {
  expect(declarationsIn(':root[data-theme="console"]')).toEqual(declarationsIn(BASE));
});

/** WCAG relative luminance of a `#rrggbb` literal. */
function luminance(hex: string): number {
  const channel = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ["--surface-0", "--surface-1", "--surface-2", "--surface-inset"];
const ALL_BLOCKS = [BASE, SYSTEM_LIGHT, ...THEMES];

/// Terminal set --surface-0, --surface-1 and --surface-inset to the same
/// #0f1211: a contrast ratio of exactly 1.000. --surface-1 is the zebra stripe
/// and --surface-inset the sticky header fill, so both were invisible in that
/// theme while looking correct in the other two — the exact failure mode the
/// token layer exists to prevent, and one no parity or bridging test can see,
/// because every token is present and well-formed.
test.each(ALL_BLOCKS)("%s gives each surface a distinct value", (selector) => {
  const declared = declarationsIn(selector);
  const values = SURFACES.map((token) => declared[token]).filter(Boolean);
  expect(values).toHaveLength(SURFACES.length);
  expect(new Set(values).size).toBe(SURFACES.length);
});

/// Distinct is necessary but not sufficient: two hexes one unit apart are
/// "distinct" and still invisible. The zebra stripe is the tightest of the
/// surface relationships, so it carries the numeric floor. The bound is
/// deliberately low — this is a stripe, not a divider — and the light blocks sit
/// at 1.047, which is why the floor is asserted for the dark blocks where a flat
/// near-black can hide a stripe completely.
test.each([BASE, ':root[data-theme="console"]', ':root[data-theme="terminal"]'])(
  "%s zebra stripe is measurably distinct from the pane ground",
  (selector) => {
    const declared = declarationsIn(selector);
    expect(contrast(declared["--surface-1"], declared["--surface-0"])).toBeGreaterThanOrEqual(1.08);
  },
);

/// The light blocks are exempt from the ratio floor above, and that exemption is
/// correct — but it left them with no stripe-visibility assertion at all. The only
/// thing covering them was the pairwise-distinct test, which compares exact
/// strings, so two hexes one unit apart passed it and a future retune could make
/// the light zebra invisible with the whole suite green.
///
/// The metric differs because contrast ratio understates separation at high
/// luminance. Measured: light is #fcfcfa against #f7f7f1 — ratio 1.0468, absolute
/// luminance gap 0.0457. Terminal is #0f1211 against #181d1c — ratio 1.1044, gap
/// 0.0058. The light stripe is separated 8.2x more in absolute terms while
/// scoring lower as a ratio, so holding it to the dark blocks' ratio floor would
/// flatten a theme that is already correct.
///
/// Do NOT "unify" this with the ratio test above. The two metrics are chosen for
/// the two ends of the luminance range on purpose; collapsing them reintroduces
/// exactly the mistake this test exists to prevent.
const LIGHT_BLOCKS = [SYSTEM_LIGHT, ':root[data-theme="instrument"]'];
const LIGHT_STRIPE_FLOOR = 0.03;

test.each(LIGHT_BLOCKS)("%s zebra stripe is measurably distinct by luminance", (selector) => {
  const declared = declarationsIn(selector);
  const separation = Math.abs(
    luminance(declared["--surface-1"]) - luminance(declared["--surface-0"]),
  );
  expect(separation).toBeGreaterThanOrEqual(LIGHT_STRIPE_FLOOR);
});

/// Terminal is near-black, so it has almost no headroom above the ground: the
/// header has to recede rather than lift, and hover has to stay above the
/// stripe. Pinned as an ordering rather than as ratios so a future retune can
/// move the values without rewriting the test, while still failing if the
/// header and the stripe ever cross.
test("terminal orders its surfaces inset < 0 < 1 < 2 by luminance", () => {
  const declared = declarationsIn(':root[data-theme="terminal"]');
  const ordered = ["--surface-inset", "--surface-0", "--surface-1", "--surface-2"].map((token) =>
    luminance(declared[token]),
  );
  expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
});

/// Every `--token: value(...)` reference inside `@theme inline`, keyed by the
/// inner `var(--...)` name it points at — i.e. the set of :root tokens the
/// bridge actually reaches.
function bridgedTokens(): Set<string> {
  const start = css.indexOf("@theme inline");
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  return new Set([...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
}

/// A token declared in every block but never bridged into `@theme inline`
/// compiles clean and looks correct on inspection, but backs no Tailwind
/// utility at all — no `bg-*`/`text-*`/etc. can ever reach it. `--row-h` was
/// exactly this: present, parity-clean, and silently unusable. Font and radius
/// tokens are excluded because they bridge under a different prefix
/// (`--font-*`/`--radius-*`) than the mechanical `--color-<name>` naming this
/// test checks by convention-free reference matching instead.
test("every colour token in :root is bridged inside @theme inline", () => {
  const bridged = bridgedTokens();
  const colourTokens = tokensIn(BASE).filter(
    (token) => !/^--(?:ui-font|mono-font|prose-font|r-control|r-row)$/.test(token),
  );
  expect(colourTokens.filter((token) => !bridged.has(token))).toEqual([]);
});
