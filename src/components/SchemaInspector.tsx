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
 *  `Pane`'s drag handle always sits on its own trailing (right) edge. For
 *  every other pane that edge is a real boundary shared with the pane to its
 *  right. This is the rightmost pane, so its trailing edge is the window's
 *  outer edge, not a boundary — the boundary the user actually means to grab
 *  is this pane's *leading* (left) edge, shared with the pane before it.
 *  Rather than adding an `edge` prop to `Pane` (a shared component with its
 *  own test suite, not owned by this task), the drag is passed through
 *  negated: `Pane` reports `width + delta` as if growing rightward grew the
 *  pane, and `invertResize` below turns that back into `width - delta` —
 *  dragging the handle rightward now shrinks the inspector and dragging it
 *  leftward grows it, which is the direction that actually matches moving
 *  the shared boundary with the pane to the left. */
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
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand schema"
        aria-expanded={false}
        className="flex w-8 shrink-0 items-center justify-center border-l border-rule bg-surface-1 text-xs font-semibold uppercase tracking-wide text-text-2 hover:bg-surface-2"
      >
        <span className="[writing-mode:vertical-rl]">Schema</span>
      </button>
    );
  }

  const invertResize = (proposedWidth: number) => onResize(2 * width - proposedWidth);

  return (
    <Pane
      title="Schema"
      width={width}
      onResize={invertResize}
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
