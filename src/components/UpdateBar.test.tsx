import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { UpdateBar } from "./UpdateBar";

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

const UPDATE = {
  version: "0.2.0",
  current: "0.1.0",
  url: "https://github.com/dragginzgame/icydb-explorer/releases/tag/v0.2.0",
};

beforeEach(() => {
  window.localStorage.clear();
  openUrl.mockClear();
  openUrl.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  window.localStorage.clear();
});

test("renders nothing when there is no update", () => {
  const { container } = render(<UpdateBar update={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("names both the available version and the running one", () => {
  render(<UpdateBar update={UPDATE} />);
  const bar = screen.getByRole("status");
  expect(bar.textContent).toContain("0.2.0");
  expect(bar.textContent).toContain("You have 0.1.0");
});

test("opening the release hands the release URL to the OS", () => {
  render(<UpdateBar update={UPDATE} />);

  fireEvent.click(screen.getByRole("button", { name: /view release/i }));

  expect(openUrl).toHaveBeenCalledWith(UPDATE.url);
});

test("dismissing hides the bar", () => {
  render(<UpdateBar update={UPDATE} />);

  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

  expect(screen.queryByRole("status")).toBeNull();
});

test("a dismissal survives a remount", () => {
  const first = render(<UpdateBar update={UPDATE} />);
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  first.unmount();

  render(<UpdateBar update={UPDATE} />);

  expect(screen.queryByRole("status")).toBeNull();
});

/** The reason the dismissal is keyed by version rather than being a boolean. A
 *  flag would make one click a permanent opt-out with no way back. */
test("dismissing one version does not silence the next", () => {
  const first = render(<UpdateBar update={UPDATE} />);
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  first.unmount();

  render(<UpdateBar update={{ ...UPDATE, version: "0.3.0" }} />);

  expect(screen.getByRole("status").textContent).toContain("0.3.0");
});

/** A stored dismissal for a version that is not the one on offer must not
 *  suppress it — the inverse of the test above, guarding the comparison rather
 *  than the write. */
test("a stored dismissal for an unrelated version does not hide the bar", () => {
  window.localStorage.setItem("icydb.update.dismissed", "0.1.5");

  render(<UpdateBar update={UPDATE} />);

  expect(screen.getByRole("status").textContent).toContain("0.2.0");
});

test("a failure to open the release page is reported, not thrown", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  openUrl.mockImplementation(() => Promise.reject(new Error("denied by scope")));

  render(<UpdateBar update={UPDATE} />);
  fireEvent.click(screen.getByRole("button", { name: /view release/i }));

  await waitFor(() => {
    expect(consoleError).toHaveBeenCalled();
  });
  consoleError.mockRestore();
});

/** The bar must not claim to be an installer. This app reads private keys, and
 *  the notify-only design is a security property rather than an unfinished
 *  feature — copy promising to "install" or "update now" would misdescribe what
 *  clicking actually does. */
test("the bar does not offer to install anything", () => {
  render(<UpdateBar update={UPDATE} />);
  const text = screen.getByRole("status").textContent ?? "";
  expect(text).not.toMatch(/install|updating|restart|download now/i);
});
