import type { RowsDto } from "../api/types";
import { ValueCell } from "./ValueCell";

// `hasMore` is a prop, not something this component derives: scalar paging
// is LIMIT/OFFSET (see Task 10), and only the caller — which knows the
// requested page size and current offset — can tell whether another page
// may exist. That keeps this component a dumb, trivially testable renderer.
export function RowGrid({
  rows,
  hasMore,
  onLoadMore,
}: {
  rows: RowsDto;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  if (rows.rows.length === 0) {
    return <p className="p-4 text-sm text-text-2">No rows</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-surface-inset">
            <tr>
              {rows.columns.map((column) => (
                <th key={column} className="border-b border-rule px-2 py-1 text-left font-semibold">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((row, rowIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={rowIndex} className="border-b border-rule">
                {row.map((cell, cellIndex) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <td key={cellIndex} className="px-2 py-1">
                    <ValueCell value={cell} />
                  </td>
                ))}
              </tr>
            ))}
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
