import { useState } from "react";

import type { RowsDto } from "../api/types";

import { PaneEmpty } from "./PaneStates";
import { ValueCell, formatExpanded, isExpandable } from "./ValueCell";

// Enough rows to fill the pane without implying a page size we do not know.
const SKELETON_ROWS = 8;

/** Which cell is expanded, if any. One at a time: two open sub-rows in a wide
 *  table push the row you were reading off-screen. */
type Expanded = { row: number; column: number } | null;

// `hasMore` is a prop, not something this component derives: scalar paging
// is LIMIT/OFFSET, and only the caller — which knows the requested page size
// and current offset — can tell whether another page may exist. That keeps
// this component a dumb, trivially testable renderer.
export function RowGrid({
  rows,
  hasMore,
  onLoadMore,
  loading = false,
  skeletonColumns,
}: {
  /** The page to render, or `null` when there is no page: a fetch is in flight
   *  (with `loading`) or one failed (without it). Nullable rather than a
   *  caller-synthesised empty `RowsDto`, because every synthesised shape has to
   *  come from *somewhere* — and the only shape a caller has lying around is the
   *  previously selected entity's, which is the wrong table's. */
  rows: RowsDto | null;
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
  /** How many columns the entity being loaded has, for sizing skeletons while
   *  `rows` is null. A count, not names: the caller knows the arity from
   *  `EntityDto.columns` before any row arrives, but not the names — those come
   *  with the schema or the first page. See the skeleton branch below for what
   *  is drawn in the header when the names are not known yet. */
  skeletonColumns?: number;
}) {
  const [expanded, setExpanded] = useState<Expanded>(null);

  // `expanded` holds indices into `rows`, so it is only meaningful for the data
  // it was captured against. The grid now stays mounted across a fetch (which is
  // what wiring `loading` requires), so without this a cell open in column 4 of
  // a 6-column entity would leave `row[openColumn]` undefined the moment a
  // 2-column entity arrived — a TypeError with no error boundary above it.
  //
  // The identity is the entity plus the column count, NOT the row count:
  // `loadMore` appends rows, and an open sub-row surviving that is the desired
  // behaviour. `null` is its own identity, so the null `rows` that a caller
  // passes while a fetch is in flight also clears the expansion — which means
  // in `App` the clearing happens one render *earlier* than the new entity's
  // data arriving. That does not make the entity/arity comparison redundant:
  // it is what covers a caller that swaps one page for another without a null
  // in between (`SqlResultView`, and any future one), which is the case
  // `RowGrid.test.tsx` drives directly.
  //
  // Adjusting state during render (rather than in an effect) is React's
  // documented pattern for exactly this — it discards the stale render before
  // anything is committed, so no sub-row ever paints against the wrong data.
  const identity = rows === null ? null : `${rows.entity}/${rows.columns.length}`;
  const [seenIdentity, setSeenIdentity] = useState<string | null>(identity);
  if (seenIdentity !== identity) {
    setSeenIdentity(identity);
    setExpanded(null);
  }
  const live: Expanded = seenIdentity === identity ? expanded : null;

  const toggle = (row: number, column: number) =>
    setExpanded((current) =>
      current && current.row === row && current.column === column ? null : { row, column },
    );

  // Loading, empty, failed and "nothing selected" are four different states.
  // Skeletons carry the real column count so the grid does not reflow when data
  // lands — the count comes from `rows` when a page is already in hand, and from
  // `skeletonColumns` (the selected entity's own arity) when one is not.
  if (loading && (rows === null || rows.rows.length === 0)) {
    const columnNames = rows?.columns ?? null;
    const columnCount = columnNames?.length ?? skeletonColumns ?? 0;
    // Nothing to size against: the caller owns the empty state, and a
    // zero-column table would be noise on top of it.
    if (columnCount === 0) return null;
    return <RowSkeletons columnCount={columnCount} columnNames={columnNames} />;
  }

  // A fetch that is no longer in flight and produced nothing: a rejection. The
  // caller renders the error; this must not fall through to "No rows", which
  // would claim the table is empty when nobody managed to look.
  if (rows === null) return null;

  if (rows.rows.length === 0) {
    return <PaneEmpty title="No rows">{rows.entity} doesn&apos;t have any rows yet.</PaneEmpty>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-surface-inset">
            <tr>
              {rows.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((row, rowIndex) => {
              const openColumn = live && live.row === rowIndex ? live.column : null;
              return (
                // eslint-disable-next-line react/no-array-index-key
                <ExpandableRow
                  key={rowIndex}
                  row={row}
                  rowIndex={rowIndex}
                  columns={rows.columns}
                  openColumn={openColumn}
                  onToggle={toggle}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          className="self-start rounded-control border border-rule px-3 py-1 text-sm hover:bg-surface-2"
        >
          Load more
        </button>
      )}
    </div>
  );
}

/** The loading grid: a header row and `SKELETON_ROWS` placeholder rows at the
 *  entity's real column count, so nothing reflows when the data lands.
 *
 *  `columnNames` is null on a first load — the caller knows the arity from
 *  `EntityDto.columns` long before it knows the names, which arrive with the
 *  schema or the first page. In that case each header cell gets a skeleton bar
 *  rather than a name.
 *
 *  A bar, not an empty `<th>`: an empty cell has no line box, so the header row
 *  would be shorter than the real one and the whole grid would shift down by a
 *  few pixels the moment the names arrived — the exact reflow this component
 *  exists to prevent, reintroduced in the one row that frames everything else.
 *  And a bar, not a guessed name: inventing "column 1" would be a claim about
 *  the data, and the previous entity's names (what this used to show) were a
 *  false one. The tradeoff is that a reader cannot tell *which* columns are
 *  coming until they arrive; they can tell how many, and that the pane is
 *  working rather than empty, which is what the skeleton is for. */
function RowSkeletons({
  columnCount,
  columnNames,
}: {
  columnCount: number;
  columnNames: string[] | null;
}) {
  const columns = Array.from({ length: columnCount }, (_, index) => index);

  return (
    <table className="min-w-full border-collapse text-sm">
      <thead className="sticky top-0 bg-surface-inset">
        <tr>
          {columns.map((columnIndex) => (
            <th
              key={columnIndex}
              className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
            >
              {columnNames ? (
                columnNames[columnIndex]
              ) : (
                <div
                  data-skeleton="true"
                  aria-hidden="true"
                  className="h-3 w-16 rounded-row bg-surface-2"
                />
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
          <tr key={rowIndex} className="border-b border-rule">
            {columns.map((columnIndex) => (
              <td key={columnIndex} className="px-2 py-1">
                <div
                  data-skeleton="true"
                  aria-hidden="true"
                  className="h-3 w-24 rounded-row bg-surface-2"
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One data row plus, when a cell is expanded, the sub-row beneath it.
 *
 *  Split out because a row renders as two sibling `<tr>`s, which a `.map` in the
 *  parent cannot express without a fragment per row — and the fragment would
 *  need the key, obscuring which element it belongs to. */
function ExpandableRow({
  row,
  rowIndex,
  columns,
  openColumn,
  onToggle,
}: {
  row: RowsDto["rows"][number];
  rowIndex: number;
  columns: string[];
  openColumn: number | null;
  onToggle: (row: number, column: number) => void;
}) {
  // Stripe by the row's position in the *data*, not in the DOM. The sub-row
  // rendered below (when this row's cell is open) is itself a sibling `<tr>`
  // in the same `<tbody>`, so an `nth-child`-based selector (Tailwind's
  // `odd:`) would count it too — inserting or removing that one extra `<tr>`
  // shifts the DOM parity of every row beneath it, and the banding would
  // visibly reshuffle on every expand/collapse. Keying off `rowIndex` instead
  // ties the stripe to the data, so a sub-row appearing or disappearing next
  // to it cannot move it.
  const striped = rowIndex % 2 === 0;

  // Belt as well as braces. The parent invalidates `expanded` when the data's
  // identity changes, but this row is the place the stale index would actually
  // throw, and a TypeError here has no error boundary above it — it blanks the
  // window. Resolving the cell once, defensively, makes an out-of-range index
  // render nothing instead.
  const openCell = openColumn === null ? undefined : row[openColumn];

  return (
    <>
      {/* Zebra on `surface-1`, not `surface-inset`: the sticky header uses
          `surface-inset`, so zebra there would make every other data row the
          same colour as the header and defeat both cues at once. */}
      <tr className={["border-b border-rule", striped && "bg-surface-1"].filter(Boolean).join(" ")}>
        {row.map((cell, columnIndex) => (
          // eslint-disable-next-line react/no-array-index-key
          <td key={columnIndex} className="px-2 py-1 align-top">
            <ValueCell
              value={cell}
              column={columns[columnIndex]}
              expanded={openColumn === columnIndex}
              onToggle={
                isExpandable(cell) ? () => onToggle(rowIndex, columnIndex) : undefined
              }
            />
          </td>
        ))}
      </tr>
      {openCell && (
        <tr className="border-b border-rule">
          <td colSpan={row.length} className="bg-surface-2 px-2 py-2 pl-8">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-2">
              {formatExpanded(openCell.display)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
