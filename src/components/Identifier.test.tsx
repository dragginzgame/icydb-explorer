import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { Identifier } from "./Identifier";

const PRINCIPAL = "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe";

beforeEach(() => {
  document.execCommand = (() => true) as typeof document.execCommand;
});

test("shows the elided value but exposes the full one", () => {
  render(<Identifier value={PRINCIPAL} />);
  const element = screen.getByRole("button");
  expect(element).toHaveTextContent("bg33z-ib5mx…acfnn-iqe");
  expect(element).toHaveAttribute("title", PRINCIPAL);
});

/// The elided text is lossy on purpose, so copying must yield the original —
/// copying what is on screen would hand the user a broken identifier.
test("copies the full value, not the elided one", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(copied).toEqual([PRINCIPAL]));
});

test("confirms after a successful copy", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  expect(await screen.findByText(/copied/i)).toBeInTheDocument();
});

/// Waits for the failure path to actually COMPLETE before asserting absence.
/// `execCommand` being called is the observable proof that `copyText` fell
/// through and reported failure; without that wait, the assertion below runs
/// before the rejected promise's continuation is even queued and would pass
/// with the click handler removed entirely.
test("does not claim success when the copy failed", async () => {
  const attempts: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.reject(new Error("denied")) },
    configurable: true,
  });
  const original = document.execCommand;
  document.execCommand = ((command: string) => {
    attempts.push(command);
    return false;
  }) as typeof document.execCommand;

  try {
    render(<Identifier value={PRINCIPAL} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(attempts).toEqual(["copy"]));
    expect(screen.queryByText(/copied/i)).toBeNull();
  } finally {
    document.execCommand = original;
  }
});

/// Regression test for the confirmation timer: without a ref tracking the
/// pending hide, the first click's timeout fires and hides the confirmation
/// that the second click just retriggered.
test("a second click restarts the confirmation rather than inheriting the first timer", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });
  vi.useFakeTimers();
  try {
    render(<Identifier value={PRINCIPAL} />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(800);
    fireEvent.click(button);
    // 1300ms after the FIRST click: the first click's timer has fired. Without
    // the ref the confirmation would already be gone.
    await vi.advanceTimersByTimeAsync(500);

    expect(screen.queryByText(/copied/i)).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("leaves a short value unelided", () => {
  render(<Identifier value="aaaaa-aa" />);
  expect(screen.getByRole("button")).toHaveTextContent("aaaaa-aa");
});
