import { fireEvent, render, screen } from "@testing-library/react";
import { RowGrid } from "./RowGrid";

const rows = {
  entity: "demo_row",
  columns: ["id", "count"],
  rows: [[{ kind: "ulid", display: "01H" }, { kind: "nat", display: "7" }]],
  rowCount: 1,
  nextCursor: null,
};

test("renders column headers and cells", () => {
  render(<RowGrid rows={rows} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText("id")).toBeDefined();
  expect(screen.getByText("01H")).toBeDefined();
  expect(screen.getByText("7")).toBeDefined();
});

test("hides Load more when there is no more to load", () => {
  render(<RowGrid rows={rows} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
});

test("shows Load more when more may exist", () => {
  render(<RowGrid rows={rows} hasMore onLoadMore={() => {}} />);
  expect(screen.getByRole("button", { name: /load more/i })).toBeDefined();
});

test("renders an empty result without crashing", () => {
  render(<RowGrid rows={{ ...rows, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText(/no rows/i)).toBeDefined();
});

const STRUCTURED =
  '{name: "Rem", socials: {github: "rem-code-s", bluesky: null}, tags: ["red", "primary"]}';

const wide = {
  entity: "User",
  columns: ["id", "profile"],
  rows: [
    [
      { kind: "ulid", display: "01KYVVPD156GJG000000000001" },
      { kind: "map", display: STRUCTURED },
    ],
  ],
  rowCount: 1,
  nextCursor: null,
};

test("expanding a cell opens a sub-row spanning every column", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));

  const spanning = document.querySelector("td[colspan]");
  expect(spanning).not.toBeNull();
  // Two data columns plus the ordinal: the sub-row has to span the whole grid, or
  // the last column escapes the expanded panel.
  expect(spanning?.getAttribute("colspan")).toBe("3");
});

test("collapsing removes the sub-row", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));
  fireEvent.click(screen.getByRole("button", { name: /collapse/i }));

  expect(document.querySelector("td[colspan]")).toBeNull();
});

/// `aria-expanded` says a control discloses something; `aria-controls` says
/// what. Without the pair, a screen-reader user is told a button is expanded
/// and given no way to reach what it expanded.
test("an expanded cell's control points at the sub-row it opened", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  const control = screen.getAllByRole("button", { name: /expand/i })[0];
  fireEvent.click(control);

  const target = control.getAttribute("aria-controls");
  expect(target).toBeTruthy();
  const subRow = document.getElementById(target!);
  expect(subRow).not.toBeNull();
  expect(subRow!.tagName.toLowerCase()).toBe("tr");
});

/// A collapsed control has nothing open to point at. `aria-controls` naming an
/// id that is not in the document is worse than omitting it, because
/// assistive tech will still try to follow it.
test("a collapsed control carries no aria-controls", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  const control = screen.getByRole("button", { name: /expand/i });
  expect(control).not.toHaveAttribute("aria-controls");
});

/// Every expand control used to be named "Expand value", so a row with several
/// structured columns gave a screen-reader user a list of identical buttons —
/// and forced these tests onto positional indexing. The grid knows the column
/// names, so it threads them through.
test("each expand control is named for its column", () => {
  const twoStructured = {
    entity: "User",
    columns: ["profile", "settings"],
    rows: [
      [
        { kind: "map", display: STRUCTURED },
        { kind: "map", display: `${STRUCTURED} ` },
      ],
    ],
    rowCount: 1,
    nextCursor: null,
  };
  render(<RowGrid rows={twoStructured} hasMore={false} onLoadMore={() => {}} />);

  const names = screen
    .getAllByRole("button", { name: /expand/i })
    .map((button) => button.getAttribute("aria-label"));
  expect(names).toEqual(["Expand profile", "Expand settings"]);
  // Distinguishable is the actual requirement, not merely non-empty.
  expect(new Set(names).size).toBe(names.length);

  fireEvent.click(screen.getByRole("button", { name: "Expand settings" }));
  expect(screen.getByRole("button", { name: "Collapse settings" })).toBeInTheDocument();
});

/// One cell at a time: two open sub-rows in a wide table push the row you were
/// reading off-screen.
test("expanding a second cell closes the first", () => {
  const twoWide = {
    ...wide,
    rows: [
      [
        { kind: "map", display: STRUCTURED },
        { kind: "map", display: `${STRUCTURED} ` },
      ],
    ],
  };
  render(<RowGrid rows={twoWide} hasMore={false} onLoadMore={() => {}} />);

  const [first, second] = screen.getAllByRole("button", { name: /expand/i });
  fireEvent.click(first);
  fireEvent.click(second);

  expect(document.querySelectorAll("td[colspan]")).toHaveLength(1);
});

/// Skeletons keep the column count so the grid does not reflow when data lands.
test("loading renders skeleton rows at the known column count", () => {
  render(
    <RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} loading />,
  );

  // The requirement is that skeletons carry the REAL column count, so the grid
  // does not reflow when data lands. A bare "more than zero" would pass for a
  // single placeholder cell and test nothing about reflow.
  const skeletonRows = [...document.querySelectorAll("tbody tr")];
  expect(skeletonRows.length).toBeGreaterThan(1);
  for (const row of skeletonRows) {
    // `+ 1` for the ordinal column, which the skeleton carries too — a header
    // that appeared only with the data would shift every column right at the
    // moment this table exists to keep still.
    expect(row.querySelectorAll('[data-skeleton="true"]')).toHaveLength(
      wide.columns.length + 1,
    );
  }
  expect(screen.queryByText(/no rows/i)).toBeNull();
});

/// A skeleton conveys "loading" visually and nothing at all to a screen
/// reader: the bars are aria-hidden, so without `aria-busy` the grid reads as
/// an empty table for the whole fetch — indistinguishable from a table with
/// no rows.
test("the loading grid announces itself as busy", () => {
  render(<RowGrid rows={null} skeletonColumns={3} loading hasMore={false} onLoadMore={() => {}} />);

  expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
});

/// Asserted positively as "false", not as `not.toHaveAttribute(..., "true")`.
/// The negative form cannot tell `aria-busy="false"` from the attribute being
/// absent entirely, so it stays green when `aria-busy` is dropped from the real
/// grid altogether — which is exactly what it exists to catch. React renders
/// `aria-busy={false}` as the string "false", so the attribute really is present
/// and the stronger assertion is available.
test("a loaded grid reports itself as not busy", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "false");
});

/// "No rows" and "still loading" are different states and must not be confused.
test("an empty result is not mistaken for loading", () => {
  render(<RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText(/no rows/i)).toBeInTheDocument();
  expect(document.querySelectorAll('[data-skeleton="true"]')).toHaveLength(0);
});

/// The explanatory line, not just the title. Only the title was asserted before,
/// so the sentence under it was an unverified string — and it named the entity,
/// which is the one part a reader uses to tell "this table is empty" from "some
/// other table is empty". It must also not say rows are coming "yet": the app is
/// read-only and can never add them.
test("the empty state names the entity and does not promise rows are coming", () => {
  render(<RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);

  expect(screen.getByText(new RegExp(`${wide.entity} exists but is empty`, "i"))).toBeInTheDocument();
  expect(screen.queryByText(/yet/i)).not.toBeInTheDocument();
});

/// Zebra striping must derive from the row's position in the *data*, not its
/// position in the DOM: the expansion sub-row is itself a `<tr>` in the same
/// `<tbody>`, so a DOM-order-based stripe (`:nth-child`) reshuffles every row
/// below the one that gets expanded. Four rows, expand the second (not the
/// last) and check every row *below* it kept its pre-expansion stripe.
test("expanding a cell does not reshuffle the zebra striping of rows below it", () => {
  const striped = {
    entity: "demo_row",
    columns: ["id", "profile"],
    rows: [0, 1, 2, 3].map((index) => [
      { kind: "ulid", display: `01H-row-${index}` },
      { kind: "map", display: `${STRUCTURED} ${index}` },
    ]),
    rowCount: 4,
    nextCursor: null,
  };

  render(<RowGrid rows={striped} hasMore={false} onLoadMore={() => {}} />);

  // Only the data rows: excludes any sub-row, which is identifiable by its
  // `colspan` cell regardless of where it currently sits in the tbody.
  const dataRows = () =>
    [...document.querySelectorAll("tbody tr")].filter((tr) => !tr.querySelector("td[colspan]"));
  const stripeOf = (tr: Element) => tr.classList.contains("bg-surface-1");

  const before = dataRows().map(stripeOf);
  expect(before).toEqual([true, false, true, false]);

  const buttons = screen.getAllByRole("button", { name: /expand/i });
  fireEvent.click(buttons[1]); // expand row index 1 (not the last row)

  const after = dataRows();
  expect(after).toHaveLength(4);
  // Rows below the expanded one must keep the exact class they had before.
  expect(stripeOf(after[2])).toBe(before[2]);
  expect(stripeOf(after[3])).toBe(before[3]);
});

/// `expanded` is a pair of indices into `rows`, so it is only meaningful for the
/// data it was captured against. Nothing stale is reachable today, but only
/// because `App.tsx` unmounts the grid between fetches. Keeping it mounted —
/// which wiring `loading` requires — makes `row[openColumn]` undefined the
/// moment a narrower entity arrives, and the resulting TypeError has no error
/// boundary above it.
test("switching to a narrower entity drops the stale expansion instead of throwing", () => {
  const columns = ["a", "b", "c", "d", "profile", "f"];
  const sixWide = {
    entity: "Wide",
    columns,
    rows: [columns.map((name) => ({ kind: "map", display: `${STRUCTURED} ${name}` }))],
    rowCount: 1,
    nextCursor: null,
  };
  const narrow = {
    entity: "Narrow",
    columns: ["id", "name"],
    rows: [[{ kind: "ulid", display: "01N" }, { kind: "text", display: "narrow" }]],
    rowCount: 1,
    nextCursor: null,
  };

  const { rerender } = render(<RowGrid rows={sixWide} hasMore={false} onLoadMore={() => {}} />);

  // Column index 4 — out of range for the two-column entity that follows.
  fireEvent.click(screen.getByRole("button", { name: "Expand profile" }));
  expect(document.querySelectorAll("td[colspan]")).toHaveLength(1);

  expect(() =>
    rerender(<RowGrid rows={narrow} hasMore={false} onLoadMore={() => {}} />),
  ).not.toThrow();

  expect(document.querySelectorAll("td[colspan]")).toHaveLength(0);
  expect(screen.getByText("narrow")).toBeInTheDocument();
});

/// The guard in `ExpandableRow` catches only the out-of-range case. A different
/// entity that happens to have the same column count leaves the index perfectly
/// valid, so nothing throws — instead the reader is shown an expanded sub-row
/// they never opened, containing a different entity's data. Only invalidation
/// catches this, which is what makes it the assertion that discriminates.
test("switching to a same-width entity also drops the expansion", () => {
  const first = {
    entity: "User",
    columns: ["id", "profile"],
    rows: [[{ kind: "ulid", display: "01A" }, { kind: "map", display: `${STRUCTURED} first` }]],
    rowCount: 1,
    nextCursor: null,
  };
  const second = {
    entity: "Order",
    columns: ["id", "profile"],
    rows: [[{ kind: "ulid", display: "01B" }, { kind: "map", display: `${STRUCTURED} second` }]],
    rowCount: 1,
    nextCursor: null,
  };

  const { rerender } = render(<RowGrid rows={first} hasMore={false} onLoadMore={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand profile" }));
  expect(document.querySelectorAll("td[colspan]")).toHaveLength(1);

  rerender(<RowGrid rows={second} hasMore={false} onLoadMore={() => {}} />);

  expect(document.querySelectorAll("td[colspan]")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Expand profile" })).toBeInTheDocument();
});

/// The other half of the same rule: `loadMore` APPENDS rows to the same entity,
/// and a sub-row the reader opened must survive that. Invalidating on the row
/// count would close it under them on every page.
test("loading another page keeps an open sub-row open", () => {
  const page1 = {
    entity: "User",
    columns: ["id", "profile"],
    rows: [
      [{ kind: "ulid", display: "01A" }, { kind: "map", display: `${STRUCTURED} A` }],
    ],
    rowCount: 1,
    nextCursor: null,
  };
  const page2 = {
    ...page1,
    rows: [
      ...page1.rows,
      [{ kind: "ulid", display: "01B" }, { kind: "map", display: `${STRUCTURED} B` }],
    ],
    rowCount: 2,
  };

  const { rerender } = render(<RowGrid rows={page1} hasMore onLoadMore={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand profile" }));
  expect(document.querySelectorAll("td[colspan]")).toHaveLength(1);

  rerender(<RowGrid rows={page2} hasMore={false} onLoadMore={() => {}} />);

  const subRows = document.querySelectorAll("td[colspan]");
  expect(subRows).toHaveLength(1);
  expect(subRows[0].textContent).toContain("A");
});

/// The whole reason `expanded` is a single `{row, column}` object rather than
/// per-cell state: opening a cell in one row must not leak into another row.
/// The existing suite only ever expands within a single-row fixture, so the
/// `expanded.row !== rowIndex` branch has never actually been exercised.
test("expanding a cell in a different row shows only that row's sub-row", () => {
  const rowA =
    '{name: "Alpha", socials: {github: "alpha-handle", bluesky: null}, tags: ["red", "primary"]}';
  const rowB =
    '{name: "Bravo", socials: {github: "bravo-handle", bluesky: null}, tags: ["blue", "secondary"]}';
  const twoRows = {
    entity: "User",
    columns: ["id", "profile"],
    rows: [
      [{ kind: "ulid", display: "01A" }, { kind: "map", display: rowA }],
      [{ kind: "ulid", display: "01B" }, { kind: "map", display: rowB }],
    ],
    rowCount: 2,
    nextCursor: null,
  };

  render(<RowGrid rows={twoRows} hasMore={false} onLoadMore={() => {}} />);

  const buttons = screen.getAllByRole("button", { name: /expand/i });
  fireEvent.click(buttons[0]); // open row 0's cell
  fireEvent.click(buttons[1]); // open row 1's cell — must close row 0's, not add to it

  const subRows = document.querySelectorAll("td[colspan]");
  expect(subRows).toHaveLength(1);
  expect(subRows[0].textContent).toContain("Bravo");
  expect(subRows[0].textContent).toContain("bravo-handle");
  expect(subRows[0].textContent).not.toContain("Alpha");
  expect(subRows[0].textContent).not.toContain("alpha-handle");
});

/// The sticky header only works when the pane owns the scrolling. While
/// `RowGrid` had its own `overflow-auto`, that inner box was the `thead`'s
/// nearest scrollport, its `scrollTop` was permanently 0, and `sticky top-0`
/// resolved to nothing. jsdom cannot scroll, so this pins the structural
/// precondition: the header is sticky and `RowGrid` contains no scrollport.
test("the grid does not own a scroll container, so its sticky header can stick", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  expect(document.querySelectorAll(".overflow-auto, .overflow-scroll")).toHaveLength(0);
  // `sticky top-0` lives on the `<thead>`, not the individual `<th>`s.
  const header = document.querySelector("thead");
  expect(header).toHaveClass("sticky");
  expect(header).toHaveClass("top-0");
});

/// The grid renders rows and nothing else now: exporting and explaining moved to
/// the pane's header, where they sit beside the pane title rather than below a page
/// that can be a hundred rows tall. Their behaviour is covered in `App.test.tsx`,
/// which is where they are rendered.
test("the grid itself offers no export or explain controls", () => {
  render(<RowGrid rows={wide} hasMore={false} onLoadMore={() => {}} />);

  expect(screen.queryByRole("button", { name: /explain/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
});

/// The one action at the bottom of a long scroll, so it spans the pane rather than
/// hugging the left edge where it is easy to scroll straight past.
test("Load more spans the pane and is padded off the last row", () => {
  render(<RowGrid rows={wide} hasMore onLoadMore={() => {}} />);

  const more = screen.getByRole("button", { name: /load more/i });
  expect(more.className).toMatch(/\bw-full\b/);
  // Padded by its wrapper, so it does not sit flush against the last row's rule.
  expect(more.parentElement?.className).toMatch(/\bp-2\b/);
});

// ── Following a declared relation ────────────────────────────────────────────

const ownerRelation = {
  field: "owner",
  targetEntity: "User",
  targetStorePath: "toko::user::store::UserStore",
  cardinality: "single",
};

const assetsRelation = {
  field: "assets",
  targetEntity: "ProjectAsset",
  targetStorePath: "toko::project::store::AssetStore",
  cardinality: "list",
};

const KEY = "01JB8Z4KQ7Y3M2XV9P0N5RK2M";

const relationRows = {
  entity: "ProjectInstance",
  columns: ["id", "owner", "assets"],
  rows: [
    [
      { kind: "ulid", display: "01JBQPZ" },
      { kind: "ulid", display: KEY },
      { kind: "list", display: `[${KEY}]`, items: [{ kind: "ulid", display: KEY }] },
    ],
  ],
  rowCount: 1,
  nextCursor: null,
};

/// The affordance is matched by column name against `RelationDto.field`, so only
/// the cells actually holding a target's keys get one.
test("a cell holding a relation's key offers to follow it", () => {
  render(
    <RowGrid
      rows={relationRows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation]}
      onFollow={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Follow owner to User" })).toBeInTheDocument();
  // `id` is not a relation field, so it gets nothing.
  expect(screen.queryByRole("button", { name: /Follow id/ })).not.toBeInTheDocument();
});

/// An affordance with nothing behind it is worse than none, so the handler — not
/// the metadata alone — is what makes one appear.
test("no handler means no affordance, however many relations are declared", () => {
  render(
    <RowGrid
      rows={relationRows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation, assetsRelation]}
    />,
  );

  expect(screen.queryByRole("button", { name: /^Follow/ })).not.toBeInTheDocument();
});

/// Following hands back the relation and the cell, which together are everything
/// the caller needs to build a statement — it deliberately does not build one
/// here, because the target's primary key is not known to this component.
test("following reports the relation and the cell that was clicked", () => {
  const followed: { field: string; display: string }[] = [];
  render(
    <RowGrid
      rows={relationRows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation]}
      onFollow={(relation, cell) => followed.push({ field: relation.field, display: cell.display })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Follow owner to User" }));
  expect(followed).toEqual([{ field: "owner", display: KEY }]);
});

/// A null single relation and an empty list are ordinary states of a row. The
/// cell gets no affordance rather than one that would build a statement from no
/// keys.
test("a relation cell with no keys offers nothing", () => {
  render(
    <RowGrid
      rows={{
        ...relationRows,
        rows: [
          [
            { kind: "ulid", display: "01JBQPZ" },
            { kind: "null", display: "" },
            { kind: "list", display: "[]", items: [] },
          ],
        ],
      }}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation, assetsRelation]}
      onFollow={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: /^Follow/ })).not.toBeInTheDocument();
});

/// A list relation is followable from its own cell, and says how many rows it
/// will read — which the reader can only know from the keys in hand.
test("a list relation says how many rows following it reads", () => {
  render(
    <RowGrid
      rows={{
        ...relationRows,
        rows: [
          [
            { kind: "ulid", display: "01JBQPZ" },
            { kind: "ulid", display: KEY },
            {
              kind: "list",
              display: "[a, b]",
              items: [
                { kind: "ulid", display: "a" },
                { kind: "ulid", display: "b" },
              ],
            },
          ],
        ],
      }}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[assetsRelation]}
      onFollow={() => {}}
    />,
  );

  const button = screen.getByRole("button", { name: "Follow assets to ProjectAsset" });
  expect(button.title).toMatch(/2 ProjectAsset rows/);
  // Whose claim this is, and where the target lives — the two things that make
  // the accent colour honest rather than decorative.
  expect(button.title).toMatch(/Declared by the schema/);
  expect(button.title).toMatch(/toko::project::store::AssetStore/);
});

/// Declared metadata takes the primary key's colour. An inferred cross-canister
/// link must never render this way, and that only means something if the declared
/// case actually claims it.
test("the follow control is accent-coloured, marking it as declared", () => {
  render(
    <RowGrid
      rows={relationRows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation]}
      onFollow={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Follow owner to User" }).className).toMatch(
    /\btext-accent\b/,
  );
});

/// A cell with no relation must keep the exact DOM it had before this feature
/// existed — every cell in the app would otherwise gain a flex wrapper for the
/// sake of the few that hold a relation key.
test("cells without a relation gain no wrapper", () => {
  render(
    <RowGrid
      rows={relationRows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[ownerRelation]}
      onFollow={() => {}}
    />,
  );

  // `slice(1)`: the first cell of every row is the ordinal, which is the grid's
  // own annotation rather than one of the entity's columns.
  const cells = screen.getAllByRole("cell").slice(1);
  const follow = screen.getByRole("button", { name: "Follow owner to User" });

  // Structure, not class strings: several value kinds render their own flex
  // container (`Identifier` is `inline-flex`), so matching on class names here
  // asserts nothing about the wrapper this feature adds. What is true of a
  // non-relation cell is that its td holds exactly one element and no control.
  // Follow controls specifically — an identifier cell has a copy button of its
  // own, so counting all buttons would assert the wrong thing.
  expect(cells[0].children).toHaveLength(1);
  expect(cells[0].querySelectorAll('[aria-label^="Follow "]')).toHaveLength(0);

  // The `owner` cell's td also holds one element — the wrapper — but that wrapper
  // holds two: the value and the control, side by side.
  expect(cells[1].children).toHaveLength(1);
  expect(cells[1].firstElementChild?.children).toHaveLength(2);
  expect(cells[1].firstElementChild?.contains(follow)).toBe(true);
});

// ── Naming the canisters a cell points at ────────────────────────────────────

const FLEET = new Map([
  ["j6z74-i3777-77774-qaafa-cai", "project_instance"],
  ["jzyzi-fd777-77774-qaafq-cai", "project_ledger"],
]);
const USER_PID = "b3bcf-xxk7r-uy5st-idags-wlqaj-yd64m-65y2h-pi4oh-7pjmh-zdgac-cqe";

const principalRows = (display: string, kind = "principal") => ({
  entity: "RegistryProject",
  columns: ["id", "pid"],
  rows: [[{ kind: "ulid", display: "01JBQPZ" }, { kind, display }]],
  rowCount: 1,
  nextCursor: null,
});

/// The point of this is the *name*: a bare principal tells a reader nothing.
test("a cell whose principal is a fleet canister names it", () => {
  render(
    <RowGrid
      rows={principalRows("jzyzi-fd777-77774-qaafq-cai")}
      hasMore={false}
      onLoadMore={() => {}}
      fleet={FLEET}
      onGoToCanister={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Go to project_ledger" })).toBeInTheDocument();
});

/// Most principals in a fleet's data are users. Resolving to nothing is the
/// correct answer and the common case, so it must read as normal.
test("a user principal gets no chip", () => {
  render(
    <RowGrid
      rows={principalRows(USER_PID)}
      hasMore={false}
      onLoadMore={() => {}}
      fleet={FLEET}
      onGoToCanister={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: /^Go to / })).not.toBeInTheDocument();
});

/// The real shape from toko: `UserProjects.projects` is a map whose canister ids
/// are nested inside the rendered value.
test("a canister nested in a rendered map is named", () => {
  render(
    <RowGrid
      rows={principalRows(
        "{j6z74-i3777-77774-qaafa-cai: {pid: j6z74-i3777-77774-qaafa-cai}}",
        "map",
      )}
      hasMore={false}
      onLoadMore={() => {}}
      fleet={FLEET}
      onGoToCanister={() => {}}
    />,
  );

  // Once, not twice: the same canister named twice is one canister.
  expect(screen.getAllByRole("button", { name: "Go to project_instance" })).toHaveLength(1);
});

test("clicking the chip reports the canister to go to", () => {
  const went: string[] = [];
  render(
    <RowGrid
      rows={principalRows("jzyzi-fd777-77774-qaafq-cai")}
      hasMore={false}
      onLoadMore={() => {}}
      fleet={FLEET}
      onGoToCanister={(pid) => went.push(pid)}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Go to project_ledger" }));
  expect(went).toEqual(["jzyzi-fd777-77774-qaafq-cai"]);
});

/// Knowing that `jzyzi-…` is `project_ledger` is worth something even when there
/// is nowhere to go, so the label survives without a handler — as text, not as a
/// button that would do nothing.
test("without a handler the role is still named, inertly", () => {
  render(
    <RowGrid
      rows={principalRows("jzyzi-fd777-77774-qaafq-cai")}
      hasMore={false}
      onLoadMore={() => {}}
      fleet={FLEET}
    />,
  );

  expect(screen.getByText("project_ledger")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Go to / })).not.toBeInTheDocument();
});

/// While the fleet is still loading there is nothing to resolve against, and a
/// principal with no name attached is exactly what the reader already had.
test("with no fleet, cells are left alone", () => {
  render(
    <RowGrid
      rows={principalRows("jzyzi-fd777-77774-qaafq-cai")}
      hasMore={false}
      onLoadMore={() => {}}
    />,
  );

  expect(screen.queryByText("project_ledger")).not.toBeInTheDocument();
});

/// A cell can be both a relation to follow and a principal that names a canister.
/// Neither affordance may swallow the other.
test("a relation arrow and a fleet chip coexist on one cell", () => {
  const rows = {
    entity: "RegistryProject",
    columns: ["id", "owner"],
    rows: [
      [
        { kind: "ulid", display: "01JBQPZ" },
        { kind: "principal", display: "jzyzi-fd777-77774-qaafq-cai" },
      ],
    ],
    rowCount: 1,
    nextCursor: null,
  };
  render(
    <RowGrid
      rows={rows}
      hasMore={false}
      onLoadMore={() => {}}
      relations={[
        {
          field: "owner",
          targetEntity: "User",
          targetStorePath: "toko::user::store::UserStore",
          cardinality: "single",
        },
      ]}
      onFollow={() => {}}
      fleet={FLEET}
      onGoToCanister={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Follow owner to User" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Go to project_ledger" })).toBeInTheDocument();
});

// ── The ordinal column ───────────────────────────────────────────────────────

const threeRows = {
  entity: "User",
  columns: ["handle"],
  rows: [
    [{ kind: "text", display: "juno" }],
    [{ kind: "text", display: "remco" }],
    [{ kind: "text", display: "kit" }],
  ],
  rowCount: 3,
  nextCursor: null,
};

test("rows are numbered from one, in order", () => {
  render(<RowGrid rows={threeRows} hasMore={false} onLoadMore={() => {}} />);

  const firstCells = [...document.querySelectorAll("tbody tr")].map(
    (row) => row.querySelector("td")?.textContent,
  );
  expect(firstCells).toEqual(["1", "2", "3"]);
});

/// A column head that reads like a column name invites being mistaken for one, so
/// this is `#` — and it says what it counts on hover, because "position on screen"
/// and "position in the table" diverge the moment a statement carries an OFFSET.
test("the ordinal column is marked as the grid's own, not a column of the table", () => {
  render(<RowGrid rows={threeRows} hasMore={false} onLoadMore={() => {}} />);

  const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(heads).toEqual(["#", "handle"]);
  expect(screen.getByTitle(/Not a row id, and not a position in the table/)).toBeInTheDocument();
});

/// The ordinal is an annotation, not data. A row's own cells have to stay
/// addressable without accounting for it.
test("the ordinal leads the row and the data follows unchanged", () => {
  render(<RowGrid rows={threeRows} hasMore={false} onLoadMore={() => {}} />);

  const cells = [...document.querySelectorAll("tbody tr")[1].querySelectorAll("td")];
  expect(cells[0].textContent).toBe("2");
  expect(cells[1].textContent).toBe("remco");
});

/// Digits down a column have to line up, or a long list is unreadable.
test("the ordinals are tabular so they align", () => {
  render(<RowGrid rows={threeRows} hasMore={false} onLoadMore={() => {}} />);

  const ordinal = document.querySelector("tbody td");
  expect(ordinal?.className).toMatch(/\btabular-nums\b/);
  expect(ordinal?.className).toMatch(/\btext-right\b/);
});

/// A merged sweep numbers the merged list. The `_canister` column stays a column
/// of the result; the ordinal sits in front of it.
test("a merged result is numbered too, in front of the origin column", () => {
  const merged = {
    entity: "User",
    columns: ["_canister", "handle"],
    rows: [
      [{ kind: "text", display: "shard_1" }, { kind: "text", display: "juno" }],
      [{ kind: "text", display: "shard_2" }, { kind: "text", display: "remco" }],
    ],
    rowCount: 2,
    nextCursor: null,
  };
  render(<RowGrid rows={merged} hasMore={false} onLoadMore={() => {}} />);

  const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(heads).toEqual(["#", "_canister", "handle"]);
  const first = [...document.querySelectorAll("tbody tr")[0].querySelectorAll("td")];
  expect(first.map((cell) => cell.textContent)).toEqual(["1", "shard_1", "juno"]);
});

/// Appending a page continues the count rather than restarting it — the numbering
/// is of the rows on screen, and after Load more there are more of them.
test("loading another page continues the numbering", () => {
  const { rerender } = render(
    <RowGrid rows={threeRows} hasMore onLoadMore={() => {}} />,
  );
  rerender(
    <RowGrid
      rows={{
        ...threeRows,
        rows: [...threeRows.rows, [{ kind: "text", display: "ada" }]],
        rowCount: 4,
      }}
      hasMore={false}
      onLoadMore={() => {}}
    />,
  );

  const rows = [...document.querySelectorAll("tbody tr")];
  expect(rows[3].querySelector("td")?.textContent).toBe("4");
});
