import type { ReactNode } from "react";

/** A pane: a header that stays put, one scroll region, and an optional drag
 *  handle on the trailing edge.
 *
 *  The single scroll region is the point. Before this, the rows pane had a
 *  scroll container in `App.tsx` *and* another inside `RowGrid`, so the inner
 *  one was the sticky header's nearest scrollport, its `scrollTop` never left
 *  0, and `sticky top-0` silently did nothing. One owner per pane, and the
 *  owner is the pane. */
export function Pane({
  title,
  children,
  width,
  onResize,
  trailing,
  className,
}: {
  title: string;
  children: ReactNode;
  width?: number;
  onResize?: (width: number) => void;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`relative flex min-w-0 flex-col ${width === undefined ? "flex-1" : "shrink-0"} ${className ?? ""}`}
      style={width === undefined ? undefined : { width }}
      aria-label={title}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">{title}</h2>
        {trailing}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {onResize && <PaneHandle width={width} onResize={onResize} label={title} />}
    </section>
  );
}

/** The drag handle on a pane's trailing edge.
 *
 *  A `separator` with `aria-orientation="vertical"` because that is what this
 *  is; the drag is tracked on `window` rather than on the handle so that moving
 *  the pointer faster than React re-renders does not drop the drag. */
function PaneHandle({
  width,
  onResize,
  label,
}: {
  width?: number;
  onResize: (width: number) => void;
  label: string;
}) {
  const start = (event: React.PointerEvent) => {
    const originX = event.clientX;
    const originWidth = width ?? 0;

    const move = (moveEvent: PointerEvent) =>
      onResize(originWidth + (moveEvent.clientX - originX));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      onPointerDown={start}
      className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-accent"
    />
  );
}
