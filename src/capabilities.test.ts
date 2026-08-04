import { expect, test } from "vitest";

// `?raw` rather than `node:fs`: this project has no `@types/node`, and adding a
// dependency for one test to read two files it can import directly is the wrong
// trade. Vite inlines these at build time, so the assertions run against the same
// bytes the app ships with.
import capabilityJson from "../src-tauri/capabilities/default.json?raw";
import appSource from "./App.tsx?raw";
import projectSelectorSource from "./components/ProjectSelector.tsx?raw";

/// Tauri 2 denies any plugin command the window's capability does not grant, and
/// the denial arrives as a rejected promise from the plugin — not as a build
/// error, not as a warning. So a missing grant is invisible until someone clicks
/// the thing and nothing happens, which is exactly how `dialog:allow-save` came
/// to be missing while every export button looked wired.
///
/// Nothing in a jsdom suite can exercise the real permission system, because the
/// dialog plugin is mocked there. What *can* be checked is the pairing: every
/// dialog API the frontend imports has a matching grant in the capability file.
const CAPABILITY = "src-tauri/capabilities/default.json";

/** Which dialog APIs the frontend actually calls, read off the imports. */
function importedDialogApis(): string[] {
  const found = new Set<string>();

  for (const source of [appSource, projectSelectorSource]) {
    const importMatch = /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-dialog"/.exec(source);
    if (!importMatch) continue;
    for (const name of importMatch[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed !== "") found.add(trimmed);
    }
  }

  return [...found];
}

const granted: string[] = JSON.parse(capabilityJson).permissions;

test("every dialog API the frontend uses is granted by the capability", () => {
  const used = importedDialogApis();

  // A guard that found nothing would pass for the wrong reason.
  expect(used.length).toBeGreaterThan(0);

  for (const api of used) {
    const permission = `dialog:allow-${api}`;
    expect(
      granted.includes(permission) || granted.includes("dialog:default"),
      `${api}() is called but ${permission} is not granted in ${CAPABILITY}. ` +
        "Tauri denies the call at runtime and the plugin rejects, which looks " +
        "exactly like a button that was never wired up.",
    ).toBe(true);
  }
});

/// The mirror: a grant with no caller is permission this app does not need. Not a
/// failure, but worth seeing — a capability list that drifts wider than the code
/// stops describing what the app does.
test("no dialog permission is granted that nothing calls", () => {
  const used = new Set(importedDialogApis());

  const unused = granted
    .filter((permission) => permission.startsWith("dialog:allow-"))
    .map((permission) => permission.replace("dialog:allow-", ""))
    .filter((api) => !used.has(api));

  expect(unused).toEqual([]);
});
