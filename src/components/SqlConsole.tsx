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
        className="w-full rounded border p-2 font-mono text-sm"
        placeholder="SELECT * FROM ..."
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRun(sql)}
          className="self-start rounded border px-3 py-1 text-sm hover:bg-gray-100"
        >
          Run
        </button>
        {limitAppended && (
          <span className="text-sm text-gray-500">A default LIMIT was added to this query.</span>
        )}
        {orderByMissing && (
          <span className="text-sm text-gray-500">
            No LIMIT was added: this SELECT has no ORDER BY, and icydb requires one before it will
            allow pagination. Add an ORDER BY (e.g. by any column) to enable a default LIMIT.
          </span>
        )}
      </div>
      {error && (
        <p className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {error.explanation}
        </p>
      )}
    </div>
  );
}
