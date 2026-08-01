import { useState } from "react";

import type { AppErrorDto, EntityDto, SchemaDto } from "../api/types";
import { applyOrderByAssist, orderByAssist } from "../lib/suggestSql";
import { SqlEditor } from "./SqlEditor";

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
  const assist = orderByAssist(sql, schema ?? null);

  return (
    <div className="flex flex-col gap-2">
      <SqlEditor value={sql} onChange={setSql} entities={entities} schema={schema} />

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
