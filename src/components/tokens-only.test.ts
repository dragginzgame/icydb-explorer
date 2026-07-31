// `import.meta.glob` rather than `node:fs`: no `@types/node` exists here and
// `tsconfig.json`'s `types` is `["vitest/globals"]`, so a Node builtin fails the
// `tsc` step of `npm run build`. Vite's glob is declared by `vite/client` via
// `src/vite-env.d.ts`, needs no dependency, and picks up a newly added
// component automatically.
const modules = import.meta.glob("./*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every component source, excluding tests — a test may legitimately assert on
 *  a literal, and `.test.tsx` files ship to nobody. */
const sources: { name: string; source: string }[] = Object.entries(modules)
  .filter(([path]) => !path.endsWith(".test.tsx"))
  .map(([path, source]) => ({ name: path.replace("./", ""), source }))
  .sort((a, b) => a.name.localeCompare(b.name));

test("there are components to check", () => {
  expect(sources.length).toBeGreaterThan(5);
});

/// The rule that keeps the second and third themes alive. A literal colour is
/// invisible in one theme and wrong in another, and the failure is silent — the
/// component simply looks off in a theme nobody was testing when they wrote it.
/// src/theme/tokens.css is the one place literals belong.
test.each(sources)("$name contains no literal colour", ({ source }) => {
  const literals = [
    ...source.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...source.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/gi),
  ].map((match) => match[0]);
  expect(literals).toEqual([]);
});

/// Tailwind's built-in palette is just as theme-hostile as a hex literal:
/// `text-gray-500` is a fixed value that ignores `data-theme` entirely.
test.each(sources)("$name uses no built-in Tailwind palette colour", ({ source }) => {
  const palette = [
    ...source.matchAll(
      /\b(?:bg|text|border|ring|from|to|via)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    ),
  ].map((match) => match[0]);
  expect(palette).toEqual([]);
});

test.each(sources)("$name uses no bare bg-white or bg-black", ({ source }) => {
  expect(source).not.toMatch(/\b(?:bg|text|border)-(?:white|black)\b/);
});
