// `import.meta.glob` rather than `node:fs`: no `@types/node` exists here and
// `tsconfig.json`'s `types` is `["vitest/globals"]`, so a Node builtin fails the
// `tsc` step of `npm run build`. Vite's glob is declared by `vite/client` via
// `src/vite-env.d.ts`, needs no dependency, and picks up a newly added file
// automatically.
//
// The pattern is `src/**`, not `src/components/*.tsx`. The narrower scope this
// replaces missed `src/main.tsx`, `src/theme/*.ts` and the whole of `src/lib/` —
// a `#fff` in `main.tsx` passed the suite. `src/theme/tokens.css` is the one file
// allowed literal colours and is a `.css` file, so these globs cannot reach it.
const tsx = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// `.ts` needs its own literal pattern; `src/lib/` and `src/theme/` are all `.ts`.
const ts = import.meta.glob("../**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every shipping source file under `src/`.
 *
 *  Tests are excluded — a test may legitimately assert on a literal, and a
 *  `.test.*` file ships to nobody. `.d.ts` is excluded because it declares types
 *  rather than shipping code, and `vite-env.d.ts` is 38 bytes, which would trip
 *  the non-triviality guard below. */
const sources: { name: string; source: string }[] = Object.entries({ ...tsx, ...ts })
  .filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts"))
  // Vite reports a match in this very directory as `./Name.tsx` and everything
  // else relative to it, so both shapes are rewritten to a single src-relative
  // form — otherwise the directory-coverage check below compares against two
  // different conventions.
  .map(([path, source]) => ({
    name: path.startsWith("./") ? `components/${path.slice(2)}` : path.replace(/^\.\.\//, ""),
    source,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

test("there are components to check", () => {
  expect(sources.length).toBeGreaterThan(5);
});

/// `import.meta.glob` takes a literal pattern, so a rename or a copy-paste typo
/// silently matches nothing — and `sources.length > 5` is already satisfied by
/// the components alone, so the suite would stay green while whole directories
/// quietly left the checked set. This is the assertion that would notice.
///
/// Named files rather than a count: a count has to be edited every time a file is
/// added, and gets edited without thought. These four are one per directory the
/// glob has to reach, so losing any directory fails here.
test("every source directory is in the checked set", () => {
  const names = sources.map((entry) => entry.name);
  for (const required of [
    "App.tsx",
    "main.tsx",
    "components/RowGrid.tsx",
    "lib/elide.ts",
    "theme/useTheme.ts",
    "api/commands.ts",
  ]) {
    expect(names).toContain(required);
  }
});

/// The rule that keeps the second and third themes alive. A literal colour is
/// invisible in one theme and wrong in another, and the failure is silent — the
/// component simply looks off in a theme nobody was testing when they wrote it.
/// src/theme/tokens.css is the one place literals belong.
test.each(sources)("$name contains no literal colour", ({ source }) => {
  expect(source.length).toBeGreaterThan(100);
  const literals = [
    ...source.matchAll(/#[0-9a-f]{3,8}\b/gi),
    ...source.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi),
  ].map((match) => match[0]);
  expect(literals).toEqual([]);
});

/// Tailwind's built-in palette is just as theme-hostile as a hex literal:
/// `text-gray-500` is a fixed value that ignores `data-theme` entirely. The
/// optional side/axis segment (`border-b-`, `ring-offset-`, ...) matters: this
/// codebase's idiom is exactly `border-b border-rule`, so a typo collapsing
/// that to `border-b-red-500` is a real, valid Tailwind utility that the naive
/// pattern would miss.
test.each(sources)("$name uses no built-in Tailwind palette colour", ({ source }) => {
  const palette = [
    ...source.matchAll(
      /\b(?:bg|text|border|ring|ring-offset|outline|decoration|divide|shadow|accent|caret|fill|stroke|placeholder|from|via|to)(?:-(?:t|r|b|l|x|y|s|e))?-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    ),
  ].map((match) => match[0]);
  expect(palette).toEqual([]);
});

test.each(sources)("$name uses no bare bg-white or bg-black", ({ source }) => {
  expect(source).not.toMatch(/\b(?:bg|text|border)-(?:white|black)\b/);
});

/// Tailwind's arbitrary-value syntax can smuggle a colour past both checks
/// above: `bg-[red]` contains no `#` and no colour function, but is every bit
/// as theme-hostile as a hex literal.
test.each(sources)("$name uses no bare colour keyword in an arbitrary value", ({ source }) => {
  const keywords = [
    ...source.matchAll(
      /-\[\s*(?:red|blue|green|black|white|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|transparent|currentColor)\s*\]/gi,
    ),
  ].map((match) => match[0]);
  expect(keywords).toEqual([]);
});

/** The contents of every `style={{ ... }}` attribute in a source, brace-matched
 *  rather than regex-delimited so a template literal containing `}` (which
 *  `${x}` always does) does not truncate the block and hide what follows. */
function inlineStyleBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /style=\{\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    // Start inside the object literal, one brace deep.
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(start, index - 1));
  }
  return blocks;
}

/// The third blind spot. Every check above matches either a Tailwind class shape
/// or a CSS colour function, so `style={{ backgroundColor: "white" }}` passed all
/// of them: no `#`, no `rgb(`, no palette class, no arbitrary value. It is also
/// the most theme-hostile thing available, because an inline style beats every
/// stylesheet rule and so cannot even be corrected downstream.
///
/// Keyed on the PROPERTY, not the value: `backgroundColor: theme.bg` is just as
/// unreachable by `data-theme` as a literal, and enumerating every way a value
/// can name a colour is a losing game. A colour belongs in tokens.css, reached
/// through a utility class — there is no legitimate inline case here.
test.each(sources)("$name sets no colour through an inline style", ({ source }) => {
  const offenders = inlineStyleBlocks(source).flatMap((block) =>
    [
      ...block.matchAll(
        /\b(?:background|backgroundColor|backgroundImage|color|borderColor|border(?:Top|Right|Bottom|Left)Color|borderBlockColor|borderInlineColor|outlineColor|outline|textDecorationColor|textEmphasisColor|caretColor|accentColor|columnRuleColor|fill|stroke|stopColor|floodColor|lightingColor|boxShadow|textShadow)\s*:/g,
      ),
    ].map((match) => match[0]),
  );
  expect(offenders).toEqual([]);
});

/** The token names `@theme inline` actually defines, split by the utility family
 *  they back: `--color-*` backs `bg-`/`text-`/`border-`, `--radius-*` backs
 *  `rounded-`. */
function definedTokens(): { colour: Set<string>; radius: Set<string> } {
  const start = themeCss.indexOf("@theme inline");
  const open = themeCss.indexOf("{", start);
  const close = themeCss.indexOf("}", open);
  const block = themeCss.slice(open + 1, close);
  const named = (prefix: string) =>
    new Set(
      [...block.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+)\\s*:`, "g"))].map(
        (match) => match[1],
      ),
    );
  return { colour: named("color"), radius: named("radius") };
}

/** The leading segment of every defined token name — `surface-inset` contributes
 *  `surface`, `pk` contributes `pk`. This is the line between a project token
 *  and one of Tailwind's own utilities, and it is drawn from tokens.css rather
 *  than from a hand-maintained allowlist, so adding a token family cannot leave
 *  the check behind.
 *
 *  Reading it as a namespace is what makes the check safe in both directions.
 *  `text-sm`, `text-right`, `text-xs`, `border-b`, `border-collapse` and the
 *  built-in radius sizes all have leading segments (`sm`, `right`, `xs`, `b`,
 *  `collapse`, `full`) that no token family claims, so they are Tailwind's and
 *  are skipped rather than reported as unknown tokens. Written as segments
 *  rather than as whole class names on purpose: Tailwind's scanner reads this
 *  file too and does not skip comments, so spelling out a class nothing uses
 *  would emit a dead rule into the bundle. `bg-surface-3`, `text-text-4` and
 *  `bg-surface-inest` all lead with a claimed namespace, so they must resolve —
 *  and none of them does.
 *
 *  Known and deliberate gap, verified rather than assumed: a typo in the
 *  NAMESPACE itself escapes. `bg-surfce-1` and `rounded-sharp` lead with
 *  segments no family claims, so they read as Tailwind utilities and pass. The
 *  alternative is a hand-maintained list of every Tailwind built-in value, which
 *  would rot on the next minor release and start rejecting valid classes; the
 *  only complete answer is compiling the stylesheet and checking a rule was
 *  emitted. This catches the far more common failure — a token name that drifted
 *  from tokens.css — at zero maintenance cost and with no false positives. */
function namespaces(tokens: Set<string>): Set<string> {
  return new Set([...tokens].map((token) => token.split("-")[0]));
}

const themeCss = (
  import.meta.glob("../theme/tokens.css", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)["../theme/tokens.css"];

test("the theme file is readable and defines tokens", () => {
  expect(themeCss).toBeTypeOf("string");
  const { colour, radius } = definedTokens();
  expect(colour.size).toBeGreaterThan(10);
  expect(radius.size).toBeGreaterThan(1);
});

/// The highest-value check here, and the one nothing else covers: whether a
/// token class RESOLVES. Every assertion above is about what a class must not
/// be; none asks whether the class exists. `bg-surface-3`, `text-text-4` and a
/// typo like `bg-surface-inest` are all theme-token-shaped, all pass every other
/// test in this file, and all compile to nothing at all — Tailwind emits no rule,
/// the element renders transparent, and the only symptom is a panel that looks
/// slightly wrong in every theme equally, which is precisely the symptom nobody
/// attributes to a typo.
test.each(sources)("$name references only tokens that exist", ({ source }) => {
  const { colour, radius } = definedTokens();
  const families = [
    { utilities: ["bg", "text", "border"], tokens: colour },
    { utilities: ["rounded"], tokens: radius },
  ];

  const unknown: string[] = [];
  for (const { utilities, tokens } of families) {
    const known = namespaces(tokens);
    const pattern = new RegExp(`\\b(?:${utilities.join("|")})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`, "g");
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      // Not in a token namespace: one of Tailwind's own utilities, not ours.
      if (!known.has(value.split("-")[0])) continue;
      if (!tokens.has(value)) unknown.push(match[0]);
    }
  }

  expect(unknown).toEqual([]);
});

/// Terminal inverts selection — dark text on a moss fill — while the other two
/// themes use ordinary text on a tint. So a `bg-sel-bg` without `text-sel-text`
/// is illegible in Terminal only, and no token-parity test can see it: every
/// token is present and well-formed.
///
/// The unit of comparison is a single string fragment, not a whole `className`
/// expression. Splitting on every string and interpolation boundary means the
/// two classes must co-occur in ONE literal — so a pair split across the
/// branches of a ternary (`sel ? "bg-sel-bg" : "text-sel-text"`) is caught,
/// which an expression-wide check treats as paired. An earlier quote-delimited
/// window missed two of the three call sites outright; an expression-wide one
/// missed the split-branch case. This is the third attempt and the first that
/// catches both.
test.each(sources)("$name pairs bg-sel-bg with text-sel-text", ({ source }) => {
  const unpaired = source
    .split(/["'`]|\$\{|\}/)
    .filter((fragment) => fragment.includes("bg-sel-bg") && !fragment.includes("text-sel-text"))
    .map((fragment) => fragment.trim().slice(0, 80));

  expect(unpaired).toEqual([]);
});
