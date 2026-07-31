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

/// `elide`'s output length was this cell's only width bound, and for a
/// group-based elision that is unbounded in the length of the groups it keeps —
/// so a long-grouped identifier blew the column out exactly like a structured
/// value. Same cap and same clip as every other `ValueCell` branch.
test("bounds its own width and clips, like every other cell branch", () => {
  const { container } = render(<Identifier value={PRINCIPAL} />);
  expect(container.firstChild).toHaveClass("max-w-88");

  const button = screen.getByRole("button");
  expect(button).toHaveClass("truncate");
  // A flex item defaults to `min-width: auto` and refuses to shrink below its
  // content, which would make the cap above inert.
  expect(button).toHaveClass("min-w-0");
});

/// The confirmation used to render in flow inside the button, so it widened the
/// column for its 1200ms lifetime — in a `table-auto` grid that shifts every
/// column to its right and snaps them back, so clicking one ULID made the whole
/// table jump.
///
/// jsdom performs no layout, so real width is unmeasurable here and this cannot
/// prove the shift is gone. What it CAN pin is the mechanism: the confirmation is
/// out of flow in both states, and the in-flow subtree — the button — is byte
/// identical before and after.
test("the copy confirmation contributes no layout in either state", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  const button = screen.getByRole("button");
  const confirmation = document.querySelector<HTMLElement>('[data-copy-confirmation="true"]');
  if (!confirmation) throw new Error("no confirmation element");

  expect(confirmation).toHaveClass("absolute");
  expect(confirmation.textContent).toBe("");
  const buttonBefore = button.outerHTML;
  const confirmationClassesBefore = confirmation.className;

  fireEvent.click(button);
  expect(await screen.findByText(/copied/i)).toBeInTheDocument();

  // Still out of flow, and positioned identically — the text changed, nothing
  // else did.
  expect(confirmation).toHaveClass("absolute");
  expect(confirmation.className).toBe(confirmationClassesBefore);
  expect(button.outerHTML).toBe(buttonBefore);
});

/// Reserving space by toggling `invisible`/`hidden` would also stop the shift,
/// and would also drop the node from the accessibility tree — `visibility:
/// hidden` and `display: none` both do. The confirmation has to stay
/// announceable, so it lives in a live region that is mounted from the start:
/// a screen reader reports a change *within* an existing region far more
/// reliably than the insertion of a new one.
test("the confirmation stays announceable rather than hidden from assistive tech", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });

  render(<Identifier value={PRINCIPAL} />);
  const region = screen.getByRole("status");
  expect(region).not.toHaveAttribute("aria-hidden");
  expect(region.className).not.toMatch(/\b(?:invisible|hidden|sr-only)\b/);

  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/copied/i));
});
