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

/// Confirming a copy that did not happen is worse than saying nothing.
test("does not claim success when the copy failed", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: () => Promise.reject(new Error("denied")),
    },
    configurable: true,
  });
  document.execCommand = (() => false) as typeof document.execCommand;

  render(<Identifier value={PRINCIPAL} />);
  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(screen.queryByText(/copied/i)).toBeNull());
});

test("leaves a short value unelided", () => {
  render(<Identifier value="aaaaa-aa" />);
  expect(screen.getByRole("button")).toHaveTextContent("aaaaa-aa");
});
