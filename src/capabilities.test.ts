import { expect, test } from "vitest";

// `?raw` rather than `node:fs`: this project has no `@types/node`, and adding a
// dependency for one test to read two files it can import directly is the wrong
// trade. Vite inlines these at build time, so the assertions run against the same
// bytes the app ships with.
import capabilityJson from "../src-tauri/capabilities/default.json?raw";
import appSource from "./App.tsx?raw";
import projectSelectorSource from "./components/ProjectSelector.tsx?raw";
import updateBarSource from "./components/UpdateBar.tsx?raw";

/// Tauri 2 denies any plugin command the window's capability does not grant, and
/// the denial arrives as a rejected promise from the plugin — not as a build
/// error, not as a warning. So a missing grant is invisible until someone clicks
/// the thing and nothing happens, which is exactly how `dialog:allow-save` came
/// to be missing while every export button looked wired.
///
/// Nothing in a jsdom suite can exercise the real permission system, because the
/// plugins are mocked there. What *can* be checked is the pairing: every plugin
/// API the frontend imports has a matching grant in the capability file.
const CAPABILITY = "src-tauri/capabilities/default.json";

/** A capability entry is either a bare identifier or an object carrying a scope. */
type Entry = string | { identifier: string; allow?: unknown[]; deny?: unknown[] };

const entries: Entry[] = JSON.parse(capabilityJson).permissions;

/** Every granted permission identifier, whether or not it carries a scope. */
const granted: string[] = entries.map((entry) =>
  typeof entry === "string" ? entry : entry.identifier,
);

/** The named grant, if it is scoped rather than bare. */
function scopeOf(identifier: string): Entry | undefined {
  return entries.find((entry) => typeof entry !== "string" && entry.identifier === identifier);
}

/** Which APIs of one plugin the frontend actually calls, read off the imports. */
function importedApis(plugin: string, sources: string[]): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*"@tauri-apps/plugin-${plugin}"`,
  );

  for (const source of sources) {
    const importMatch = pattern.exec(source);
    if (!importMatch) continue;
    for (const name of importMatch[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed !== "") found.add(trimmed);
    }
  }

  return [...found];
}

const dialogApis = () => importedApis("dialog", [appSource, projectSelectorSource]);

test("every dialog API the frontend uses is granted by the capability", () => {
  const used = dialogApis();

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
  const used = new Set(dialogApis());

  const unused = granted
    .filter((permission) => permission.startsWith("dialog:allow-"))
    .map((permission) => permission.replace("dialog:allow-", ""))
    .filter((api) => !used.has(api));

  expect(unused).toEqual([]);
});

test("opening a URL is granted, since the update bar calls it", () => {
  const used = importedApis("opener", [updateBarSource]);

  expect(used).toContain("openUrl");
  expect(
    granted.includes("opener:allow-open-url") || granted.includes("opener:default"),
    `openUrl() is called but no opener grant exists in ${CAPABILITY}.`,
  ).toBe(true);
});

/// The security property, not just the wiring. `opener:allow-open-url` as a bare
/// string lets anything running in the webview ask the OS to open any address at
/// all — a useful primitive for turning a rendered-content injection into a
/// launched browser. The only URL this app ever needs to open is its own release
/// page, so the grant is scoped to that repository and this test is what keeps it
/// scoped: downgrading it to a plain string, or to `opener:default`, fails here.
test("the opener grant is scoped to this repository, not open-ended", () => {
  expect(
    granted.includes("opener:default"),
    "opener:default grants every opener command unscoped; grant only what is called.",
  ).toBe(false);

  const scoped = scopeOf("opener:allow-open-url");
  expect(
    scoped,
    "opener:allow-open-url must be an object with an `allow` scope, not a bare string — " +
      "a bare grant permits opening any URL.",
  ).toBeDefined();

  const allow = (scoped as { allow?: { url?: string }[] }).allow ?? [];
  expect(allow.length).toBeGreaterThan(0);
  for (const rule of allow) {
    expect(rule.url, "each scope rule should pin a URL").toBeDefined();
    expect(
      rule.url?.startsWith("https://github.com/dragginzgame/icydb-explorer/"),
      `scope rule ${String(rule.url)} reaches outside this project's repository`,
    ).toBe(true);
  }
});
