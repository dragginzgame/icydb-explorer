import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CopyButton } from "./CopyButton";

function stubClipboard(): string[] {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });

  return written;
}

afterEach(() => vi.unstubAllGlobals());

test("copies the value and confirms it", async () => {
  const written = stubClipboard();
  render(<CopyButton value="01JBQPZ" label="Copy id" />);

  fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

  await waitFor(() => expect(written).toEqual(["01JBQPZ"]));
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
});

/// `copyText` has two routes and neither is guaranteed in a webview, so a copy
/// that did not happen must not be reported as one.
test("a failed copy confirms nothing", async () => {
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("refused");
      },
    },
  });
  const exec = vi.fn(() => false);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  render(<CopyButton value="x" label="Copy id" />);

  fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

  await waitFor(() => expect(exec).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("");
});

/// The blur-after-pointer-copy that used to live here is gone. Its only job was to
/// undo a focus-based reveal, and that reveal is gone too — visibility is now driven
/// by hover alone, so nothing focus does can pin the control. Taking focus off a
/// keyboard user's button is a real cost, and with no reveal to undo it bought
/// nothing.
test("copying leaves focus where it was", () => {
  stubClipboard();
  render(<CopyButton value="x" label="Copy id" />);
  const button = screen.getByRole("button", { name: "Copy id" });
  button.focus();

  fireEvent.click(button, { detail: 1 });

  expect(document.activeElement).toBe(button);
});

/// A second copy must not have its confirmation cut short by the first click's
/// pending hide.
test("copying twice keeps the confirmation up", async () => {
  vi.useFakeTimers();
  stubClipboard();
  render(<CopyButton value="x" label="Copy id" />);
  const button = screen.getByRole("button", { name: "Copy id" });

  fireEvent.click(button, { detail: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  fireEvent.click(button, { detail: 1 });
  await vi.advanceTimersByTimeAsync(400);

  // The first timer would have fired by now; the second click reset it.
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
  vi.useRealTimers();
});
