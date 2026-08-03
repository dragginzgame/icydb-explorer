import { render, screen } from "@testing-library/react";

import { SchemaPanel } from "./SchemaPanel";

/// The real column that motivated this, read off toko's live `User` table.
const PROFILE_RAW =
  "composite(path=Profile, codec=structural_v1, shape=record{" +
  "description:composite(path=TextDescription, codec=structural_v1, shape=newtype<text(max_len=1500)>)?, " +
  "name:composite(path=TextName, codec=structural_v1, shape=newtype<text(max_len=50)>)?, " +
  "url:composite(path=Url, codec=structural_v1, shape=newtype<text(unbounded)>)?})";

const assets = {
  field: "assets",
  targetEntity: "ProjectAsset",
  targetStorePath: "toko::project::store::AssetStore",
  cardinality: "list",
};

const owner = {
  field: "owner",
  targetEntity: "Session",
  targetStorePath: "toko::user::store::SessionStore",
  cardinality: "single",
};

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
  indexes: ["uniq_user__pid"], relations: [],
};

test("scalars read as themselves", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.getByText("ulid")).toBeInTheDocument();
});

/// The whole point. A composite must not print its shape, because the fields it
/// would list are already rows in this same table.
test("a composite is summarised, not dumped", () => {
  render(<SchemaPanel schema={schema} />);

  // The composite's own name, which is all that survives the summary.
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

/// The relation graph is in every DESCRIBE payload and was fetched and discarded
/// until now. Surfacing it is the substrate for following one.
test("declared relations are listed with their target", () => {
  render(<SchemaPanel schema={{ ...schema, relations: [assets, owner] }} />);

  expect(screen.getByText("Relations")).toBeInTheDocument();
  expect(screen.getByText("assets")).toBeInTheDocument();
  expect(screen.getByText("ProjectAsset")).toBeInTheDocument();
  expect(screen.getByText("Session")).toBeInTheDocument();
});

/// A relation's target takes --accent, the same colour as a primary key, because
/// it carries the same standing: the schema declares it. An inferred
/// cross-canister link must never render this way, and that distinction is only
/// meaningful if the declared case actually claims the colour.
test("a declared target is accent-coloured, marking it as real metadata", () => {
  render(<SchemaPanel schema={{ ...schema, relations: [assets] }} />);

  expect(screen.getByText("ProjectAsset").className).toMatch(/\btext-accent\b/);
});

/// The store path is what makes "same canister" checkable rather than asserted,
/// so it has to be reachable — but it is a long qualified path and the pane is
/// narrow, so it lives on hover.
test("the target store is on hover, not on the row", () => {
  render(<SchemaPanel schema={{ ...schema, relations: [assets] }} />);

  const row = screen.getByText("assets").closest("li");
  expect(row?.textContent).not.toMatch(/AssetStore/);
  expect(row?.title).toMatch(/toko::project::store::AssetStore/);
  // And it says whose claim this is, which is the whole point of the colour.
  expect(row?.title).toMatch(/Declared by the schema/);
});

/// "one" or "many" is what a reader can act on: whether following this lands on
/// a single row or a page of them. `list` and `set` differ in storage, not in
/// what the reader will see.
test("cardinality reads as one or many rather than icydb's spelling", () => {
  render(
    <SchemaPanel
      schema={{
        ...schema,
        relations: [
          assets,
          owner,
          { ...assets, field: "tags", targetEntity: "Tag", cardinality: "set" },
        ],
      }}
    />,
  );

  expect(screen.getByText("assets").closest("li")?.textContent).toMatch(/many$/);
  expect(screen.getByText("owner").closest("li")?.textContent).toMatch(/one$/);
  expect(screen.getByText("tags").closest("li")?.textContent).toMatch(/many$/);
});

/// The Rust side maps icydb's enum exhaustively, so an unrecognised value here
/// means icydb grew a variant. Showing it beats guessing which of one/many it is.
test("an unrecognised cardinality is shown rather than guessed at", () => {
  render(
    <SchemaPanel schema={{ ...schema, relations: [{ ...assets, cardinality: "ordered_set" }] }} />,
  );

  expect(screen.getByText("assets").closest("li")?.textContent).toMatch(/ordered_set$/);
});

/// An entity with no relations gets no heading — an empty section is a promise
/// of content that never arrives.
test("no relations means no Relations heading", () => {
  render(<SchemaPanel schema={schema} />);

  expect(screen.queryByText("Relations")).not.toBeInTheDocument();
});
