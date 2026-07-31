import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsMenu } from "./SettingsMenu";

test("the menu is closed until the gear is clicked", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("every theme choice is offered", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /follow system/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /console/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: /instrument/i })).toBeInTheDocument();
});

test("the current choice is marked, and only that one", () => {
  render(<SettingsMenu choice="terminal" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByRole("menuitemradio", { name: /console/i })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("choosing a theme reports it and closes the menu", () => {
  const onChoose = vi.fn();
  render(<SettingsMenu choice="system" onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /instrument/i }));

  expect(onChoose).toHaveBeenCalledWith("instrument");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape closes the menu without choosing", () => {
  const onChoose = vi.fn();
  render(<SettingsMenu choice="system" onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onChoose).not.toHaveBeenCalled();
});

/// The component listens for `mousedown`, not `click`. Dispatching the wrong
/// event here would make this test pass while covering nothing — which is
/// exactly why the existing "closes the menu" test does not cover this path.
test("a mousedown outside the menu closes it", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(screen.getByRole("menu")).toBeInTheDocument();

  fireEvent.mouseDown(document.body);

  expect(screen.queryByRole("menu")).toBeNull();
});

/// The other half of the same guard: an inverted `contains` check would close
/// the menu the instant you pressed on one of its own rows, which the test
/// above cannot detect on its own.
test("a mousedown inside the menu leaves it open", () => {
  render(<SettingsMenu choice="system" onChoose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));

  fireEvent.mouseDown(screen.getByRole("menuitemradio", { name: /terminal/i }));

  expect(screen.getByRole("menu")).toBeInTheDocument();
});
