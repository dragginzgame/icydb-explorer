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
    (token) => !/^--(?:ui-font|mono-font|r-control|r-row|row-h)$/.test(token),
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
