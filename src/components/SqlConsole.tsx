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

  // Whatever the statement needs next, and only ever one of them: two would be
  // two answers to "what do I do now". Built here rather than inline so it can
  // sit on the header row *and* decide whether that row is worth drawing.
  //
  // Each is short and carries its reasoning on hover: the rule is worth reading
  // once, the keystroke is worth seeing every time.
  const hint = assist ? (
    <button
      type="button"
      onClick={() => setSql(applyOrderByAssist(sql, assist))}
      title={
        assist.withLimit === null
          ? "icydb rejects LIMIT without an explicit ordering, so this statement cannot run as written. Inserts the primary key ordering."
          : "This explorer never reads a whole table, and icydb needs an ordering before it will page. Inserts both."
      }
      className="rounded-control border border-warn-border bg-warn-bg px-2 py-0.5 text-warn-text"
    >
      <b className="font-semibold">
        {assist.withLimit === null ? "ORDER BY required" : "Needs a limit and an order"}
      </b>{" "}
      <span className="opacity-80">
        <kbd className="font-mono">⇥</kbd> {assist.insertion}
      </span>
    </button>
  ) : sql.trim() === "" && target?.entity ? (
    <button
      type="button"
      onClick={() => setSql(starterQuery(target.entity!, schema ?? null))}
      title="Fills the editor with a complete, runnable statement for the selected table — bounded and ordered, both of which are required."
      className="rounded-control border border-rule px-2 py-0.5 text-text-2 hover:bg-surface-2"
    >
      Start with{" "}
      <code className="font-mono text-accent">{starterQuery(target.entity, schema ?? null)}</code>
    </button>
  ) : limitAppended ? (
    <span className="text-text-3" title="This explorer never reads a whole table.">
      A default LIMIT was added.
    </span>
  ) : orderByMissing ? (
    // Only reachable when no assist could be built — no schema, so no real
    // primary key to offer. Prose is the fallback, never the plan.
    <span
      className="text-text-2"
      title="Select a table in the Tables pane and this console can fill in the ordering for you."
    >
      Needs an ORDER BY before icydb will page it.
    </span>
  ) : null;

  return (
    <div className="flex flex-col gap-2">
      {/* One header line: what this queries on the left, what the statement needs
          next on the right. The hint had a row of its own under the input, which
          spent a third row of a bar whose whole point is to be small — and put
          the advice below the thing it was advising about. Drawn only when it
          would hold something, so an empty one never costs a gap. */}
      {(target || hint) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {target && (
            <>
              <span className="text-text-3">Querying</span>
              <span className="font-mono text-text-1">{target.canister}</span>
              {target.entity && (
                <>
                  <span className="text-text-3">·</span>
                  <span className="font-mono text-pk">{target.entity}</span>
                </>
              )}
              {/* Short inline, reason on hover. Sharing the row with the hint
                  leaves no space for the sentence, and it is a thing worth
                  learning once rather than reading every session. */}
              <span
                className="text-text-3"
                title="Each canister carries its own icydb database, so a statement here reaches one and only one of them."
              >
                — one canister only
              </span>
            </>
          )}

          {/* The row's trailing end, so the target reads left and the advice
              right rather than the two running together as one sentence. */}
          <div className="ml-auto flex items-center gap-2">{hint}</div>
        </div>
      )}

      {/* Run sits beside the input, not under it. The editor is usually one line,
          so a button on its own row below reads as a second, separate thing —
          where next to the input it reads as what you do with what you typed.
          `items-stretch` makes it exactly as tall as the input, whatever height
          the input has, rather than guessing at a matching padding that would
          drift the moment the editor's line-height or padding changed. */}
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1">
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
        </div>
        {/* One control, not a button beside a hint about a shortcut: the shortcut
            is a property of the button, so it lives on it. */}
        <button
          type="button"
          onClick={() => onRun(sql)}
          // No vertical padding of its own: the row's height comes from the
          // editor, and padding here would fight `items-stretch` for it.
          className="flex shrink-0 items-center gap-1.5 rounded-control border border-rule px-3 text-xs text-text-1 hover:bg-surface-2"
        >
          Run
          <kbd className="rounded-row border border-rule px-1 font-mono text-text-3">⌘⏎</kbd>
        </button>
      </div>

      {error && (
        <p className="whitespace-pre-wrap rounded-control border border-danger-border bg-danger-bg p-2 text-sm text-danger-text">
          {error.explanation}
        </p>
      )}
    </div>
  );
}
