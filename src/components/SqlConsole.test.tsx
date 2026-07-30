import { render, screen, fireEvent } from "@testing-library/react";
import { SqlConsole } from "./SqlConsole";

test("surfaces a rejection explanation without running the statement", () => {
  const onRun = vi.fn();
  render(<SqlConsole onRun={onRun} error={{ kind: "rejected", explanation: "INSERT is not available — this explorer is read-only." }} />);
  expect(screen.getByText(/read-only/i)).toBeDefined();
});

test("notifies when a default LIMIT was appended", () => {
  render(<SqlConsole onRun={() => {}} limitAppended />);
  expect(screen.getByText(/limit/i)).toBeDefined();
});

test("runs the statement on submit", () => {
  const onRun = vi.fn();
  render(<SqlConsole onRun={onRun} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SELECT 1" } });
  fireEvent.click(screen.getByRole("button", { name: /run/i }));
  expect(onRun).toHaveBeenCalledWith("SELECT 1");
});
