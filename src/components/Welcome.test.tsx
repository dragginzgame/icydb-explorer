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
/// Two files, so two blocks and two buttons: one pasted into the other does
/// nothing, and a single block invites copying the whole thing into whichever file
/// happens to be open. Both are still needed — the build options alone leave the
/// generated glue behind a `#[cfg]` that is off, and the feature alone leaves
/// nothing for it to compile.
test("each file's change is offered separately", async () => {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  render(<Welcome {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy the build.rs change" }));
  await waitFor(() => expect(written).toHaveLength(1));
  expect(written[0]).toContain("with_sql_readonly_enabled(true)");
  expect(written[0]).toContain("with_sql_introspection_enabled(true)");
  // Not the other file's lines mixed in.
  expect(written[0]).not.toContain("[features]");

  fireEvent.click(screen.getByRole("button", { name: "Copy the Cargo.toml change" }));
  await waitFor(() => expect(written).toHaveLength(2));
  expect(written[1]).toContain('default = ["sql"]');
  expect(written[1]).toContain('sql = ["icydb/sql-explain"]');
  expect(written[1]).not.toContain("build_with_options");

  vi.unstubAllGlobals();
});

/// Each block says which file it belongs in. A snippet you cannot place is a
/// snippet you have to guess about.
test("each block names its file", () => {
  render(<Welcome {...props} />);

  expect(screen.getByText("build.rs")).toBeInTheDocument();
  expect(screen.getByText("Cargo.toml")).toBeInTheDocument();
});

/// The last card sat flush against the bottom of the window, which reads as content
/// cut off rather than content ended — and two attempts to fix it by adding padding
/// changed nothing.
///
/// The reason was the scroll container being `display: flex`: its single child was
/// stretched to the container's height, so the cards overflowed that child's box and
/// its `padding-bottom` sat hundreds of pixels above where they actually ended. So
/// what is pinned here is the mechanism — a *block* scroller, and the space on the
/// in-flow child — rather than the presence of a padding class that was there
/// throughout and did nothing.
test("the page leaves room below its last card", () => {
  const { container } = render(<Welcome {...props} />);

  const scroller = container.firstElementChild!;
  expect(scroller.className).toMatch(/overflow-auto/);
  // Not a flex container: that is what stretched the child and swallowed the space.
  expect(scroller.className).not.toMatch(/(?:^|\s)flex(?:\s|$)/);

  // The space is on the child, which is in normal flow and so has its own height.
  const content = scroller.firstElementChild!;
  expect(content.className).toMatch(/\bpb-\d/);
  expect(content.className).toMatch(/\bmx-auto\b/);
});
