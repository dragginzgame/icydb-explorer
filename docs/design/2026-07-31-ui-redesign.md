# UI redesign — Design

**Date:** 2026-07-31
**Status:** Approved
**Mockups:**
- Revision 1, three directions: `https://claude.ai/code/artifact/75baad68-1c06-4db9-b698-353292cc42fa`
- Revision 2, refined layout: `https://claude.ai/code/artifact/39147c6b-1a83-4efd-a99d-e7c020a99f65`

Both are private pages, so they are a convenience rather than the record. This document is
the record; if the links rot, nothing here depends on them.

## Purpose

Turn a working but plain interface into a tool that is pleasant to read and fast to
operate. Two complaints started this: row data is unreadable, and the scrolling is
awkward. Both are symptoms of the same root cause — there is no design system and no
information design, only per-component utility classes.

## What is actually wrong

Verified in the current tree, not assumed:

| Problem | Cause |
|---|---|
| A structured value shoves every later column off-screen | The row grid is `table-auto` with unbounded cell widths, so `ValueCell`'s `truncate` class can never fire — it needs a bounded box |
| The table list scrolls out of reach | `Tables` and `Schema` share one scroll container in a 288px pane; toko's `User` schema is ~35 rows with nesting |
| No visual identity | `src/index.css` is one line: `@import "tailwindcss"`. Every colour, size and space is chosen ad hoc per component |
| The SQL console always costs vertical space | It is a permanently mounted textarea plus button, used or not |
| Errors shift the layout | `ErrorBanner` is inserted inline above content |
| Nothing is keyboard-reachable | Selection is mouse-only; reaching a table is a tree click then a list click |
| Long identifiers dominate | Full principals render inline at full width; a 63-character principal sets its column's width |

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Visual direction | **Console** — sans chrome, monospace data, layered surfaces — at **Instrument's density** (24px rows, 5px vertical cell padding, 10.5px monospace data, 12px UI text) | The only direction where chrome stays legible while data stays monospace. The backend's operator-facing error prose is this app's best asset and monospace undersells it. |
| Themes | Ship **all three** — Console, Terminal, Instrument — selectable | Three directions were designed; a token layer makes the other two nearly free, and they are genuinely different working preferences rather than discards |
| Default theme | **Follow system**, resolving to Instrument (light) or Console (dark) | The app looks right on first launch without anyone opening settings |
| Theme storage | Webview `localStorage` | Pure UI preference. Applies with no IPC round trip, needs no Rust command, cannot fail in a way that blocks the app. Trade-off accepted: it is not inspectable beside `project.json`. |
| Schema placement | **Right-hand inspector, collapsible** | Where inspectors live. Full height for nested fields, and collapsing returns width to the rows — which is the real fix for unreadable rows. It also makes the middle pane a plain table list, deleting the nested-scroll problem rather than solving it. |
| Control radius | `7px` for header controls, `5px` for row selection | Rounder as asked, stopping short of a pill: at 11px type a full pill makes the caret sit oddly and rows lose their baseline |
| Array values | `N items` collapsed; one item per line expanded | Truncated bracket soup tells the reader nothing |
| SQL editor | **CodeMirror 6** | A `<textarea>` cannot style its own content, so syntax colouring and reliable completion placement need a real editor. ~200 KB is not a real cost in a bundled webview, and completion *is* the feature. |
| Rejected: multi-tab workspace | — | Would rewrite `App.tsx`'s state model rather than extend it. Revisit if single-table browsing proves limiting. |
| Rejected: theme in the config dir | — | A new command and module, plus a flash of the default theme before the read resolves, for a preference that does not need to leave the webview |

## What does not change

The entire Rust backend. The `view/` icydb boundary, the read-only guarantee (only
`agent.query`, at exactly two call sites), the DTO contract, discovery, identity, the
agent pool, `select_project`. **This redesign is frontend-only and must add no Tauri
command and no network call site.** If a task appears to need one, that is a signal the
design is wrong, not the boundary.

One consequence worth stating: because no DTO changes, everything the UI shows must
already be derivable from `ResultDto`, `SchemaDto`, `EntityDto` and `TreeNode`. The
autocomplete's column list comes from the `SchemaDto` already fetched for the open
table; the `ORDER BY` assist uses `ColumnDto.primaryKey`, already present.

## Architecture

### The token layer — the load-bearing piece

`src/index.css` gains CSS custom properties, and **every component styles exclusively
through them.** This is what makes three themes cost almost nothing instead of three
forks of every component.

```css
:root {
  --surface-0: …;  /* app ground */
  --surface-1: …;  /* pane */
  --surface-2: …;  /* raised: popover, palette, expanded row */
  --text-1: …; --text-2: …; --text-3: …;   /* primary, secondary, muted */
  --rule: …; --rule-strong: …;
  --accent: …; --accent-bg: …;              /* selection, focus, active */
  --pk: …;                                  /* primary-key / identifier emphasis */
  --radius-control: 7px; --radius-row: 5px;
  --row-h: 24px; --pane-pad: …;             /* spacing scale, not a user-facing switch */
  --font-ui: …; --font-mono: …;
}
```

Themes are `:root[data-theme="console"|"terminal"|"instrument"]` blocks that redefine
**only** these properties. `follow-system` sets no attribute and lets
`@media (prefers-color-scheme: dark)` choose between the Instrument and Console values.

A component containing a literal colour is a defect. That rule is the whole design
system; without it the second theme silently rots.

**Terminal's one structural difference:** it sets `--font-ui` to the monospace stack.
Because chrome reads through `--font-ui`, that single token gives Terminal its character
with no component-level branching.

### Layout

Four panes, each independently scrollable, with draggable boundaries:

```
┌──────────────────────────────────────────────────────────────────┐
│ icydb   ( toko ▾ )( local ▾ )( toko-local ▾ )        7 cans  ⚙   │
├─────────┬──────────┬──────────────────────────┬─────────────────┤
│ Fleet   │ Tables   │ Rows                     │ Schema        › │
│ (tree)  │ (list)   │ (grid)                   │ (inspector)     │
├─────────┴──────────┴──────────────────────────┴─────────────────┤
│ SQL — collapsed to one bar until invoked                        │
└──────────────────────────────────────────────────────────────────┘
```

- Exactly **one** scroll container per pane, owned by that pane. No nested scrolling.
- Pane widths persist in `localStorage` alongside the theme.
- Schema collapses to a ~30px labelled rail; the rows pane takes the width back. This is
  the state a reader keeps it in, and it is where identifiers stop being elided.
- The SQL bar expands on `⌘⏎` or click, and collapses again on `Esc`.

### Components

| File | Responsibility |
|---|---|
| `src/theme/tokens.css` *(new)* | The token definitions and the three theme blocks |
| `src/theme/useTheme.ts` *(new)* | Reads/writes the preference, applies `data-theme`, resolves follow-system |
| `src/components/SettingsMenu.tsx` *(new)* | The gear popover: theme choice, nothing else yet |
| `src/components/CommandPalette.tsx` *(new)* | `⌘K` over canisters, tables and recent queries |
| `src/components/SqlEditor.tsx` *(new)* | CodeMirror instance, completion source, the `ORDER BY` assist strip. Replaces `SqlConsole` |
| `src/components/RowGrid.tsx` | Bounded columns, sticky header, zebra, expand-in-place sub-rows, skeleton rows |
| `src/components/ValueCell.tsx` | Per-kind rendering, elision, expansion, copy-on-click |
| `src/components/SchemaPanel.tsx` | Right-inspector layout, nesting, indexes, collapse control |
| `src/components/Identifier.tsx` *(new)* | Head-and-tail elision, full value on hover, click to copy — used by the grid, the tree and the palette, so the rule lives once |
| `src/components/Pane.tsx` *(new)* | A pane with a header, one scroll region and an optional drag handle |
| `src/App.tsx` | Composition, keyboard map, pane state. Its data effects are unchanged. |

`CanisterTree`, `TableList`, `ErrorBanner` and `IdentitySelector` are restyled through
tokens; their logic and props do not change.

### Data presentation

The rules that fix readability, in one place so they cannot drift:

- **Bounded cells.** Every column has a width; content clips with an ellipsis. A
  clipped cell carries its full value in `title` and gains an expand chevron.
- **Expansion is a sub-row**, spanning all columns, indented under the expanded cell —
  not a tooltip, not a modal. Structured values indent by depth; arrays list one item
  per line under their field name.
- **Identifiers elide head-and-tail** at a character boundary
  (`bg33z-ib5mx…acfnn-iqe`), never mid-group, so both ends stay recognisable. Click
  copies the full value.
- **Numbers** are right-aligned with `tabular-nums`.
- **`null` is visible** — italic, muted, the word `null` — never an empty cell.
- **Primary-key columns** carry `--pk`, so the key is findable without reading the
  schema.

### Command palette

`⌘K` opens one flat, filtered list over three sources the app has already loaded:
canisters (from the forest), tables (from the entity list), and recent queries (from
`localStorage`). Selecting a canister or table performs the same selection the mouse
would; selecting a query fills the editor without running it. `Esc` closes. No new
backend call.

### SQL editor

CodeMirror 6 with a SQL mode, plus two app-specific behaviours:

1. **Completion from real schema.** Ordered: the open table's columns, then sibling
   table names, then the statement keywords the app actually supports (`SELECT`, `FROM`,
   `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET`, `SHOW`, `DESCRIBE`, `EXPLAIN`). Sourced from
   the `SchemaDto`/`EntityDto` already in state — no invented identifiers.
2. **The `ORDER BY` assist.** When the statement has a `LIMIT` and no `ORDER BY`, a strip
   under the editor offers `ORDER BY <primary key>` on `Tab`, using the real primary key
   from `SchemaDto`. This is the single most-hit failure in the app — icydb rejects that
   statement outright as diagnostic `E5` — and this turns it into a keystroke instead of
   an error to read.

The existing `limitAppended` and `orderByMissing` signals from `run_sql` still drive
their notes; the assist is additive and client-side.

### States

Every pane gets three, designed rather than defaulted:

- **Loading:** skeleton rows at the known column count, so the grid does not reflow when
  data lands. Not the words "Loading rows…".
- **Empty:** an invitation naming the space, one explanatory line, and the action if
  there is one. The existing amber-box copy is kept where it is genuinely useful — the
  "no usable identity" and "no environments" explanations are good and stay.
- **Error:** anchored inside the pane that failed, not inserted above it, so nothing
  shifts. `AppError.explanation` is still rendered **verbatim and never truncated** —
  it is the most valuable thing the backend produces on failure.

### Keyboard

| Key | Action |
|---|---|
| `⌘K` | Command palette |
| `⌘⏎` | Open the SQL editor, or run it if open |
| `Esc` | Close palette / collapse editor / collapse expanded row |
| `↑ ↓` | Move within the focused pane's list |
| `→ ←` | Expand / collapse a tree node or a row |
| `⌘\` | Toggle the schema inspector |
| `⌘C` | Copy the focused cell's full value |

**Focus model.** Exactly one pane holds focus at a time, shown by a focus ring on the
pane header. `Tab` moves between panes; arrows move within the focused pane. In the rows
pane, focus is a *cell*, not a row — that is what makes `⌘C` and `→` (expand) unambiguous.
Without this the table above would be describing behaviour nothing implements, so it is
stated here rather than left to the implementer to invent.

## Implementation phases

The design is one coherent thing, but it should be built and reviewed in three parts —
each leaves the app working:

1. **Tokens, themes, settings.** `tokens.css`, `useTheme`, the gear menu, and every
   existing component restyled through tokens. No layout change. Ends with three working
   themes and the same information architecture.
2. **Layout and data presentation.** Four panes, schema inspector, resizing, bounded
   cells, expansion, identifiers, states. Ends with the readability complaints fixed.
3. **Power features.** Command palette, CodeMirror editor, completion, `ORDER BY` assist.
   Ends with the keyboard map complete.

Phase 1 is a prerequisite for 2 and 3 looking right. Phases 2 and 3 are independent of
each other.

## Testing

| Scope | Approach |
|---|---|
| Token discipline | A test asserting no file under `src/components/` or `src/App.tsx` contains a hex colour, `rgb(`, or `hsl(`. `src/theme/tokens.css` is the one file exempt, because it is where the literals belong. This is the rule that keeps the second and third themes alive. |
| `useTheme` | Stored preference wins; absent preference follows `prefers-color-scheme`; an unknown stored value falls back rather than throwing |
| `Identifier` | Elision keeps both ends and never splits mid-group; short values are untouched; copy writes the **full** value, not the elided one |
| `ValueCell` | Per-kind rendering; clipped values expose `title`; arrays expand one item per line; `null` renders visibly |
| `RowGrid` | Bounded columns; expansion opens a spanning sub-row; skeleton row count matches the column count |
| Completion | Given a `SchemaDto`, suggests that table's columns before sibling tables; suggests no identifier absent from the schema |
| `ORDER BY` assist | Fires for `LIMIT` without `ORDER BY`; silent when an `ORDER BY` is present; inserts the real primary key |
| Palette | Filters across all three sources; selection performs the same action as the mouse path |
| Accessibility | Focus is visible in all three themes; the palette and gear menu are dismissible with `Esc` and trap focus while open |

Existing frontend tests must keep passing. They mock `./api/commands` at the module
boundary, so a pure presentation change should not disturb them — if one breaks, that is
a real signal about changed behaviour, not a test to update.

## Out of scope

Multi-tab workspaces, saved/named queries, query result export, editing data (the app is
read-only by design), row-level detail modals, chart or visualisation views, custom
webfonts, and any change to the Rust backend.

## Known risks

- **Three themes triple the visual surface to check.** The token discipline test is the
  mitigation, but it cannot catch a token that is *wrong* in one theme — only one that is
  bypassed. Each theme needs looking at.
- **CodeMirror is the project's first substantial frontend dependency** and brings a
  transitive tree. It is also the piece most likely to fight Tailwind's reset; its styling
  is configured in JS rather than utility classes.
- **`localStorage` is not inspectable** in the config directory, so a wedged preference
  cannot be fixed by editing a file. `useTheme` falling back on an unrecognised value is
  the guard.
- **Elision can mislead.** Two principals sharing a head and tail elide identically.
  Copy-on-click and the `title` are the escape hatches; the grid must never be the only
  way to read a full identifier.
