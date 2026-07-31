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

/// Clipped text still has to be reachable without expanding.
test("a clipped value exposes its full text in title", () => {
  render(<ValueCell value={{ kind: "map", display: STRUCTURED }} onToggle={vi.fn()} />);
  expect(screen.getByTitle(STRUCTURED)).toBeInTheDocument();
});

test("isExpandable is true only for values that would clip", () => {
  expect(isExpandable({ kind: "map", display: STRUCTURED })).toBe(true);
  expect(isExpandable({ kind: "text", display: "short" })).toBe(false);
  expect(isExpandable({ kind: "null", display: "" })).toBe(false);
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
