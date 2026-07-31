import { useState } from "react";

import { copyText } from "../lib/copyText";
import { elide } from "../lib/elide";

/** An identifier shown elided, with the full value in `title` and copied on
 *  click.
 *
 *  A button rather than a span because it is genuinely actionable, which also
 *  makes it keyboard-reachable and gives it the global `:focus-visible` ring for
 *  free. `text-pk` marks it as identifier-shaped, matching `ValueCell`.
 *
 *  The confirmation only appears when the copy actually succeeded — `copyText`
 *  reports failure rather than throwing, and claiming success falsely would be
 *  worse than showing nothing. */
export function Identifier({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className={`font-mono text-xs text-pk ${className ?? ""}`}
    >
      {elide(value)}
      {copied && <span className="ml-1 not-italic text-text-3">copied</span>}
    </button>
  );
}
