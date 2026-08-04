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

/// The lingering-icon bug. WebKit focuses a button on click, and while this control
/// is revealed by hover-or-focus a retained focus kept it lit on a cell the mouse
/// had already left — which reads as a rendering fault rather than as focus.
test("a pointer copy does not keep focus", async () => {
  stubClipboard();
  render(<CopyButton value="x" label="Copy id" />);
  const button = screen.getByRole("button", { name: "Copy id" });

  // Focused first, because jsdom does *not* focus a button on click the way a
  // browser does — and the browser's focusing is the entire cause of the bug. The
  // first version of this test clicked a never-focused button and asserted focus
  // had moved: true before the click, so it passed with the fix deleted.
  button.focus();
  expect(document.activeElement).toBe(button);

  // `detail` non-zero is what distinguishes a real click from a keyboard
  // activation; testing-library sends 0 unless told otherwise.
  fireEvent.click(button, { detail: 1 });

  expect(document.activeElement).not.toBe(button);
});

/// But a keyboard user must keep the focus they need to carry on tabbing, so the
/// blur is strictly for pointer activation. `detail` is 0 for Enter or Space on a
/// button, which is exactly the discriminator.
test("a keyboard copy keeps focus", async () => {
  stubClipboard();
  render(<CopyButton value="x" label="Copy id" />);
  const button = screen.getByRole("button", { name: "Copy id" });
  button.focus();

  fireEvent.click(button, { detail: 0 });

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
