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

/// "No rows" and "still loading" are different states and must not be confused.
test("an empty result is not mistaken for loading", () => {
  render(<RowGrid rows={{ ...wide, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText(/no rows/i)).toBeInTheDocument();
  expect(document.querySelectorAll('[data-skeleton="true"]')).toHaveLength(0);
});
