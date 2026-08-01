import { useState } from "react";

import type { AppErrorDto, EntityDto, SchemaDto } from "../api/types";
import { applyOrderByAssist, applySuggestion, orderByAssist, suggestSql } from "../lib/suggestSql";

export function SqlConsole({
  onRun,
  error,
  limitAppended,
  orderByMissing,
  entities,
  schema,
}: {
  onRun: (sql: string) => void;
  error?: AppErrorDto;
  /** The tables this canister exposes, for completing after `FROM`. */
  entities?: EntityDto[] | null;
  /** The selected table's schema, for completing its columns and for deriving
   *  the `ORDER BY` assist's real primary key. */
  schema?: SchemaDto | null;
  limitAppended?: boolean;
  /** No default `LIMIT` was appended specifically because the statement has
   * no `ORDER BY` — icydb rejects `LIMIT`/`OFFSET` without one, so this asks
   * the user to add one rather than silently doing nothing. */
  orderByMissing?: boolean;
}) {
  const [sql, setSql] = useState("");
  const suggestions = suggestSql(sql, entities ?? null, schema ?? null).slice(0, 8);
  const assist = orderByAssist(sql, schema ?? null);

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        rows={4}
        spellCheck={false}
        className="w-full rounded-control border border-rule p-2 font-mono text-sm"
        placeholder="SELECT * FROM ..."
      />
      {assist && (
        // icydb rejects LIMIT without an explicit ordering, and that is the
        // most-hit failure in this app. Offered as one click using the real
        // primary key, rather than left as an error to read afterwards.
        <button
          type="button"
          onClick={() => setSql(applyOrderByAssist(sql, assist))}
          className="self-start rounded-control border border-warn-border bg-warn-bg px-2 py-0.5 text-xs text-warn-text"
        >
          Add “{assist}” — icydb needs an ordering before LIMIT
        </button>
      )}

      {suggestions.length > 0 && (
        // Capped at eight. A longer list is the scrolling the schema pane
        // already offers, and stops being a suggestion.
        <ul className="flex flex-wrap gap-1" aria-label="SQL suggestions">
          {suggestions.map((suggestion) => (
            <li key={`${suggestion.kind}:${suggestion.text}`}>
              <button
                type="button"
                onClick={() => setSql(applySuggestion(sql, suggestion.text))}
                title={suggestion.detail}
                className={`rounded-control border border-rule px-2 py-0.5 font-mono text-xs hover:bg-surface-2 ${
                  suggestion.kind === "column" ? "text-pk" : "text-text-2"
                }`}
              >
                {suggestion.text}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRun(sql)}
          className="self-start rounded-control border border-rule px-3 py-1 text-sm hover:bg-surface-2"
        >
          Run
        </button>
        {limitAppended && (
          <span className="text-sm text-text-2">A default LIMIT was added to this query.</span>
        )}
        {orderByMissing && (
          <span className="text-sm text-text-2">
            No LIMIT was added: this SELECT has no ORDER BY, and icydb requires one before it will
            allow pagination. Add an ORDER BY (e.g. by any column) to enable a default LIMIT.
          </span>
        )}
      </div>
      {error && (
        <p className="whitespace-pre-wrap rounded-control border border-danger-border bg-danger-bg p-2 text-sm text-danger-text">
          {error.explanation}
        </p>
      )}
    </div>
  );
}
