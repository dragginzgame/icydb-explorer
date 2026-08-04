import { useEffect, useRef, useState } from "react";

import { copyText } from "../lib/copyText";

/** Copies a value, and says so only if it worked.
 *
 *  Extracted because this appeared twice with the same three moving parts — the
 *  pending-hide timer, the success-only confirmation, and the announced status —
 *  and a third copy was about to be written for table cells. `copyText` has two
 *  routes and neither is guaranteed in a webview, so reporting a copy that did not
 *  happen is a real possibility this shape exists to prevent.
 */
export function CopyButton({
  value,
  label,
  className = "",
}: {
  value: string;
  /** What this copies, for the accessible name: "Copy handle", "Copy root
   *  principal". A row of identically-named buttons tells a screen-reader user
   *  nothing about which is which. */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // So a second click cannot have its confirmation cut short by the first click's
  // timer, and nothing stays scheduled after this unmounts — which happens
  // routinely as the grid pages and as filters change.
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          window.clearTimeout(hideTimer.current);
          setCopied(true);
          hideTimer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      aria-label={label}
      title={copied ? "Copied" : label}
      className={`shrink-0 rounded-row text-xs text-text-3 hover:bg-surface-2 hover:text-text-1 ${className}`}
    >
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
      {/* Announced, not only drawn: the glyph swap says nothing to a screen
          reader, and "did that work" is the whole question. */}
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
