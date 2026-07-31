import { useEffect, useRef, useState } from "react";

import type { ThemeChoice } from "../theme/useTheme";

const LABELS: Record<ThemeChoice, { name: string; hint: string }> = {
  // The hint must not name another theme: it becomes part of this row's
  // accessible name, so "Instrument or Console" here made
  // getByRole("menuitemradio", { name: /console/i }) match two rows.
  system: { name: "Follow system", hint: "light or dark" },
  console: { name: "Console", hint: "dark" },
  terminal: { name: "Terminal", hint: "dark · mono" },
  instrument: { name: "Instrument", hint: "light" },
};

const ORDER: ThemeChoice[] = ["system", "console", "terminal", "instrument"];

/** The gear popover. Controlled: it owns only open/closed, never the theme —
 *  `App` holds that through `useTheme`, so there is one source of truth. */
export function SettingsMenu({
  choice,
  onChoose,
}: {
  choice: ThemeChoice;
  onChoose: (next: ThemeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a click anywhere outside. Both are listeners on
  // the document rather than a backdrop element, so the menu adds nothing to
  // the layout and cannot shift the header.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="rounded-control px-2 py-1 text-text-2 hover:bg-surface-2"
      >
        <span aria-hidden="true">⚙</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 z-20 mt-1 w-56 rounded-control border border-rule-strong bg-surface-2 py-1"
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-3">Theme</div>
          {ORDER.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === choice}
              onClick={() => {
                onChoose(option);
                setOpen(false);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm text-text-1 hover:bg-sel-bg hover:text-sel-text"
            >
              <span aria-hidden="true" className="w-3 text-accent">
                {option === choice ? "●" : ""}
              </span>
              <span>{LABELS[option].name}</span>
              <span className="ml-auto font-mono text-[10px] text-text-3">
                {LABELS[option].hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
