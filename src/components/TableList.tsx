import { useState } from "react";

import type { EntityDto } from "../api/types";
import {
  SORT_LABELS,
  sortEntities,
  type SortDirection,
  type SortField,
} from "../lib/sortTables";
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
  // Every hook before the early return below. The `useState` used to sit after
  // it — which React happens to tolerate in this shape, but it is a Rules of
  // Hooks violation and a second piece of state behind a conditional return
  // would be relying on that tolerance rather than on the rules.
  const [filter, setFilter] = useState("");
  const [field, setField] = useState<SortField>("declared");
  const [direction, setDirection] = useState<SortDirection>("asc");

  if (entities.length === 0) {
    return <PaneEmpty title="No tables">This canister doesn&apos;t expose any icydb entities.</PaneEmpty>;
  }

  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? entities.filter((entity) => entity.name.toLowerCase().includes(needle))
    : entities;
  // Filter first, then sort: sorting a list and then removing entries from it
  // gives the same answer, but sorting only what is on screen is less work and
  // the order of the two must be settled somewhere rather than left to chance.
  const shown = sortEntities(matching, counts, field, direction);

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
      {/* Offered from two tables up: below that there is nothing to order. */}
      {entities.length > 1 && (
        <div className="mx-2 my-1 flex items-center gap-1">
          <label className="text-xs text-text-3" htmlFor="table-sort">
            Sort
          </label>
          <select
            id="table-sort"
            value={field}
            onChange={(event) => setField(event.target.value as SortField)}
            className="min-w-0 flex-1 rounded-control border border-rule bg-surface-0 px-1 py-0.5 text-xs text-text-1"
          >
            {(Object.keys(SORT_LABELS) as SortField[]).map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setDirection((current) => (current === "asc" ? "desc" : "asc"))}
            aria-label={direction === "asc" ? "Sort descending" : "Sort ascending"}
            title={
              field === "rows"
                ? "A table whose rows have not been counted sorts last either way — no count is not a position on the scale."
                : direction === "asc"
                  ? "Ascending. Click for descending."
                  : "Descending. Click for ascending."
            }
            className="shrink-0 rounded-control border border-rule px-1.5 py-0.5 font-mono text-xs text-text-2 hover:bg-surface-2"
          >
            {direction === "asc" ? "↑" : "↓"}
          </button>
        </div>
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
