import { useState } from "react";

import type { RowsDto } from "../api/types";

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
}: {
  rows: RowsDto;
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState<Expanded>(null);

  const toggle = (row: number, column: number) =>
    setExpanded((current) =>
      current && current.row === row && current.column === column ? null : { row, column },
    );

  // Loading and empty are different states. Skeletons carry the real column
  // count so the grid does not reflow when data lands.
  if (loading && rows.rows.length === 0) {
    return (
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
          {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
            <tr key={rowIndex} className="border-b border-rule">
              {rows.columns.map((column) => (
                <td key={column} className="px-2 py-1">
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

  if (rows.rows.length === 0) {
    return <p className="p-4 text-sm text-text-3">No rows</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto">
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
              const openColumn =
                expanded && expanded.row === rowIndex ? expanded.column : null;
              return (
                // eslint-disable-next-line react/no-array-index-key
                <ExpandableRow
                  key={rowIndex}
                  row={row}
                  rowIndex={rowIndex}
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

/** One data row plus, when a cell is expanded, the sub-row beneath it.
 *
 *  Split out because a row renders as two sibling `<tr>`s, which a `.map` in the
 *  parent cannot express without a fragment per row — and the fragment would
 *  need the key, obscuring which element it belongs to. */
function ExpandableRow({
  row,
  rowIndex,
  openColumn,
  onToggle,
}: {
  row: RowsDto["rows"][number];
  rowIndex: number;
  openColumn: number | null;
  onToggle: (row: number, column: number) => void;
}) {
  return (
    <>
      {/* Zebra on `surface-1`, not `surface-inset`: the sticky header uses
          `surface-inset`, so zebra there would make every other data row the
          same colour as the header and defeat both cues at once. */}
      <tr className="border-b border-rule odd:bg-surface-1">
        {row.map((cell, columnIndex) => (
          // eslint-disable-next-line react/no-array-index-key
          <td key={columnIndex} className="px-2 py-1 align-top">
            <ValueCell
              value={cell}
              expanded={openColumn === columnIndex}
              onToggle={
                isExpandable(cell) ? () => onToggle(rowIndex, columnIndex) : undefined
              }
            />
          </td>
        ))}
      </tr>
      {openColumn !== null && (
        <tr className="border-b border-rule">
          <td colSpan={row.length} className="bg-surface-2 px-2 py-2 pl-8">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-2">
              {formatExpanded(row[openColumn].display)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
