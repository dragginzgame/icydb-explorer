import { elide } from "./elide";

test("leaves a short value untouched", () => {
  expect(elide("aaaaa-aa")).toBe("aaaaa-aa");
});

test("keeps the first and last two groups of a principal", () => {
  const principal = "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe";
  expect(elide(principal)).toBe("bg33z-ib5mx…acfnn-iqe");
});

/// Both ends must stay recognisable: two principals often share a prefix, and
/// canister ids differ in the middle, so a head-only elision would make
/// distinct ids look identical.
test("keeps both ends of a canister id", () => {
  expect(elide("jx2ua-6t777-77774-qaaeq-cai")).toBe("jx2ua-6t777…qaaeq-cai");
});

test("splits on characters when there are no groups to keep", () => {
  expect(elide("01KYVVPD156GJG000000000001")).toBe("01KYVVPD…0001");
});

test("never splits inside a group", () => {
  const elided = elide("bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe");
  for (const group of elided.replace("…", "-").split("-")) {
    expect(group.length).toBeGreaterThan(0);
  }
  expect(elided.startsWith("bg33z-ib5mx")).toBe(true);
  expect(elided.endsWith("acfnn-iqe")).toBe(true);
});

/// This replaces a test of the same name whose input was 23 characters — under
/// the default max of 24 — so it returned on the first line and passed even with
/// the `max` parameter deleted entirely. It asserted nothing about the bound.
///
/// The group-based branch ignored `max` outright, and these are the two
/// measured consequences.
test("never exceeds max on the group-based branch", () => {
  // Six long groups. The group form keeps four of them: 67 characters from a
  // max of 24.
  const long = "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cc-dd-eeeeeeeeeeeeeeee-ffffffffffffffff";
  const elided = elide(long, 24);
  expect(elided.length).toBeLessThanOrEqual(24);
  expect(elided.length).toBeLessThan(long.length);
});

/// The nastier half: not merely over the bound but not shortened *at all*, with
/// the `…` sitting exactly where a real `-` was — so it reads as "middle
/// omitted" when nothing was omitted. Zero reduction, actively misleading.
test("does not return an unshortened value dressed up as an elision", () => {
  const value = "aaaa-bbbb-cccc-dddddddddddddddddddddddddddd";
  expect(value).toHaveLength(43);

  const elided = elide(value, 24);
  expect(elided.length).toBeLessThanOrEqual(24);
  expect(elided).not.toBe(value);
  // An `…` in a string no shorter than its input is a lie about the content.
  expect(elided.replace("…", "-")).not.toBe(value);
});

/// The bound is a contract, not a hint: a caller sizing a column from the
/// returned length must be able to rely on it. Swept across separator shapes and
/// maxima rather than spot-checked, because the two branches fail at different
/// points.
test("output is never longer than max nor than the input, on any path", () => {
  const values = [
    "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe",
    "jx2ua-6t777-77774-qaaeq-cai",
    "01KYVVPD156GJG000000000001",
    "aaaa-bbbb-cccc-dddddddddddddddddddddddddddd",
    "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cc-dd-eeeeeeeeeeeeeeee-ffffffffffffffff",
    "no-dashes-here",
    "single",
    "a-b",
    "",
  ];

  for (const value of values) {
    for (const max of [1, 2, 3, 4, 5, 8, 12, 13, 21, 24, 40, 64, 200]) {
      const elided = elide(value, max);
      // Reported as an object so a failure names the offending pair rather than
      // just a number.
      expect({ value, max, tooLong: elided.length > max }).toMatchObject({ tooLong: false });
      expect(elided.length).toBeLessThanOrEqual(value.length);
    }
  }
});

/// The bound must not cost the group form when it genuinely fits: a principal
/// still has to elide to a recognisable first-second…secondlast-last.
test("keeps the group form when it fits inside max", () => {
  const principal = "bg33z-ib5mx-n4nvu-xkuul-36yop-un5vt-iivrl-uc22i-syrrd-acfnn-iqe";
  expect(elide(principal, 24)).toBe("bg33z-ib5mx…acfnn-iqe");
  // One character under what the group form needs: it must give way rather than
  // overshoot.
  expect(elide(principal, 20).length).toBeLessThanOrEqual(20);
  expect(elide(principal, 20)).not.toBe("bg33z-ib5mx…acfnn-iqe");
});

test("a max above the input length leaves the value untouched", () => {
  expect(elide("bg33z-ib5mx-n4nvu-xkuul", 100)).toBe("bg33z-ib5mx-n4nvu-xkuul");
  expect(elide("aaaa-bbbb-cccc-dddddddddddddddddddddddddddd", 100)).toBe(
    "aaaa-bbbb-cccc-dddddddddddddddddddddddddddd",
  );
});
