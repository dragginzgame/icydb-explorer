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
//
// `blob` is deliberately absent. `src-tauri/src/view/value.rs` renders a blob as
// `"<n> bytes"` — a human-readable label, not the value — so routing it here
// would offer a copy affordance that puts the literal string "1024 bytes" on the
// clipboard and confirms success. A misleading action is worse than inert text.
const IDENTIFIER_KINDS = new Set(["principal", "ulid", "subaccount", "account"]);

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

  // Numbers are not exempt from the width cap: `intbig`/`natbig` are arbitrary
  // precision and `nat128` reaches 39 digits, so an uncapped numeric column
  // blows out exactly like a structured one. They stay non-expandable — a
  // sub-row of re-indented digits would say nothing — so `title` is the only
  // route to the full value and must always be there.
  if (NUMERIC_KINDS.has(kind)) {
    return (
      <div className="max-w-88 truncate text-right tabular-nums" title={display}>
        {display}
      </div>
    );
  }

  if (IDENTIFIER_KINDS.has(kind)) {
    return <Identifier value={display} />;
  }

  // `title` is load-bearing here, not a nicety. `CLIP_AFTER` counts characters
  // while `max-w-88` is 352 pixels — unrelated units that do not coincide, so a
  // 45-character value of digits or capitals overflows the box and clips while
  // `isExpandable` still reports false. Without `title` there is then no
  // tooltip and no chevron, and the value is unreadable by any means.
  if (!isExpandable(value) || !onToggle) {
    return (
      <div className="max-w-88 truncate" title={display}>
        {display}
      </div>
    );
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
