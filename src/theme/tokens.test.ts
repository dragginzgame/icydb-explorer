// Read through Vite's `?raw` rather than `node:fs`. This project has no
// `@types/node` and `tsconfig.json`'s `types` is `["vitest/globals"]`, so a Node
// builtin passes under Vitest but fails the `tsc` step of `npm run build`.
// `?raw` is declared by `vite/client` (referenced from `src/vite-env.d.ts`),
// needs no dependency, and resolves relative to this file rather than the cwd.
import css from "./tokens.css?raw";
import { THEME_CHOICES } from "./useTheme";

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
  ':root[data-theme="neotokyo"]',
  ':root[data-theme="synthwave"]',
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

/** CIE L* (lightness, 0..100) for a relative luminance. Perceptually uniform by
 *  construction — which is the whole reason the stripe floor below is expressed in
 *  it — so one step of L* means about the same amount of visible difference at the
 *  top of the range as at the bottom. Neither WCAG contrast ratio nor raw
 *  luminance has that property; see that test's own comment. */
function lstar(y: number): number {
  return y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
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
/// "distinct" and still invisible, and the test above compares exact strings, so
/// it would pass them. The zebra stripe is the tightest of the surface
/// relationships, so it carries the numeric floor, in every block including the
/// light ones.
///
/// The metric is CIE L*, not WCAG contrast ratio and not raw luminance, because
/// neither of those can serve all five blocks:
///
///   - WCAG's ratio is (Y_hi + 0.05) / (Y_lo + 0.05), and near black that flare
///     term is most of both operands — so it INFLATES the dark end. Terminal's
///     #181d1c over #0f1211 is a luminance gap of 0.00582 and scores 1.1044,
///     while light's #fcfcfa over #f7f7f1 is a gap of 0.04572 — nearly eight
///     times larger — and scores only 1.0468. A single ratio floor set where the
///     dark blocks sit would therefore condemn a light theme that is fine.
///   - Raw luminance difference is not a perceptual metric at all, and reading it
///     as one inverts the answer. By ΔY the light stripe looks like the most
///     separated of the three (0.04572 against console's 0.00560 and terminal's
///     0.00582). In L* it is the LEAST: ΔL* 1.83 for light, 3.90 for
///     console/:root, 5.04 for terminal.
///
/// L* is perceptually uniform by construction, so one floor spans both ends and
/// the two-metric split this file used to carry — a ratio floor for the dark
/// blocks, a ΔY floor for the light ones — is gone. (The justification written
/// for that split had the direction of the ratio distortion backwards and read
/// ΔY as perceptual; every measured pair in it was right, the conclusion drawn
/// from them was not. That ΔY floor of 0.03 was also a weak guarantee: near
/// Y ≈ 0.97 it is about 3.5 grey levels, ΔL* ≈ 1.2, at or below the just-noticeable
/// difference for two large adjacent fields.)
///
/// 1.5 is above that JND and below the tightest block's 1.83, so it holds every
/// theme without demanding a retune of any. It is not raised to, say, 3 on
/// purpose: the light blocks would fail, and pulling #fcfcfa and #f7f7f1 further
/// apart is a visible change to the light theme's whole surface stack — a design
/// call for whoever owns that theme, not something this floor gets to force. If
/// the light theme is ever retuned with more headroom, raising this is the moment.
const STRIPE_LSTAR_FLOOR = 1.5;

test.each(ALL_BLOCKS)("%s zebra stripe clears the perceptual floor over the pane ground", (selector) => {
  const declared = declarationsIn(selector);
  const separation = Math.abs(
    lstar(luminance(declared["--surface-1"])) - lstar(luminance(declared["--surface-0"])),
  );
  expect(separation).toBeGreaterThanOrEqual(STRIPE_LSTAR_FLOOR);
});

/// Every theme selector this file checks must be a theme the app can actually
/// choose, and every choice must have a block here. Either half missing is silent:
/// a block with no choice is dead CSS, and a choice with no block sets a
/// `data-theme` matching nothing and leaves the app on :root's values while the
/// menu says otherwise — which is the failure `storedChoice` guards against for
/// *unrecognised* values and cannot guard against for recognised ones.
///
/// This is also what makes the tests above meaningful for a new theme. They are
/// driven by the `THEMES` array, so a theme added to the CSS and not to that array
/// gets no parity check, no surface-distinctness check and no stripe floor — it
/// simply is not tested, while the suite stays green.
test("the choosable themes and the CSS blocks are the same set", () => {
  const inCss = [...css.matchAll(/:root\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]);
  const checked = THEMES.map((selector) => /"([a-z]+)"/.exec(selector)![1]);
  // `system` sets no attribute and so has no block, by design.
  const choosable = THEME_CHOICES.filter((choice) => choice !== "system");

  expect([...new Set(inCss)].sort()).toEqual([...choosable].sort());
  expect(checked.sort()).toEqual([...choosable].sort());
});

/// Terminal is near-black, so it has almost no headroom above the ground: the
/// header has to recede rather than lift, and hover has to stay above the
/// stripe. Pinned as an ordering rather than as ratios so a future retune can
/// move the values without rewriting the test, while still failing if the
/// header and the stripe ever cross.
test.each([
  ':root[data-theme="terminal"]',
  ':root[data-theme="neotokyo"]',
  ':root[data-theme="synthwave"]',
])("%s orders its surfaces inset < 0 < 1 < 2 by luminance", (selector) => {
  const declared = declarationsIn(selector);
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
