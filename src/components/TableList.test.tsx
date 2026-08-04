import { fireEvent, render, screen } from "@testing-library/react";

import { TableList } from "./TableList";

/** An `EntityDto` with the two facts the sort tests care about. */
const table = (name: string, columns: number, indexes: number) => ({
  name,
  storePath: "",
  storage: "stable",
  columns,
  indexes,
  relations: 0,
  schemaVersion: 1,
});

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

const many = Array.from({ length: 8 }, (_, index) => ({
  name: index === 0 ? "UserProjects" : `Entity${index}`,
  storePath: "",
  storage: "stable",
  columns: 2,
  indexes: 0,
  relations: 0,
  schemaVersion: 1,
}));

/// Below a handful of tables the eye is faster than the keyboard, so the box
/// would just be chrome.
test("no filter box for a short list", () => {
  render(<TableList entities={entities} selected={null} onSelect={() => {}} />);

  expect(screen.queryByRole("searchbox", { name: /filter tables/i })).not.toBeInTheDocument();
});

test("a long list gets a filter box", () => {
  render(<TableList entities={many} selected={null} onSelect={() => {}} />);

  expect(screen.getByRole("searchbox", { name: /filter tables/i })).toBeInTheDocument();
});

test("filtering narrows the list and is case-insensitive", () => {
  render(<TableList entities={many} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByRole("searchbox", { name: /filter tables/i }), {
    target: { value: "userproj" },
  });

  expect(screen.getByText("UserProjects")).toBeInTheDocument();
  expect(screen.queryByText("Entity3")).not.toBeInTheDocument();
});

/// A filter that matches nothing must say what was searched for, so the reader
/// sees their typo rather than wondering whether the canister lost its tables.
test("a filter matching nothing names what was searched for", () => {
  render(<TableList entities={many} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByRole("searchbox", { name: /filter tables/i }), {
    target: { value: "zzz" },
  });

  expect(screen.getByText(/No table matches/)).toBeInTheDocument();
  expect(screen.getByText(/zzz/)).toBeInTheDocument();
});

/// Whitespace alone is not a search — it must not empty the pane.
test("a whitespace-only filter shows everything", () => {
  render(<TableList entities={many} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByRole("searchbox", { name: /filter tables/i }), {
    target: { value: "   " },
  });

  expect(screen.getByText("UserProjects")).toBeInTheDocument();
  expect(screen.queryByText(/No table matches/)).not.toBeInTheDocument();
});

// ── Sorting ──────────────────────────────────────────────────────────────────

/** Deliberately not alphabetical, so schema order is distinguishable from name
 *  order — a fixture already sorted by name would let either pass. */
const unsorted = [
  table("UserProjects", 4, 0),
  table("Address", 7, 1),
  table("User", 10, 2),
];

/** The rendered table names, in the order they appear. */
function listed(): string[] {
  return [...document.querySelectorAll("li button > div:first-child")].map(
    (node) => node.textContent ?? "",
  );
}

/// Schema order is the default, because it is the order the schema was written in
/// and silently replacing it with something alphabetical would discard information.
test("tables arrive in schema order", () => {
  render(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);

  expect(listed()).toEqual(["UserProjects", "Address", "User"]);
});

test("sorting by name reorders the list", () => {
  render(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });

  expect(listed()).toEqual(["Address", "User", "UserProjects"]);
});

test("the direction control reverses it", () => {
  render(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });

  fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));

  expect(listed()).toEqual(["UserProjects", "User", "Address"]);
  // And back again — it toggles rather than latching.
  fireEvent.click(screen.getByRole("button", { name: "Sort ascending" }));
  expect(listed()).toEqual(["Address", "User", "UserProjects"]);
});

test("sorting by index count", () => {
  render(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "indexes" } });

  expect(listed()).toEqual(["UserProjects", "Address", "User"]);
  fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
  expect(listed()).toEqual(["User", "Address", "UserProjects"]);
});

test("sorting by row count uses the counts on screen", () => {
  render(
    <TableList
      entities={unsorted}
      selected={null}
      onSelect={() => {}}
      counts={{ UserProjects: 12, Address: 1, User: 400 }}
    />,
  );

  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "rows" } });

  expect(listed()).toEqual(["Address", "UserProjects", "User"]);
});

/// Counting is a full scan and user-initiated, so most tables usually have no
/// count — and treating that as zero would sort them in among genuinely empty
/// ones and assert something nobody measured.
test("an uncounted table sorts last in both directions", () => {
  render(
    <TableList
      entities={unsorted}
      selected={null}
      onSelect={() => {}}
      counts={{ Address: 1, User: 400 }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "rows" } });

  expect(listed()).toEqual(["Address", "User", "UserProjects"]);
  fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
  expect(listed()).toEqual(["User", "Address", "UserProjects"]);
});

/// Why "last either way" is not obvious, so the control says it where the reader
/// will be looking when they wonder.
test("the direction control explains the uncounted rule while sorting by rows", () => {
  render(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "rows" } });

  expect(screen.getByRole("button", { name: /^Sort / }).title).toMatch(/sorts last either way/);
});

/// Sorting and filtering compose: the order applies to what survived the filter.
test("sorting applies to the filtered list", () => {
  const many = [...unsorted, table("Zeta", 1, 0), table("UserFriends", 3, 0), table("Beta", 2, 0)];
  render(<TableList entities={many} selected={null} onSelect={() => {}} />);

  fireEvent.change(screen.getByLabelText("Filter tables"), { target: { value: "user" } });
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });

  expect(listed()).toEqual(["User", "UserFriends", "UserProjects"]);
});

/// Below two tables there is nothing to order, and the control would be chrome.
test("a single table is offered no sort control", () => {
  render(<TableList entities={[table("User", 10, 2)]} selected={null} onSelect={() => {}} />);

  expect(screen.queryByLabelText("Sort")).not.toBeInTheDocument();
});

/// The hooks moved above the early return for this: a canister with no tables and
/// one with tables render through the same component instance.
test("switching between an empty canister and one with tables does not break", () => {
  const { rerender } = render(
    <TableList entities={unsorted} selected={null} onSelect={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });

  rerender(<TableList entities={[]} selected={null} onSelect={() => {}} />);
  expect(screen.getByText("No tables")).toBeInTheDocument();

  rerender(<TableList entities={unsorted} selected={null} onSelect={() => {}} />);
  expect(listed()).toEqual(["Address", "User", "UserProjects"]);
});
