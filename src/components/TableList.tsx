import type { EntityDto } from "../api/types";
import { PaneEmpty } from "./PaneStates";

/// A table's row count, once someone has asked for it.
///
/// Absent from the map means "not counted"; `null` means the count was
/// attempted and failed. The two are shown differently on purpose — a table
/// whose count could not be read is a fact worth seeing, and rendering it as
/// blank would make it look merely uncounted.
export type RowCounts = Record<string, number | null>;

export function TableList({
  entities,
  selected,
  onSelect,
  counts,
  onCount,
  counting,
}: {
  entities: EntityDto[];
  selected: string | null;
  onSelect: (name: string) => void;
  counts?: RowCounts;
  onCount?: () => void;
  counting?: boolean;
}) {
  if (entities.length === 0) {
    return <PaneEmpty title="No tables">This canister doesn&apos;t expose any icydb entities.</PaneEmpty>;
  }

  return (
    <div>
      {onCount && (
        // Counting is user-initiated because each count is a full scan: one
        // statement per table, which is free against an empty local replica
        // and careless against a production canister. The schema facts beside
        // it (columns, indexes) came with SHOW ENTITIES and cost nothing.
        <button
          type="button"
          onClick={onCount}
          disabled={counting}
          className="mx-2 my-1 rounded-control border border-rule px-2 py-0.5 text-xs text-text-2 hover:bg-surface-2 disabled:text-text-3"
        >
          {counting ? "Counting…" : "Count rows"}
        </button>
      )}
      <ul className="text-sm">
        {entities.map((entity) => {
          const isSelected = entity.name === selected;
          const counted = counts && entity.name in counts ? counts[entity.name] : undefined;
          return (
            <li key={entity.name}>
              <button
                type="button"
                onClick={() => onSelect(entity.name)}
                className={`block w-full rounded-row px-2 py-1 text-left ${
                  isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"
                }`}
              >
                <div>{entity.name}</div>
                <div className={`text-xs ${isSelected ? "text-sel-text" : "text-text-3"}`}>
                  {entity.columns} columns · {entity.indexes} indexes
                  {counted !== undefined &&
                    (counted === null
                      ? " · count unavailable"
                      : ` · ${counted.toLocaleString()} ${counted === 1 ? "row" : "rows"}`)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
