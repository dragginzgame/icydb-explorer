import { fireEvent, render, screen } from "@testing-library/react";

import { CanisterTree } from "./CanisterTree";

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
test("collapsing a node hides its children and says how many", () => {
  renderTree();

  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));

  expect(screen.queryByText("project_instance")).not.toBeInTheDocument();
  expect(screen.getByText("· 2 canisters")).toBeInTheDocument();
  // And it can be undone.
  fireEvent.click(screen.getByRole("button", { name: "Expand project_hub" }));
  expect(screen.getAllByText("project_instance")).toHaveLength(2);
});

/// Collapsing a hub to get past it is not the same intent as looking at it. One
/// control doing both would re-query a canister on every attempt to tidy the tree.
test("collapsing does not select the canister", () => {
  const selected: string[] = [];
  render(<CanisterTree trees={fleet} selectedPid={null} onSelect={(pid) => selected.push(pid)} />);

  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));

  expect(selected).toEqual([]);
});

/// A leaf has nothing to collapse, and offering a control that does nothing is
/// worse than offering none.
test("a canister with no children has no collapse control", () => {
  renderTree();

  expect(screen.queryByRole("button", { name: /Collapse wasm_store/ })).not.toBeInTheDocument();
});

/// Finding a match and then not being shown it because an ancestor happened to be
/// collapsed would make the filter look broken, with the cause invisible.
test("filtering reveals matches inside collapsed branches", () => {
  renderTree();

  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));
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

  expect(screen.queryByText(/· 2 canisters/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse project_hub" }));
  expect(screen.getByText("· 2 canisters")).toBeInTheDocument();
});

/// A fleet arrives fully visible: nothing the reader has not touched is hidden.
test("nothing is collapsed until asked", () => {
  renderTree();

  expect(screen.getByText("user_shard")).toBeInTheDocument();
  expect(screen.getAllByText("project_instance")).toHaveLength(2);
});
