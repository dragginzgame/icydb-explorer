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
