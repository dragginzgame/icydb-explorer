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

test("respects an explicit max", () => {
  expect(elide("bg33z-ib5mx-n4nvu-xkuul", 100)).toBe("bg33z-ib5mx-n4nvu-xkuul");
});
