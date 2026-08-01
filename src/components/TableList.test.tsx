import { fireEvent, render, screen } from "@testing-library/react";

import { TableList } from "./TableList";

const entities = [
  { name: "User", storePath: "", storage: "stable", columns: 6, indexes: 1, relations: 0, schemaVersion: 1 },
  { name: "Address", storePath: "", storage: "stable", columns: 4, indexes: 0, relations: 0, schemaVersion: 1 },
];

test("shows the schema facts that came for free with SHOW ENTITIES", () => {
  render(<TableList entities={entities} selected={null} onSelect={() => {}} />);

  expect(screen.getByText(/6 columns · 1 indexes/)).toBeInTheDocument();
});

/// Counting is a full scan per table, so it must never happen just because a
/// canister was selected. Without an `onCount` there is no control at all.
test("offers no counting control unless the caller supplies one", () => {
  render(<TableList entities={entities} selected={null} onSelect={() => {}} />);

  expect(screen.queryByRole("button", { name: /count rows/i })).not.toBeInTheDocument();
});

test("counting is user-initiated", () => {
  const clicks: number[] = [];
  render(
    <TableList entities={entities} selected={null} onSelect={() => {}} onCount={() => clicks.push(1)} />,
  );

  fireEvent.click(screen.getByRole("button", { name: /count rows/i }));
  expect(clicks).toHaveLength(1);
});

test("a known count is shown beside its table, singular where it should be", () => {
  render(
    <TableList
      entities={entities}
      selected={null}
      onSelect={() => {}}
      counts={{ User: 1, Address: 4211 }}
    />,
  );

  expect(screen.getByText(/1 row(?!s)/)).toBeInTheDocument();
  expect(screen.getByText(/4,211 rows/)).toBeInTheDocument();
});

/// Zero is the answer the count exists to give — "this table is empty" is
/// exactly what a reader wants to know before opening it — so it must render
/// as a number and not be mistaken for "not counted".
test("zero renders as a count rather than as nothing", () => {
  render(
    <TableList entities={entities} selected={null} onSelect={() => {}} counts={{ User: 0 }} />,
  );

  expect(screen.getByText(/0 rows/)).toBeInTheDocument();
});

/// A table whose count failed is distinct from one nobody counted. Rendering
/// the failure as blank would make an error look like an omission.
test("a failed count is distinguished from an uncounted table", () => {
  render(
    <TableList entities={entities} selected={null} onSelect={() => {}} counts={{ User: null }} />,
  );

  expect(screen.getByText(/count unavailable/)).toBeInTheDocument();
  // Address was never counted, so it says nothing at all about rows.
  const address = screen.getByText("Address").parentElement;
  expect(address?.textContent).not.toMatch(/row|unavailable/);
});

test("the control reports progress and cannot be fired twice", () => {
  render(
    <TableList
      entities={entities}
      selected={null}
      onSelect={() => {}}
      onCount={() => {}}
      counting
    />,
  );

  const control = screen.getByRole("button", { name: /counting/i });
  expect(control).toBeDisabled();
});
