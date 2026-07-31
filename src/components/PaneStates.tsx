import type { ReactNode } from "react";

/** A pane's designed empty state: "an invitation naming the space, one
 *  explanatory line, and the action if there is one" (the design spec's own
 *  words, verbatim). Every pane that has nothing to show — no selection made
 *  yet, or a selection that genuinely has nothing in it — funnels through
 *  here, so a reader learns what "empty" looks like once and recognises it
 *  everywhere instead of meeting a different blank per pane.
 *
 *  `title` is the label naming what the pane is showing right now ("No rows",
 *  "No table selected"); `children`, when given, is the one line that says
 *  something true about *why* — never a restatement of the title. `action`
 *  renders last and is only ever passed where a real action exists; no call
 *  site invents one just to fill the slot.
 *
 *  Deliberately renders no `data-skeleton` marker anywhere: distinguishing an
 *  empty pane from a loading one is the entire point of this phase, and the
 *  loading state (see `RowGrid`'s skeleton rows) is the thing this must never
 *  be mistaken for. */
export function PaneEmpty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-1 p-4 text-sm">
      <p className="font-semibold text-text-2">{title}</p>
      {children && <p className="text-text-3">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
