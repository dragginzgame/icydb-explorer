import { render, screen } from "@testing-library/react";
import { ValueCell } from "./ValueCell";

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

test("renders principals and ulids in a monospace font", () => {
  const { container } = render(<ValueCell value={{ kind: "principal", display: "aaaaa-aa" }} />);
  expect(container.firstChild?.className).toContain("font-mono");
});
