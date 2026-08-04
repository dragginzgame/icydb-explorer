import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// `?raw` so the assertion runs against the file the build actually reads, the same
// technique `capabilities.test.ts` and `tokens.test.ts` use.
import cargoToml from "../../Cargo.toml?raw";
import { ICYDB_VERSION, Welcome } from "./Welcome";

const props = { error: null, triedRoot: null, busy: false, onSelect: () => {} };

/// A version printed on screen that has drifted from the one the binary links is
/// worse than none, because a reader would act on it. Bumping the pin without
/// touching this page fails here rather than misleading someone later.
test("the version shown matches the pin in Cargo.toml", () => {
  const pinned = /^icydb\s*=\s*\{[^}]*version\s*=\s*"=([0-9.]+)"/m.exec(cargoToml);

  expect(pinned, "icydb should be pinned in the workspace Cargo.toml").not.toBeNull();
  expect(ICYDB_VERSION).toBe(pinned![1]);
});

/// The hard requirement, and the one a reader cannot work around: this reads
/// icydb's own endpoint and has no fallback for a canister storing state otherwise.
test("using icydb is stated first, with the version", () => {
  render(<Welcome {...props} />);

  expect(screen.getByText("Before anything else")).toBeInTheDocument();
  expect(screen.getByText(/The canister actually uses icydb/)).toBeInTheDocument();
  expect(screen.getByText(ICYDB_VERSION)).toBeInTheDocument();
});

/// Honest about the compatibility it actually has: candid decoding is structural, so
/// a nearby version often works and a changed response shape does not. Claiming
/// either "only this version" or "any version" would be wrong.
test("the version requirement does not overclaim in either direction", () => {
  render(<Welcome {...props} />);

  const card = screen.getByText(/The canister actually uses icydb/).closest("div");
  expect(card).toHaveTextContent(/decoded structurally/);
  expect(card).toHaveTextContent(/a nearby version often works/);
});

/// The app cannot enable the surface — that means editing a source tree and
/// upgrading a canister, and this app makes no update calls at all. What it can do
/// is hand over the exact lines.
test("the exact changes are offered to copy", async () => {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  render(<Welcome {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy the changes needed" }));

  await waitFor(() => expect(written).toHaveLength(1));
  // Both halves, because either alone leaves the surface off: the build options and
  // the canister crate's own `sql` feature.
  expect(written[0]).toContain("with_sql_readonly_enabled(true)");
  expect(written[0]).toContain("with_sql_introspection_enabled(true)");
  expect(written[0]).toContain('sql = ["icydb/sql-explain"]');
  expect(written[0]).toContain('default = ["sql"]');
  vi.unstubAllGlobals();
});

/// The last card used to sit flush against the bottom of the window, which reads as
/// content cut off rather than content ended.
test("the page leaves room below its last card", () => {
  const { container } = render(<Welcome {...props} />);

  const scroller = container.firstElementChild;
  expect(scroller?.className).toMatch(/overflow-auto/);
  expect(scroller?.className).toMatch(/\bpb-16\b/);
});
