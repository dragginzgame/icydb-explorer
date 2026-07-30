import { useState } from "react";
import type { AppErrorDto } from "../api/types";

export function SqlConsole({
  onRun,
  error,
  limitAppended,
}: {
  onRun: (sql: string) => void;
  error?: AppErrorDto;
  limitAppended?: boolean;
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
      </div>
      {error && (
        <p className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {error.explanation}
        </p>
      )}
    </div>
  );
}
