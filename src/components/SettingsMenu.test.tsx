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
