import type { AppErrorDto, RowsDto, SweepOutcomeDto, ValueDto } from "../api/types";

/** The column prepended to a merged grid, naming which canister a row came from.
 *
 *  A leading underscore because it has to be distinguishable from a real column:
 *  an entity is free to have a field called `canister`, and a reader must be able
 *  to tell the explorer's annotation from the table's own data. */
export const ORIGIN_COLUMN = "_canister";

/** What one canister did, for the status strip. */
export type SweepStatus = {
  canister: string;
  /** The role, if known, since a principal is not something a reader recognises. */
  label: string;
  /**
   * - `rows`    — answered, with this many rows
   * - `empty`   — answered, and there are none here. A real answer.
   * - `refused` — could not answer. Neither a hit nor a miss: this canister has
   *               not told us anything about whether the rows exist, so it is
   *               never counted as an empty result.
   * - `other`   — answered with something that is not a row page (a schema, a
   *               count). Reported rather than merged, because there is no
   *               single grid those belong in.
   */
  state: "rows" | "empty" | "refused" | "other";
  rowCount: number;
  error: AppErrorDto | null;
};

/** A sweep, as the UI renders it. */
export type MergedSweep = {
  /** Every row that arrived, each tagged with its canister. `null` when no
   *  canister returned a row page at all — the same distinction `RowsDto | null`
   *  carries everywhere else in this app, so "nobody could look" never renders as
   *  "there is nothing there". */
  rows: RowsDto | null;
  /** One entry per canister asked, in the order asked. */
  statuses: SweepStatus[];
};

/** Merges per-canister outcomes into one grid plus a status per canister.
 *
 *  Three things this deliberately does not do:
 *
 *  It does not sort. Each canister ordered its own page, so concatenating them
 *  gives fleet order, not a global ordering — and re-sorting here would only sort
 *  the rows that happened to be fetched, which is not the same thing and must not
 *  be presented as if it were. The UI says "merged", never "ordered".
 *
 *  It does not treat a refusal as an empty result. A canister that could not
 *  answer has said nothing about whether rows exist there.
 *
 *  It does not reconcile disagreeing columns. Pool members share a schema, so
 *  their columns should match; if they do not, that is worth seeing rather than
 *  papering over, so the first answering canister's columns are used and any
 *  others are reported through `state: "other"` rather than being force-fitted.
 */
export function mergeSweep(
  outcomes: SweepOutcomeDto[],
  labels: (canister: string) => string,
): MergedSweep {
  const statuses: SweepStatus[] = [];
  let columns: string[] | null = null;
  let entity: string | null = null;
  const rows: ValueDto[][] = [];

  for (const outcome of outcomes) {
    const label = labels(outcome.canister);

    if (outcome.error || !outcome.result) {
      statuses.push({
        canister: outcome.canister,
        label,
        state: "refused",
        rowCount: 0,
        error: outcome.error,
      });
      continue;
    }

    if (outcome.result.type !== "rows") {
      statuses.push({
        canister: outcome.canister,
        label,
        state: "other",
        rowCount: 0,
        error: null,
      });
      continue;
    }

    const page = outcome.result;
    // The first answering canister sets the shape. A later one whose columns
    // disagree is not merged into it — see the doc comment.
    if (columns === null) {
      columns = page.columns;
      entity = page.entity;
    } else if (!sameColumns(columns, page.columns)) {
      statuses.push({
        canister: outcome.canister,
        label,
        state: "other",
        rowCount: page.rows.length,
        error: null,
      });
      continue;
    }

    for (const row of page.rows) {
      rows.push([{ kind: "text", display: label }, ...row]);
    }
    statuses.push({
      canister: outcome.canister,
      label,
      state: page.rows.length === 0 ? "empty" : "rows",
      rowCount: page.rows.length,
      error: null,
    });
  }

  return {
    rows:
      columns === null
        ? null
        : {
            entity: entity ?? "",
            columns: [ORIGIN_COLUMN, ...columns],
            rows,
            rowCount: rows.length,
            nextCursor: null,
          },
    statuses,
  };
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** A one-line summary of a sweep, for the header.
 *
 *  Says how many canisters answered as well as how many rows, because "12 rows"
 *  alone invites the reader to believe that is all of them — which it is not when
 *  one member of the pool refused.
 */
export function summarise(statuses: SweepStatus[]): string {
  const answered = statuses.filter((status) => status.state !== "refused").length;
  const refused = statuses.length - answered;
  const rows = statuses.reduce((total, status) => total + status.rowCount, 0);
  const canisters = `${answered} of ${statuses.length} ${statuses.length === 1 ? "canister" : "canisters"}`;

  return refused === 0
    ? `${rows} ${rows === 1 ? "row" : "rows"} from ${canisters}`
    : `${rows} ${rows === 1 ? "row" : "rows"} from ${canisters} — ${refused} could not be read`;
}
