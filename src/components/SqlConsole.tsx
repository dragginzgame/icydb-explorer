import { useState } from "react";
import type { AppErrorDto } from "../api/types";

export function SqlConsole({
  onRun,
  error,
  limitAppended,
  orderByMissing,
}: {
  onRun: (sql: string) => void;
  error?: AppErrorDto;
  limitAppended?: boolean;
  /** No default `LIMIT` was appended specifically because the statement has
   * no `ORDER BY` — icydb rejects `LIMIT`/`OFFSET` without one, so this asks
   * the user to add one rather than silently doing nothing. */
  orderByMissing?: boolean;
}) {
  const [sql, setSql] = useState("");

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
