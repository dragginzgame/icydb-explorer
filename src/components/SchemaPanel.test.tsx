import { render, screen } from "@testing-library/react";

import { SchemaPanel } from "./SchemaPanel";

/// The real column that motivated this, read off toko's live `User` table.
const PROFILE_RAW =
  "composite(path=Profile, codec=structural_v1, shape=record{" +
  "description:composite(path=TextDescription, codec=structural_v1, shape=newtype<text(max_len=1500)>)?, " +
  "name:composite(path=TextName, codec=structural_v1, shape=newtype<text(max_len=50)>)?, " +
  "url:composite(path=Url, codec=structural_v1, shape=newtype<text(unbounded)>)?})";

const schema = {
  entity: "User",
  columns: [
    { name: "id", typeName: "ulid", primaryKey: true, optional: false },
    { name: "authority", typeName: "enum(Authority)", primaryKey: false, optional: false },
    { name: "delegation_pid", typeName: "principal?", primaryKey: false, optional: true },
    { name: "profile", typeName: PROFILE_RAW, primaryKey: false, optional: false },
    {
      name: "├─ name",
      typeName: "composite(path=TextName, codec=structural_v1, shape=newtype<text(max_len=50)>)?",
      primaryKey: false,
      optional: true,
    },
  ],
  indexes: ["uniq_user__pid"],
};

test("scalars read as themselves", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("ulid")).toBeInTheDocument();
});

/// The whole point. A composite must not print its shape, because the fields it
/// would list are already rows in this same table.
test("a composite is summarised, not dumped", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("Profile")).toBeInTheDocument();
  expect(screen.getByText("3 fields")).toBeInTheDocument();
  expect(screen.queryByText(/structural_v1/)).not.toBeInTheDocument();
  expect(screen.queryByText(/codec=/)).not.toBeInTheDocument();
});

/// A summary must never be the only place the truth lives.
test("the raw description is still reachable on hover", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByTitle(PROFILE_RAW)).toBeInTheDocument();
});

test("a named newtype shows its underlying type and bound", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("TextName")).toBeInTheDocument();
  expect(screen.getByText("max 50")).toBeInTheDocument();
});

test("an enum reads as its own name", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("Authority")).toBeInTheDocument();
  expect(screen.getByText("enum")).toBeInTheDocument();
});

/// The key belongs beside its column, not in a third column that is empty on
/// every other row.
test("the primary key is marked on its own row, with no separate key column", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("pk")).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: /key/i })).not.toBeInTheDocument();
});

/// As one string the eye has to step over the tree art to reach the name, so the
/// prefix is split off and dimmed — but it must still be there, because it is
/// what shows the nesting.
test("nesting is kept but separated from the field name", () => {
  render(<SchemaPanel schema={schema} />);

  const nameCell = screen.getByText("name").closest("td");
  expect(nameCell?.textContent).toMatch(/├─/);
  // The name itself is its own element, so it can be styled apart from the art.
  expect(screen.getByText("name").textContent).toBe("name");
});

test("indexes are listed", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("uniq_user__pid")).toBeInTheDocument();
});
