import { useState } from "react";

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

  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? entities.filter((entity) => entity.name.toLowerCase().includes(needle))
    : entities;

  return (
    <div>
      {/* Shown only where it earns its space. Below a handful of tables the eye
          is faster than the keyboard, and the box would just be chrome. */}
      {entities.length > 5 && (
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter tables"
          aria-label="Filter tables"
          className="mx-2 my-1 w-[calc(100%-1rem)] rounded-control border border-rule bg-surface-0 px-2 py-0.5 text-xs text-text-1 placeholder:text-text-3"
        />
      )}
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
      {needle && shown.length === 0 && (
        // Says what was searched for, so the reader can see the typo rather
        // than wonder whether the canister lost its tables.
        <p className="p-3 text-sm text-text-3">No table matches “{filter.trim()}”.</p>
      )}
      <ul className="text-sm">
        {shown.map((entity) => {
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
