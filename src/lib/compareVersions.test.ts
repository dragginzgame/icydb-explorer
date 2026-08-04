import { describe, expect, test } from "vitest";

import { isNewer, parseVersion } from "./compareVersions";

describe("parseVersion", () => {
  test("accepts a bare triple and a v-prefixed tag alike", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseVersion("  v0.1.0\n")).toEqual([0, 1, 0]);
  });

  test("discards a prerelease or build suffix", () => {
    expect(parseVersion("1.2.3-rc.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+build7")).toEqual([1, 2, 3]);
  });

  test("multi-digit components are read as numbers, not characters", () => {
    expect(parseVersion("v10.20.30")).toEqual([10, 20, 30]);
  });

  test.each([
    ["a two-part version", "1.2"],
    ["a four-part version", "1.2.3.4"],
    ["a non-numeric component", "1.x.3"],
    ["a name rather than a version", "latest"],
    ["an empty string", ""],
    ["a tag with a prefix other than v", "release-1.2.3"],
  ])("returns null for %s", (_label, input) => {
    expect(parseVersion(input)).toBeNull();
  });
});

describe("isNewer", () => {
  test.each([
    ["a patch bump", "0.1.1", "0.1.0"],
    ["a minor bump", "0.2.0", "0.1.9"],
    ["a major bump", "1.0.0", "0.99.99"],
    ["a v-prefixed tag against a bare version", "v0.2.0", "0.1.0"],
  ])("%s is newer", (_label, candidate, current) => {
    expect(isNewer(candidate, current)).toBe(true);
  });

  test.each([
    ["the same version", "0.1.0", "0.1.0"],
    ["an older patch", "0.1.0", "0.1.1"],
    ["an older minor", "0.1.9", "0.2.0"],
    ["an older major", "0.99.99", "1.0.0"],
  ])("%s is not newer", (_label, candidate, current) => {
    expect(isNewer(candidate, current)).toBe(false);
  });

  /** The case a string comparison gets wrong, and the reason this compares
   *  component-wise: "0.10.0" < "0.9.0" lexically, so a string-sorting
   *  implementation would go quiet exactly when a tenth minor release shipped. */
  test("orders a two-digit component above a one-digit one", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  /** Unparseable input must never produce a notification. A GitHub repo whose
   *  tags stop looking like versions should make this feature silent, not
   *  wrong. */
  test.each([
    ["the candidate is unparseable", "nightly", "0.1.0"],
    ["the current version is unparseable", "0.2.0", "unknown"],
    ["both are unparseable", "nightly", "unknown"],
  ])("returns false when %s", (_label, candidate, current) => {
    expect(isNewer(candidate, current)).toBe(false);
  });

  /** A suffixed tag is not an upgrade over the plain release of the same
   *  number, in either direction. */
  test("a prerelease of the running version is not an update", () => {
    expect(isNewer("0.1.0-rc.1", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.0-rc.1")).toBe(false);
  });
});
