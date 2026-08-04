import type { SweepStatus } from "../lib/mergeSweep";
import { summarise } from "../lib/mergeSweep";

import { PaneEmpty } from "./PaneStates";

/** What each canister in a sweep did.
 *
 *  A strip above the grid rather than a column inside it, because these are facts
 *  about the *canisters*, not about the rows — and one of them (a refusal) has no
 *  rows to attach itself to. Without this, a canister that could not be read would
 *  simply be missing from the result, and a sweep silently short of a member reads
 *  as a complete answer.
 *
 *  State is in the form as well as the number: a refusal takes the danger tokens
 *  and a distinct dot, so "one of these did not answer" is visible without
 *  reading any of them.
 */
export function SweepStatusStrip({ statuses }: { statuses: SweepStatus[] }) {
  return (
    <div className="flex flex-col gap-1 border-b border-rule px-2 py-1.5">
      <div className="text-xs text-text-2">{summarise(statuses)}</div>
      <div className="flex flex-wrap gap-1">
        {statuses.map((status) => (
          <Chip key={status.canister} status={status} />
        ))}
      </div>
    </div>
  );
}

function Chip({ status }: { status: SweepStatus }) {
  const refused = status.state === "refused";
  const other = status.state === "other";

  return (
    <span
      // The reason lives on the chip, because "why could this one not be read"
      // is the first question a refusal raises and the answer is per-canister.
      title={
        refused
          ? (status.error?.explanation ??
            "This canister could not be read, and has said nothing about whether these rows exist there.")
          : other
            ? "This canister answered with something that does not merge into one grid — a different set of columns, or a result that is not a page of rows."
            : `${status.canister} · ${status.rowCount} ${status.rowCount === 1 ? "row" : "rows"}`
      }
      className={[
        "flex items-center gap-1.5 rounded-row border px-1.5 font-mono text-xs",
        refused
          ? "border-danger-border bg-danger-bg text-danger-text"
          : other
            ? "border-warn-border bg-warn-bg text-warn-text"
            : "border-rule bg-surface-1 text-text-2",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "size-1.5 shrink-0 rounded-full",
          refused
            ? "bg-danger-text"
            : other
              ? "bg-warn-text"
              : status.state === "empty"
                ? "bg-text-3"
                : "bg-accent",
        ].join(" ")}
      />
      {status.label}
      <span className="text-text-3">
        {refused
          ? "unreadable"
          : other
            ? "not merged"
            : status.state === "empty"
              ? "no rows"
              : `${status.rowCount}`}
      </span>
    </span>
  );
}

/** The state where every canister refused.
 *
 *  Deliberately not "No rows": nobody managed to look, which is a different
 *  situation from looking and finding nothing. Conflating them is the single most
 *  misleading thing a fan-out can do, and this is the branch where it would
 *  happen.
 */
export function SweepAllRefused({ statuses }: { statuses: SweepStatus[] }) {
  return (
    <PaneEmpty title="Nothing could be read">
      None of the {statuses.length} canisters answered, so this says nothing about whether the rows
      exist. Each chip above carries its own reason.
    </PaneEmpty>
  );
}
