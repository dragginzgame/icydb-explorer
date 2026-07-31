import { render, screen, fireEvent } from "@testing-library/react";

import { ValueCell, formatExpanded, isExpandable } from "./ValueCell";

const STRUCTURED =
  '{name: "Rem", socials: {github: "rem-code-s", bluesky: null}, tags: ["red", "primary"]}';

test("renders a text value verbatim", () => {
  render(<ValueCell value={{ kind: "text", display: "hello" }} />);
  expect(screen.getByText("hello")).toBeDefined();
});

test("renders null as a visible placeholder rather than empty space", () => {
  render(<ValueCell value={{ kind: "null", display: "" }} />);
  expect(screen.getByText("null")).toBeDefined();
});

test("right-aligns numeric kinds", () => {
  const { container } = render(<ValueCell value={{ kind: "nat", display: "42" }} />);
  expect(container.firstChild).toHaveClass("text-right");
});

/// Identifier kinds route through `Identifier`, which is what makes them
/// elided, copyable, and keyboard-reachable.
test("renders principals through Identifier", () => {
  render(<ValueCell value={{ kind: "principal", display: "aaaaa-aa-bbbbb-bb-ccccc-cc-ddddd" }} />);
  expect(screen.getByRole("button")).toBeInTheDocument();
});

test("a short value needs no expand affordance", () => {
  render(<ValueCell value={{ kind: "text", display: "short" }} />);
  expect(screen.queryByRole("button", { name: /expand|collapse/i })).toBeNull();
});

test("a long value offers an expand affordance and reports the click", () => {
  const onToggle = vi.fn();
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={onToggle} />);

  fireEvent.click(screen.getByRole("button", { name: /expand/i }));
  expect(onToggle).toHaveBeenCalled();
});

test("the affordance reflects the expanded state", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} expanded onToggle={vi.fn()} />);
  expect(screen.getByRole("button", { name: /collapse/i })).toBeInTheDocument();
});

/// `aria-expanded` says a control discloses something; `aria-controls` says
/// what it discloses. Without it, the relationship is visual only.
test("an expanded cell exposes aria-controls pointing at its subRowId", () => {
  render(
    <ValueCell
      value={{ kind: "map", display: STRUCTURED }}
      expanded
      subRowId="row-0-col-1-subrow"
      onToggle={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: /collapse/i })).toHaveAttribute(
    "aria-controls",
    "row-0-col-1-subrow",
  );
});

/// A collapsed control has nothing open to point at. Even if a caller passes
/// `subRowId` while the cell is collapsed, the attribute must not appear —
/// assistive tech follows `aria-controls` and a dangling id is worse than none.
test("a collapsed cell carries no aria-controls even if subRowId is passed", () => {
  render(
    <ValueCell
      value={{ kind: "map", display: STRUCTURED }}
      subRowId="row-0-col-1-subrow"
      onToggle={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: /expand/i })).not.toHaveAttribute("aria-controls");
});

/// The column name is what makes one expand control distinguishable from the
/// next. Without it a row with three structured columns has three buttons all
/// named "Expand value".
test("the affordance names its column", () => {
  const { unmount } = render(
    <ValueCell value={{ kind: "map", display: STRUCTURED }} column="profile" onToggle={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Expand profile" })).toBeInTheDocument();
  unmount();

  render(
    <ValueCell
      value={{ kind: "map", display: STRUCTURED }}
      column="profile"
      expanded
      onToggle={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Collapse profile" })).toBeInTheDocument();
});

/// A `ValueCell` used outside the grid has no column to name, and an aria-label
/// of "Expand undefined" would be worse than the generic one.
test("the affordance falls back to a generic name with no column", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Expand value" })).toBeInTheDocument();
});

/// Clipped text still has to be reachable without expanding.
test("a clipped value exposes its full text in title", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={vi.fn()} />);
  expect(screen.getByTitle(STRUCTURED)).toBeInTheDocument();
});

/// The test above passes `onToggle`, so it only ever exercises the EXPANDABLE
/// branch — which is why a dropped `title` on the plain branch survived a full
/// green suite. This one pins the other branch, and it matters because the two
/// bounds are in different units: `CLIP_AFTER` counts 48 characters, `max-w-cell`
/// is a container-relative width capped at 22rem (352px) — see `tokens.css`. A
/// 45-character value of digits and capitals overflows the box and clips while
/// `isExpandable` reports false, so there is no chevron either — `title` is
/// then the ONLY way to read the value.
test("a non-expandable value still exposes its full text in title", () => {
  const belowThreshold = "A9B8C7D6E5F4G3H2-J1K0L9M8N7O6P5Q4R3-0000000".slice(0, 45);
  expect(isExpandable({ kind: "text", display: belowThreshold })).toBe(false);

  render(<ValueCell value={{ kind: "text", display: belowThreshold }} />);
  expect(screen.getByTitle(belowThreshold)).toBeInTheDocument();
});

/// Numbers were exempt from both the cap and the expand affordance, but
/// `intbig`/`natbig` are arbitrary precision and `nat128` reaches 39 digits, so
/// the column blows out exactly like a structured value — the very bug this
/// phase exists to fix. Non-expandable by design, so `title` is the only route
/// to the full value.
test("a big number is width-capped, clips, and keeps its full value in title", () => {
  const huge = "9".repeat(78);
  expect(isExpandable({ kind: "natbig", display: huge })).toBe(false);

  const { container } = render(<ValueCell value={{ kind: "natbig", display: huge }} />);
  expect(container.firstChild).toHaveClass("max-w-cell");
  expect(container.firstChild).toHaveClass("truncate");
  expect(container.firstChild).toHaveClass("text-right");
  expect(container.firstChild).toHaveClass("tabular-nums");
  expect(screen.getByTitle(huge)).toBeInTheDocument();
});

/// `view/value.rs` renders a blob as `"<n> bytes"` — a label, not the value. As
/// an identifier it became a button whose click copied the literal string
/// "1024 bytes" and confirmed success: a misleading action where inert text
/// belonged.
test("a blob renders as inert text, not a copyable identifier", () => {
  render(<ValueCell value={{ kind: "blob", display: "1024 bytes" }} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("1024 bytes")).toBeInTheDocument();
});

test("isExpandable is true only for values that would clip", () => {
  expect(isExpandable({ kind: "map", display: STRUCTURED })).toBe(true);
  expect(isExpandable({ kind: "text", display: "short" })).toBe(false);
  expect(isExpandable({ kind: "null", display: "" })).toBe(false);
});

test("isExpandable is false at the threshold and true one character over", () => {
  expect(isExpandable({ kind: "text", display: "x".repeat(48) })).toBe(false);
  expect(isExpandable({ kind: "text", display: "x".repeat(49) })).toBe(true);
});

/// The central fix of this phase. jsdom cannot execute CSS layout, so this
/// asserts the mechanism is present rather than that clipping occurs — without a
/// bounded box `truncate` does nothing at all, and one structured value pushes
/// every later column off-screen. That was the bug; this is the only thing
/// standing between a future edit and its return.
test("a non-expandable value renders in a width-bounded, clipping box", () => {
  const { container } = render(<ValueCell value={{ kind: "text", display: "short" }} />);
  expect(container.firstChild).toHaveClass("max-w-cell");
  expect(container.firstChild).toHaveClass("truncate");
});

/// The expandable branch needs the cap and the clip on *different* elements: the
/// cap bounds the flex row, and the text child needs `min-w-0` because a flex
/// item defaults to `min-width: auto` and will refuse to shrink below its
/// content — so without it the cap is inert and the column blows out anyway.
test("an expandable value bounds the row and lets its text shrink to clip", () => {
  const { container } = render(
    <ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={vi.fn()} />,
  );
  expect(container.firstChild).toHaveClass("max-w-cell");

  const text = screen.getByTitle(STRUCTURED);
  expect(text).toHaveClass("truncate");
  expect(text).toHaveClass("min-w-0");
});

/// Arrays read one item per line — a truncated bracket soup tells the reader
/// nothing, which is the complaint that started this phase.
test("formatExpanded puts each array item on its own line", () => {
  const lines = formatExpanded('["red", "primary", "blue"]').split("\n");
  expect(lines.filter((line) => line.includes("red"))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("primary"))).toHaveLength(1);
  expect(lines.some((line) => line.includes("red") && line.includes("primary"))).toBe(false);
});

test("formatExpanded indents by nesting depth", () => {
  const output = formatExpanded('{a: 1, b: {c: 2}}');
  const cLine = output.split("\n").find((line) => line.includes("c:")) ?? "";
  const aLine = output.split("\n").find((line) => line.includes("a:")) ?? "";
  expect(cLine.length - cLine.trimStart().length).toBeGreaterThan(
    aLine.length - aLine.trimStart().length,
  );
});

/// Lossy formatting would be a bug: the reader is expanding precisely because
/// they want the whole value.
test("formatExpanded preserves every non-whitespace character", () => {
  const strip = (text: string) => text.replace(/\s/g, "");
  expect(strip(formatExpanded(STRUCTURED))).toBe(strip(STRUCTURED));
});
