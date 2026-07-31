import { copyText } from "./copyText";

function withClipboard(writeText: (text: string) => Promise<void>, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return run().finally(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
  });
}

test("uses the clipboard API when it works", async () => {
  const seen: string[] = [];
  await withClipboard(
    async (text) => {
      seen.push(text);
    },
    async () => {
      expect(await copyText("bg33z-ib5mx")).toBe(true);
    },
  );
  expect(seen).toEqual(["bg33z-ib5mx"]);
});

/// The whole reason the fallback exists: the modern API is present but refuses,
/// which is what a webview without a secure context or user activation does.
test("falls back to execCommand when the clipboard API rejects", async () => {
  const original = document.execCommand;
  const calls: string[] = [];
  document.execCommand = ((command: string) => {
    calls.push(command);
    return true;
  }) as typeof document.execCommand;
  try {
    await withClipboard(
      () => Promise.reject(new Error("denied")),
      async () => {
        expect(await copyText("fallback me")).toBe(true);
      },
    );
    expect(calls).toEqual(["copy"]);
  } finally {
    document.execCommand = original;
  }
});

test("falls back when the clipboard API is absent entirely", async () => {
  const original = document.execCommand;
  document.execCommand = (() => true) as typeof document.execCommand;
  try {
    expect(await copyText("no clipboard here")).toBe(true);
  } finally {
    document.execCommand = original;
  }
});

/// Reporting failure honestly matters: the caller shows a "Copied" confirmation,
/// and confirming a copy that did not happen is worse than saying nothing.
test("reports false when every route fails, without throwing", async () => {
  const original = document.execCommand;
  document.execCommand = (() => {
    throw new Error("not implemented");
  }) as typeof document.execCommand;
  try {
    await withClipboard(
      () => Promise.reject(new Error("denied")),
      async () => {
        expect(await copyText("nope")).toBe(false);
      },
    );
  } finally {
    document.execCommand = original;
  }
});

test("leaves no textarea behind after the fallback runs", async () => {
  const original = document.execCommand;
  document.execCommand = (() => true) as typeof document.execCommand;
  try {
    await copyText("tidy up");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  } finally {
    document.execCommand = original;
  }
});
