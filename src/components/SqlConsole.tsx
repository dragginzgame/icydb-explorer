import { useState } from "react";

import type { AppErrorDto, EntityDto, SchemaDto } from "../api/types";
import { applyOrderByAssist, orderByAssist, starterQuery } from "../lib/suggestSql";
import { SqlEditor } from "./SqlEditor";

export function SqlConsole({
  onRun,
  error,
  limitAppended,
  orderByMissing,
  entities,
  schema,
  target,
}: {
  onRun: (sql: string) => void;
  error?: AppErrorDto;
  /** The tables this canister exposes, for completing after `FROM`. */
  entities?: EntityDto[] | null;
  /** The selected table's schema, for completing its columns and for deriving
   *  the `ORDER BY` assist's real primary key. */
  schema?: SchemaDto | null;
  /** What this console runs against, named. Every statement here goes to one
   *  canister — each is its own icydb database — and nothing else on screen says
   *  which, so the bar has to. */
  target?: { canister: string; entity: string | null };
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
      {target && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          <span className="text-text-3">Querying</span>
          <span className="font-mono text-text-1">{target.canister}</span>
          {target.entity && (
            <>
              <span className="text-text-3">·</span>
              <span className="font-mono text-pk">{target.entity}</span>
            </>
          )}
          <span className="text-text-3">
            — each canister is a separate database, so a statement here reaches only this one.
          </span>
        </div>
      )}

      {sql.trim() === "" && target?.entity && (
        // An empty editor is where someone who does not write SQL gives up. The
        // shortest correct statement needs a bound (this app will not send an
        // unbounded read) and an ordering (icydb will not take the bound without
        // one) — longer than a newcomer would guess, so it is offered whole.
        <button
          type="button"
          onClick={() => setSql(starterQuery(target.entity!, schema ?? null))}
          className="self-start rounded-control border border-rule px-2 py-0.5 text-xs text-text-2 hover:bg-surface-2"
        >
          Start with{" "}
          <code className="font-mono text-accent">{starterQuery(target.entity, schema ?? null)}</code>
        </button>
      )}

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
            <b className="font-semibold text-warn-text">
              {assist.withLimit === null ? "ORDER BY required" : "Needs a limit and an order"}
            </b>
            <span className="text-text-3">
              {assist.withLimit === null
                ? "icydb rejects LIMIT without one."
                : "This explorer never reads a whole table, and icydb needs an order before it will page."}{" "}
              Press <kbd className="rounded-row border border-rule px-1 font-mono">⇥</kbd> to insert{" "}
              <code className="font-mono text-accent">{assist.insertion}</code>.
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
        {orderByMissing && !assist && (
          // Only reachable when the assist could not be built — no schema, so no
          // real primary key to offer. Prose is the fallback, never the plan.
          <span className="text-sm text-text-2">
            This statement needs an ORDER BY before icydb will page it. Select a table in the
            Tables pane and this console can fill one in for you.
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
