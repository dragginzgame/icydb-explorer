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
  expect(spanning?.getAttribute("colspan")).toBe("2");
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
    expect(row.querySelectorAll('[data-skeleton="true"]')).toHaveLength(wide.columns.length);
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
