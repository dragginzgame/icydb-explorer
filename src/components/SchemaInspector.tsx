import type { AppErrorDto, SchemaDto } from "../api/types";
import { ErrorBanner } from "./ErrorBanner";
import { Pane } from "./Pane";
import { SchemaPanel } from "./SchemaPanel";

/** The schema, as the right-hand inspector.
 *
 *  Collapsed it becomes a labelled rail rather than a bare sliver: the spec
 *  expects a reader to keep it collapsed most of the time, so the way back
 *  has to be visible and named. The rail keeps its own `aria-label` and a
 *  rotated visible label for that reason.
 *
 *  `Pane`'s drag handle always renders on its own trailing (right) edge. For
 *  every other pane that edge is a real boundary shared with the pane to its
 *  right. This is the rightmost pane, so its trailing edge is the window's
 *  outer edge, not a boundary — the boundary the user actually means to grab
 *  is this pane's *leading* (left) edge, shared with the pane before it.
 *  `resizeFrom="leading"` tells `Pane` to compute that inverted sign itself,
 *  next to the `originWidth` it already captures at drag start, so the
 *  correctness of the direction does not depend on `onResize` staying wired
 *  to any particular render — passing `onResize` straight through here is
 *  enough. (An earlier version negated the reported width in this
 *  component instead; that was only correct because of a coincidence in how
 *  `PaneHandle` captured its closure, and a perfectly reasonable freshness
 *  refactor to `PaneHandle` would have silently broken it. Moving the sign
 *  into `Pane` removes that trap.) */
export function SchemaInspector({
  schema,
  error,
  entity,
  collapsed,
  onToggle,
  width,
  onResize,
}: {
  schema: SchemaDto | null;
  error: AppErrorDto | null;
  entity: string | null;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onResize: (width: number) => void;
}) {
  if (collapsed) {
    // A failure has to be reachable from the collapsed state too. `collapsed`
    // persists across launches, and the error branch below is unreachable from
    // here, so a reader who keeps the inspector shut and selects a table on a
    // canister with introspection disabled would otherwise get silence in every
    // pane — the failure previously had the always-visible Tables aside to land
    // in, and no longer does.
    //
    // The marker is in the accessible NAME, not only in the glyph: a coloured
    // "!" alone is invisible to a screen reader and to anyone not looking at a
    // 32px rail. The name says a failure happened, not what it was —
    // `explanation` is prose that belongs in `ErrorBanner`, rendered whole,
    // which is one click away.
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={error ? "Expand schema — failed to load" : "Expand schema"}
        aria-expanded={false}
        className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 border-l border-rule bg-surface-1 text-xs font-semibold uppercase tracking-wide text-text-2 hover:bg-surface-2"
      >
        {error && (
          <span aria-hidden="true" className="text-base leading-none text-danger-text">
            !
          </span>
        )}
        <span className="[writing-mode:vertical-rl]">Schema</span>
      </button>
    );
  }

  return (
    <Pane
      title="Schema"
      width={width}
      onResize={onResize}
      resizeFrom="leading"
      className="border-l border-rule bg-surface-1"
      trailing={
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse schema"
          aria-expanded
          className="rounded-control px-1 text-xs text-text-3 hover:bg-surface-2"
        >
          ›
        </button>
      }
    >
      {error && <ErrorBanner error={error} />}
      {!error && schema && <SchemaPanel schema={schema} />}
      {!error && !schema && (
        <p className="p-3 text-sm text-text-3">
          {entity ? "Loading schema…" : "Select a table to see its schema."}
        </p>
      )}
    </Pane>
  );
}
