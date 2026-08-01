import { fireEvent, render, screen } from "@testing-library/react";

import { SqlConsole } from "./SqlConsole";

const entities = [
  { name: "User", storePath: "", storage: "stable", columns: 3, indexes: 0, relations: 0, schemaVersion: 1 },
];

const schema = {
  entity: "User",
  columns: [
    { name: "id", typeName: "Ulid", primaryKey: true, optional: false },
    { name: "handle", typeName: "Text", primaryKey: false, optional: true },
  ],
  indexes: [],
};

const type = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(/SELECT \* FROM/), { target: { value } });

test("an empty console suggests how a statement may begin", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);

  expect(screen.getByRole("button", { name: "SELECT" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "DESCRIBE" })).toBeInTheDocument();
});

test("after FROM it suggests the canister's tables", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  type("SELECT * FROM ");

  expect(screen.getByRole("button", { name: "User" })).toBeInTheDocument();
});

test("taking a suggestion writes it into the statement", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  type("SELECT * FROM us");

  fireEvent.click(screen.getByRole("button", { name: "User" }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  expect(ran).toEqual(["SELECT * FROM User "]);
});

/// The most-hit failure in this app: icydb rejects LIMIT without an explicit
/// ordering. Offered as one click rather than left as an error to read.
test("a LIMIT with no ORDER BY offers the fix, using the real primary key", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  type("SELECT * FROM User LIMIT 100");

  expect(screen.getByRole("button", { name: /ORDER BY id/ })).toBeInTheDocument();
});

/// Appending would give `LIMIT 100 ORDER BY id`, which is not valid SQL.
test("the assist is inserted before LIMIT and produces a runnable statement", () => {
  const ran: string[] = [];
  render(<SqlConsole onRun={(sql) => ran.push(sql)} entities={entities} schema={schema} />);
  type("SELECT * FROM User LIMIT 100");

  fireEvent.click(screen.getByRole("button", { name: /ORDER BY id/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  expect(ran).toEqual(["SELECT * FROM User ORDER BY id LIMIT 100"]);
});

test("a statement that already orders is offered no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={schema} />);
  type("SELECT * FROM User ORDER BY handle LIMIT 100");

  expect(screen.queryByRole("button", { name: /Add “ORDER BY/ })).not.toBeInTheDocument();
});

/// Without a schema there is no honest primary key to propose.
test("no schema means no assist", () => {
  render(<SqlConsole onRun={() => {}} entities={entities} schema={null} />);
  type("SELECT * FROM User LIMIT 100");

  expect(screen.queryByRole("button", { name: /Add “ORDER BY/ })).not.toBeInTheDocument();
});

test("the console works with no schema or entities at all", () => {
  render(<SqlConsole onRun={() => {}} />);

  expect(screen.getByPlaceholderText(/SELECT \* FROM/)).toBeInTheDocument();
});
