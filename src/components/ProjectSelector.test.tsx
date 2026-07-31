import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ProjectSelector } from "./ProjectSelector";

const open = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

beforeEach(() => {
  open.mockReset();
});

test("shows the root's basename, with the full path available", () => {
  render(<ProjectSelector root="/Users/me/projects/toko" busy={false} onSelect={vi.fn()} />);

  const button = screen.getByRole("button");
  expect(button).toHaveTextContent("toko");
  expect(button).toHaveAttribute("title", "/Users/me/projects/toko");
});

test("invites a choice when no project is open", () => {
  render(<ProjectSelector root={null} busy={false} onSelect={vi.fn()} />);

  expect(screen.getByRole("button")).toHaveTextContent(/choose a project/i);
});

test("passes the picked directory to onSelect", async () => {
  open.mockResolvedValue("/Users/me/projects/other");
  const onSelect = vi.fn();
  render(<ProjectSelector root={null} busy={false} onSelect={onSelect} />);

  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/Users/me/projects/other"));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
});

test("does nothing at all when the dialog is cancelled", async () => {
  open.mockResolvedValue(null);
  const onSelect = vi.fn();
  render(<ProjectSelector root="/Users/me/projects/toko" busy={false} onSelect={onSelect} />);

  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(onSelect).not.toHaveBeenCalled();
});

test("cannot be clicked while a switch is in flight", () => {
  const onSelect = vi.fn();
  render(<ProjectSelector root={null} busy={true} onSelect={onSelect} />);

  const button = screen.getByRole("button");
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
});
