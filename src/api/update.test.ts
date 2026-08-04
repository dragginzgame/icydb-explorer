import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { checkForUpdate } from "./update";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("0.1.0"),
}));

/** A `fetch` returning one canned release document. */
function respondWith(body: unknown, ok = true) {
  return vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as unknown as Response),
  );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

test("a newer published release is reported, with the tag's v stripped", async () => {
  globalThis.fetch = respondWith({
    tag_name: "v0.2.0",
    html_url: "https://github.com/dragginzgame/icydb-explorer/releases/tag/v0.2.0",
  });

  await expect(checkForUpdate()).resolves.toEqual({
    version: "0.2.0",
    current: "0.1.0",
    url: "https://github.com/dragginzgame/icydb-explorer/releases/tag/v0.2.0",
  });
});

test("the running version is not reported as an update to itself", async () => {
  globalThis.fetch = respondWith({ tag_name: "v0.1.0", html_url: "https://example.invalid/r" });
  await expect(checkForUpdate()).resolves.toBeNull();
});

test("an older release is not reported", async () => {
  globalThis.fetch = respondWith({ tag_name: "v0.0.9", html_url: "https://example.invalid/r" });
  await expect(checkForUpdate()).resolves.toBeNull();
});

test("the request carries GitHub's API Accept header", async () => {
  const fetchMock = respondWith({ tag_name: "v0.2.0", html_url: "https://example.invalid/r" });
  globalThis.fetch = fetchMock;

  await checkForUpdate();

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("api.github.com");
  expect(url).toContain("releases/latest");
  expect((init.headers as Record<string, string>).Accept).toBe("application/vnd.github+json");
});

/** Every one of these is a real thing GitHub or a network can do, and not one of
 *  them may reject — an update check that throws would surface as an unhandled
 *  rejection, or worse, an error banner. */
test.each([
  ["a non-2xx status", () => respondWith({ message: "rate limit exceeded" }, false)],
  ["a body that is not an object", () => respondWith("not json")],
  ["a null body", () => respondWith(null)],
  ["a release with no tag_name", () => respondWith({ html_url: "https://example.invalid/r" })],
  ["a release with no html_url", () => respondWith({ tag_name: "v0.2.0" })],
  ["an empty tag_name", () => respondWith({ tag_name: "", html_url: "https://e.invalid/r" })],
  [
    "a tag that is not a version",
    () => respondWith({ tag_name: "nightly", html_url: "https://e.invalid/r" }),
  ],
  [
    "a network error",
    () => vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  ],
  [
    "malformed JSON",
    () =>
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        } as unknown as Response),
      ),
  ],
])("resolves to null and does not reject for %s", async (_label, build) => {
  globalThis.fetch = build();
  await expect(checkForUpdate()).resolves.toBeNull();
});

test("fetch is not defined at all — the case a webview without fetch would hit", async () => {
  // @ts-expect-error deliberately removing the global to prove the guard holds
  globalThis.fetch = undefined;
  await expect(checkForUpdate()).resolves.toBeNull();
});

/** The abort path: a request that never settles must not leave the caller
 *  hanging forever, and must still resolve to `null` rather than reject. */
test("a request that never settles is abandoned once the timeout elapses", async () => {
  globalThis.fetch = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  ) as unknown as typeof fetch;

  const pending = checkForUpdate();
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(pending).resolves.toBeNull();
});

/** The timer must be cleared on the success path too. A leaked timer keeps a
 *  fake-timer test suite pending and, in the app, holds a reference for five
 *  seconds after the work is done. */
test("the timeout is cleared once a response arrives", async () => {
  globalThis.fetch = respondWith({ tag_name: "v0.2.0", html_url: "https://e.invalid/r" });

  await checkForUpdate();

  expect(vi.getTimerCount()).toBe(0);
});
