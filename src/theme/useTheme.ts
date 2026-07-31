import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "icydb-explorer.theme";

/** The array is the single source of truth and the union is derived from it, so
 *  the two cannot drift. Declaring them separately type-checks an unlisted
 *  string *in* the array but not a union member *missing* from it — which would
 *  silently omit a newly added theme from the settings menu that iterates this. */
export const THEME_CHOICES = ["system", "console", "terminal", "instrument"] as const;

/** `system` sets no `data-theme`, letting the media query in tokens.css pick
 *  between the Instrument (light) and Console (dark) values. */
export type ThemeChoice = (typeof THEME_CHOICES)[number];

function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Reads the stored preference, falling back to `system` for anything absent or
 *  unrecognised. An unrecognised value would otherwise be applied verbatim as a
 *  `data-theme` matching no block, leaving the app on :root's defaults while the
 *  menu claimed otherwise. */
function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function useTheme(): {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);

  // Applies on mount too, so a stored preference takes effect without waiting
  // for an interaction.
  useEffect(() => {
    apply(choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    // Persisting is a convenience; a storage that refuses must not stop the
    // theme applying for this session.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* preference not remembered; the attribute is still applied above */
    }
  }, []);

  return { choice, setChoice };
}
