import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CanisterTree } from "./CanisterTree";

/** Opens every branch.
 *
 *  The tree collapses by default, so tests about anything *other* than the fold
 *  state have to open it first. Repeated, because expanding one level reveals the
 *  collapsed nodes beneath it. */
function expandAll() {
  for (let pass = 0; pass < 6; pass += 1) {
    const toggles = screen.queryAllByRole("button", { name: /^Expand / });
    if (toggles.length === 0) return;
    for (const toggle of toggles) fireEvent.click(toggle);
  }
}

const forest = [
  {
    pid: "root-id",
    role: "root",
    children: [
      { pid: "aaaaa-aa", role: "project_hub", children: [] },
      { pid: "bbbbb-bb", role: "wasm_store", children: [] },
    ],
  },
];

test("renders the fleet as a tree", () => {
  render(<CanisterTree trees={forest} selectedPid={null} onSelect={() => {}} />);
  expandAll();

  expect(screen.getByText("project_hub")).toBeInTheDocument();
  expect(screen.getByText("wasm_store")).toBeInTheDocument();
});

/// "Not probed yet" and "has nothing to show" are different answers, and only
/// one of them is the reader's problem. Without a map, nothing is marked.
test("an unprobed fleet marks nothing", () => {
  render(<CanisterTree trees={forest} selectedPid={null} onSelect={() => {}} />);

  expect(screen.queryByText(/no tables/)).not.toBeInTheDocument();
});

/// A canic fleet routinely holds canisters with no icydb schema — in toko,
/// wasm_store and discovery_hub. Selecting one used to look identical to
/// selecting a real table source, and produced an error only after the click.
test("a canister with no icydb surface says so", () => {
  render(
    <CanisterTree
      trees={forest}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "aaaaa-aa": true, "bbbbb-bb": false }}
    />,
  );
  expandAll();

  expect(screen.getByText(/no tables/)).toBeInTheDocument();
  // The one that does carry a schema is left alone.
  const hub = screen.getByText("project_hub").closest("button");
  expect(hub?.textContent).not.toMatch(/no tables/);
});

/// Dimmed, not disabled. Such a canister is still worth opening — it has an id
/// worth copying and a place in the fleet — so the mark is information, not a
/// barrier.
test("a canister with no surface is still selectable", () => {
  const picked: string[] = [];
  render(
    <CanisterTree
      trees={forest}
      selectedPid={null}
      onSelect={(pid) => picked.push(pid)}
      queryable={{ "bbbbb-bb": false }}
    />,
  );
  expandAll();

  const button = screen.getByText("wasm_store").closest("button");
  expect(button).not.toBeDisabled();
  fireEvent.click(button!);
  expect(picked).toEqual(["bbbbb-bb"]);
});

test("the reason is available on hover", () => {
  render(
    <CanisterTree
      trees={forest}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "bbbbb-bb": false }}
    />,
  );
  expandAll();

  expect(screen.getByTitle(/wasm_store exposes no icydb SQL surface/)).toBeInTheDocument();
});

// ── Filtering and collapsing ─────────────────────────────────────────────────

/** toko's shape: hubs with children, and a pool a hundred deep would live under
 *  `project_hub` exactly like this. */
const fleet = [
  {
    pid: "root-id",
    role: "root",
    children: [
      { pid: "wasm-id", role: "wasm_store", children: [] },
      {
        pid: "phub-id",
        role: "project_hub",
        children: [
          { pid: "pi1-id", role: "project_instance", children: [] },
          { pid: "pi2-id", role: "project_instance", children: [] },
        ],
      },
      {
        pid: "uhub-id",
        role: "user_hub",
        children: [{ pid: "ushard-id", role: "user_shard", children: [] }],
      },
    ],
  },
];

const renderTree = () =>
  render(<CanisterTree trees={fleet} selectedPid={null} onSelect={() => {}} />);

/// The reason this exists: a hundred project canisters make the pane unusable
/// without a way to narrow it.
test("filtering narrows the fleet to matches and their ancestors", () => {
  renderTree();

  fireEvent.change(screen.getByLabelText("Filter canisters"), {
    target: { value: "user_shard" },
  });

  expect(screen.getByText("user_shard")).toBeInTheDocument();
  // Its ancestors survive, or the match would say nothing about where it lives.
  expect(screen.getByText("user_hub")).toBeInTheDocument();
  expect(screen.getByText("root")).toBeInTheDocument();
  // Everything off the path is gone.
  expect(screen.queryByText("wasm_store")).not.toBeInTheDocument();
  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();
});

/// "3 canisters" alone reads as the whole fleet to anyone who has forgotten the
/// filter is on.
test("a filtered tree says how much it is hiding", () => {
  renderTree();

  fireEvent.change(screen.getByLabelText("Filter canisters"), { target: { value: "user" } });

  expect(screen.getByText("3 of 7 canisters")).toBeInTheDocument();
});

test("a filter matching nothing says so rather than showing an empty pane", () => {
  renderTree();

  fireEvent.change(screen.getByLabelText("Filter canisters"), { target: { value: "zzz" } });

  expect(screen.getByText("Nothing matches")).toBeInTheDocument();
});

/// A reader holding an id from a log has no role name to search for.
test("a principal is searchable", () => {
  renderTree();

  fireEvent.change(screen.getByLabelText("Filter canisters"), { target: { value: "ushard" } });

  expect(screen.getByText("user_shard")).toBeInTheDocument();
  expect(screen.queryByText("wasm_store")).not.toBeInTheDocument();
});

/// The count is what makes a collapsed node informative rather than just absent.
test("a collapsed node hides its children and says how many", () => {
  renderTree();

  // Root is folded too, so its own child has to be brought into view before its
  // fold state can be looked at.
  fireEvent.click(screen.getByRole("button", { name: "Expand root" }));

  // And it arrived collapsed, which is the default a large fleet needs.
  expect(screen.queryByText("project_instance")).not.toBeInTheDocument();
  expect(screen.getByText("· 2 canisters")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Expand project_hub" }));
  expect(screen.getAllByText("project_instance")).toHaveLength(2);

  // And it folds away again.
  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));
  expect(screen.queryByText("project_instance")).not.toBeInTheDocument();
});

/// Collapsing a hub to get past it is not the same intent as looking at it. One
/// control doing both would re-query a canister on every attempt to tidy the tree.
test("collapsing does not select the canister", () => {
  const selected: string[] = [];
  render(<CanisterTree trees={fleet} selectedPid={null} onSelect={(pid) => selected.push(pid)} />);

  fireEvent.click(screen.getByRole("button", { name: "Expand root" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand project_hub" }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));

  expect(selected).toEqual([]);
});

/// A leaf has nothing to collapse, and offering a control that does nothing is
/// worse than offering none.
test("a canister with no children has no fold control", () => {
  renderTree();
  expandAll();

  expect(screen.queryByRole("button", { name: /Collapse wasm_store/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Expand wasm_store/ })).not.toBeInTheDocument();
});

/// Finding a match and then not being shown it because an ancestor happened to be
/// collapsed would make the filter look broken, with the cause invisible.
test("filtering reveals matches inside collapsed branches", () => {
  renderTree();

  expect(screen.queryByText("project_instance")).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Filter canisters"), {
    target: { value: "project_instance" },
  });

  expect(screen.getAllByText("project_instance")).toHaveLength(2);
});

/// The count is noise while the children are visible; collapsed, it is the only
/// thing saying how much was folded away.
test("the count appears only while collapsed", () => {
  renderTree();
  fireEvent.click(screen.getByRole("button", { name: "Expand root" }));

  expect(screen.getByText("· 2 canisters")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand project_hub" }));
  expect(screen.queryByText(/· 2 canisters/)).not.toBeInTheDocument();
});

/// The default a large fleet needs: a hundred project canisters is a scroll
/// before it is navigation, so a fleet arrives folded and the counts say what is
/// inside. Only the roots are on screen to begin with.
test("everything with children starts collapsed", () => {
  renderTree();

  expect(screen.getByText("root")).toBeInTheDocument();
  expect(screen.queryByText("user_shard")).not.toBeInTheDocument();
  expect(screen.queryByText("project_instance")).not.toBeInTheDocument();
  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();
  // Root says how much it is holding, so the fold is informative rather than
  // just empty.
  expect(screen.getByText("· 6 canisters")).toBeInTheDocument();
});

// ── Copying a principal ──────────────────────────────────────────────────────

/// The principal is the thing a reader takes *out* of this app — into a dfx
/// command, a bug report, a log search — and selecting it out of a tree row is
/// fiddly at best.
test("every canister offers to copy its principal", async () => {
  const written: string[] = [];
  const writeText = vi.fn(async (text: string) => {
    written.push(text);
  });
  vi.stubGlobal("navigator", { clipboard: { writeText } });

  renderTree();
  fireEvent.click(screen.getByRole("button", { name: "Copy root principal" }));

  // The principal, not the role — which is the whole point of the control.
  await waitFor(() => expect(written).toEqual(["root-id"]));
  vi.unstubAllGlobals();
});

/// Copying an id must not also re-query the canister it belongs to.
test("copying does not select the canister", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  const selected: string[] = [];
  render(<CanisterTree trees={fleet} selectedPid={null} onSelect={(pid) => selected.push(pid)} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy root principal" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
  expect(selected).toEqual([]);
  vi.unstubAllGlobals();
});

/// `copyText` has two routes and neither is guaranteed in a webview, so a silent
/// failure must not be reported as a copy.
test("a failed copy confirms nothing", async () => {
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn(async () => {
        throw new Error("refused");
      }),
    },
  });
  // The textarea fallback is what runs next; make it fail too.
  const exec = vi.fn(() => false);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });

  renderTree();
  fireEvent.click(screen.getByRole("button", { name: "Copy root principal" }));

  await waitFor(() => expect(exec).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("");
  vi.unstubAllGlobals();
});

// ── Collapse across a refresh ────────────────────────────────────────────────

/// Re-collapsing everything on every refresh would fight the reader: they open a
/// branch, refresh to see new rows, and find it shut again.
test("an expanded branch survives the tree being re-fetched", () => {
  const { rerender } = render(
    <CanisterTree trees={fleet} selectedPid={null} onSelect={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand root" }));
  expect(screen.getByText("project_hub")).toBeInTheDocument();

  // A new forest object with the same canisters, which is what Refresh produces.
  rerender(
    <CanisterTree trees={structuredClone(fleet)} selectedPid={null} onSelect={() => {}} />,
  );

  expect(screen.getByText("project_hub")).toBeInTheDocument();
});

/// But a canister that genuinely just appeared starts collapsed: nothing should
/// expand itself under the reader.
test("a newly-appeared branch arrives collapsed", () => {
  const { rerender } = render(
    <CanisterTree trees={fleet} selectedPid={null} onSelect={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand root" }));

  const grown = structuredClone(fleet);
  grown[0].children.push({
    pid: "new-hub",
    role: "new_hub",
    children: [{ pid: "new-child", role: "new_child", children: [] }],
  });
  rerender(<CanisterTree trees={grown} selectedPid={null} onSelect={() => {}} />);

  expect(screen.getByText("new_hub")).toBeInTheDocument();
  expect(screen.queryByText("new_child")).not.toBeInTheDocument();
});

// ── Opening to the first queryable canister ──────────────────────────────────

/// Collapsed-by-default is right for a large fleet but lands the reader on a
/// single row with nothing to do. A canic fleet's upper levels are hubs and
/// stores with no icydb schema, so "the top of the tree" and "somewhere worth
/// looking" are different places.
test("the path to the first queryable canister is open", () => {
  render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "root-id": false, "phub-id": false, "pi1-id": true }}
    />,
  );

  // Its ancestors are open, so it is on screen.
  expect(screen.getByText("project_hub")).toBeInTheDocument();
  expect(screen.getAllByText("project_instance")).toHaveLength(2);
});

/// Only the path. Opening the whole fleet to reach one canister would undo the
/// fold the reader asked for.
test("branches off the path stay collapsed", () => {
  render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "pi1-id": true }}
    />,
  );

  // `user_hub` is a sibling of the opened branch and keeps its children folded.
  expect(screen.getByText("user_hub")).toBeInTheDocument();
  expect(screen.queryByText("user_shard")).not.toBeInTheDocument();
});

/// The *first* in fleet order, not just any — otherwise which canister the reader
/// lands on would depend on object key order.
test("the first queryable in fleet order is the one revealed", () => {
  render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "ushard-id": true, "pi1-id": true }}
    />,
  );

  // `project_hub` comes before `user_hub` in the fleet, so its branch opens and
  // the later match's does not.
  expect(screen.getAllByText("project_instance")).toHaveLength(2);
  expect(screen.queryByText("user_shard")).not.toBeInTheDocument();
});

/// A refresh re-probes and arrives at the same answer. Re-opening what the reader
/// just folded would make the tree fight them.
test("folding the revealed branch back up survives a re-probe", () => {
  const queryable = { "pi1-id": true };
  const { rerender } = render(
    <CanisterTree trees={fleet} selectedPid={null} onSelect={() => {}} queryable={queryable} />,
  );
  expect(screen.getByText("project_hub")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Collapse root" }));
  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();

  // A fresh probe object with the same verdict, which is what Refresh produces.
  rerender(
    <CanisterTree trees={fleet} selectedPid={null} onSelect={() => {}} queryable={{ ...queryable }} />,
  );

  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();
});

/// A different fleet arrives at a different answer and gets its own reveal.
test("a new first-queryable canister opens its own path", () => {
  const { rerender } = render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "pi1-id": true }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Collapse root" }));

  rerender(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "ushard-id": true }}
    />,
  );

  expect(screen.getByText("user_shard")).toBeInTheDocument();
});

/// Before the probe resolves there is nothing to aim at, and the fold has to hold
/// rather than guessing at a target.
test("with no probe results nothing is revealed", () => {
  renderTree();

  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();
});

/// A fleet where nothing carries an icydb schema has nowhere worth opening to,
/// and inventing a destination would be worse than leaving it folded.
test("a fleet with nothing queryable stays folded", () => {
  render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={() => {}}
      queryable={{ "root-id": false, "phub-id": false, "pi1-id": false }}
    />,
  );

  expect(screen.queryByText("project_hub")).not.toBeInTheDocument();
});

/// Revealing is not selecting: opening a path must not query a canister the
/// reader never clicked.
test("revealing does not select anything", () => {
  const selected: string[] = [];
  render(
    <CanisterTree
      trees={fleet}
      selectedPid={null}
      onSelect={(pid) => selected.push(pid)}
      queryable={{ "pi1-id": true }}
    />,
  );

  expect(selected).toEqual([]);
});
