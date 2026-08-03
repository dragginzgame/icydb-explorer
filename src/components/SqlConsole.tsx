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
      <SqlEditor
        value={sql}
        onChange={setSql}
        entities={entities}
        schema={schema}
        onRun={() => onRun(sql)}
        onTakeAssist={() => {
          if (!assist) return false;
          setSql(applyOrderByAssist(sql, assist));
          return true;
        }}
      />

      {/* A hint strip, not a button. icydb rejects LIMIT without an explicit
          ordering — the most-hit failure in this app — so this names the rule,
          says why, and offers the keystroke, in that order. A reader who
          understands the rule after reading it once does not need the button
          again; they need the key. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {assist ? (
          <>
            <b className="font-semibold text-warn-text">ORDER BY required</b>
            <span className="text-text-3">
              icydb rejects LIMIT without one. Press{" "}
              <kbd className="rounded-row border border-rule px-1 font-mono">⇥</kbd> to insert{" "}
              <code className="font-mono text-accent">{assist}</code>.
            </span>
          </>
        ) : (
          <span className="text-text-3">
            {limitAppended ? "A default LIMIT was added to this query." : ""}
          </span>
        )}
        <span className="ml-auto text-text-3">
          <kbd className="rounded-row border border-rule px-1 font-mono">⌘⏎</kbd> run
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRun(sql)}
          className="self-start rounded-control border border-rule px-3 py-1 text-sm hover:bg-surface-2"
        >
          Run
        </button>
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
