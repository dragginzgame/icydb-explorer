import { useEffect, useRef, useState } from "react";

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
 *  worse than showing nothing.
 *
 *  Two layout rules, both learned the hard way:
 *
 *  `max-w-cell` and `truncate` match `ValueCell`'s other branches. Before them the
 *  only bound on this cell's width was however many characters `elide` happened
 *  to return — which for a group-based elision is unbounded in the length of the
 *  groups kept, so a long-grouped identifier blew the column out anyway.
 *
 *  The confirmation is absolutely positioned, so it contributes nothing to
 *  layout. Rendered in flow it widened the column for its 1200ms lifetime, and
 *  in a `table-auto` grid that shifts every column to its right and then snaps
 *  them back — clicking one ULID made the whole table jump. The live region is
 *  mounted empty from the start rather than appearing with the text, because a
 *  screen reader announces a change *within* an existing live region far more
 *  reliably than the insertion of a new one.
 *
 *  It overlays the *tail of its own value* (`right-0`) rather than sitting past
 *  it (`left-full`). Positioned past the value it left this cell's box entirely
 *  and painted over the next column's text — an elided identifier is only ~20
 *  characters wide, so there is almost always a neighbour right there. That
 *  merely traded a layout shift for unreadable overlapping text. Only the chip
 *  carries the opaque fill, not the live region, so the region can stay mounted
 *  without a permanent block sitting over the value. */
export function Identifier({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  // The pending hide, so a second click cannot have its confirmation cut short
  // by the first click's timer — and so nothing is left scheduled after this
  // row unmounts, which happens routinely as the grid pages.
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const copy = () => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      window.clearTimeout(hideTimer.current);
      setCopied(true);
      hideTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <span className="relative inline-flex max-w-cell align-baseline">
      <button
        type="button"
        onClick={copy}
        title={value}
        className={`min-w-0 truncate font-mono text-xs text-pk ${className ?? ""}`}
      >
        {elide(value)}
      </button>
      <span
        role="status"
        data-copy-confirmation="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center"
      >
        {copied ? (
          <span className="rounded-row bg-surface-2 px-1 whitespace-nowrap font-mono text-xs not-italic text-text-3">
            copied
          </span>
        ) : (
          ""
        )}
      </span>
    </span>
  );
}
