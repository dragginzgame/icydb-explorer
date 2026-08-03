import { useEffect, useRef, type ReactNode } from "react";

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
  resizeFrom = "trailing",
  trailing,
  className,
}: {
  title: string;
  children: ReactNode;
  width?: number;
  onResize?: (width: number) => void;
  /** Which edge of the pane the drag handle's motion is measured from.
   *  `"trailing"` (the default, and every caller before this one) means the
   *  handle sits on a real boundary shared with the pane to the right:
   *  dragging it rightward grows the pane, matching the handle's own visual
   *  position. `"leading"` is for a pane with nothing to its right — the
   *  handle still renders on the trailing edge, but the boundary it actually
   *  represents is the pane's *left* edge, shared with the pane before it, so
   *  the sign is inverted: dragging rightward (away from that shared
   *  boundary) shrinks the pane instead of growing it. Computed here, next to
   *  `originWidth`, rather than by having a caller negate the reported width
   *  itself — the correctness then does not depend on how `PaneHandle`
   *  happens to capture `width`. */
  resizeFrom?: "leading" | "trailing";
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={["relative flex min-w-0 flex-col", width === undefined ? "flex-1" : "shrink-0", className]
        .filter(Boolean)
        .join(" ")}
      style={width === undefined ? undefined : { width }}
      aria-label={title}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-2 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">{title}</h2>
        {trailing}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {onResize && (
        <PaneHandle width={width} onResize={onResize} label={title} resizeFrom={resizeFrom} />
      )}
    </section>
  );
}

/** The drag handle on a pane's trailing edge.
 *
 *  A `separator` with `aria-orientation="vertical"` because that is what this
 *  is; the drag is tracked on `window` rather than on the handle so that moving
 *  the pointer faster than React re-renders does not drop the drag.
 *
 *  `window` listeners outlive the component that created them, so a pane that
 *  unmounts mid-drag (the user switches projects before releasing) must tear
 *  its listeners down itself rather than waiting for a `pointerup` that may
 *  arrive late or never. `stopRef` holds whichever drag is currently live so
 *  both the unmount effect and a fresh `start()` can find and remove it — the
 *  latter matters because a stray, already-orphaned `pointerup` can leave a
 *  pair registered that a second drag must replace rather than stack on. */
function PaneHandle({
  width,
  onResize,
  label,
  resizeFrom,
}: {
  width?: number;
  onResize: (width: number) => void;
  label: string;
  resizeFrom: "leading" | "trailing";
}) {
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  const start = (event: React.PointerEvent) => {
    // A drag already live (e.g. its `pointerup` never arrived) must be torn
    // down before a new one begins, or the two listener pairs both fire.
    stopRef.current?.();

    const originX = event.clientX;
    const originWidth = width ?? 0;
    // "leading" negates the sign right here, next to `originWidth` — both
    // come from the same capture, so this stays correct regardless of
    // whether `move` ever gets rebound to a fresher `onResize`.
    const sign = resizeFrom === "leading" ? -1 : 1;

    const move = (moveEvent: PointerEvent) =>
      onResize(originWidth + sign * (moveEvent.clientX - originX));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      stopRef.current = null;
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    stopRef.current = end;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      onPointerDown={start}
      // On the edge the boundary actually sits. `resizeFrom` used to invert the
      // drag direction while the handle stayed pinned right — so the rightmost
      // pane's grip was flush against the window frame rather than on its border
      // with the pane beside it, and effectively could not be grabbed. The sign
      // and the position have to agree.
      // 8px, not 4. A resize grip is aimed at rather than read, and 4px is
      // narrow enough that hitting it is a small act of precision every time —
      // which reads as "not draggable" long before it reads as "I missed".
      className={`absolute inset-y-0 w-2 cursor-col-resize hover:bg-accent ${
        resizeFrom === "leading" ? "left-0" : "right-0"
      }`}
    />
  );
}
