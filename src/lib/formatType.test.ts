import { formatType } from "./formatType";

/// Every string below was read off toko's live `User` table, not invented.

test("a scalar is left alone", () => {
  expect(formatType("ulid")).toEqual({
    name: "ulid",
    shape: null,
    constraint: null,
    optional: false,
  });
});

test("an optional scalar is marked, not decorated", () => {
  const formatted = formatType("principal?");

  expect(formatted.name).toBe("principal");
  expect(formatted.optional).toBe(true);
});

test("an enum reads as its own name", () => {
  expect(formatType("enum(Authority)")).toEqual({
    name: "Authority",
    shape: "enum",
    constraint: null,
    optional: false,
  });
});

/// `text(unbounded)` says less than `text` — the parenthesis draws the eye to
/// the absence of a limit, which is the default anyway.
test("unbounded is silence, not a note", () => {
  expect(formatType("text(unbounded)")).toEqual({
    name: "text",
    shape: null,
    constraint: null,
    optional: false,
  });
});

test("a length bound is a readable count", () => {
  expect(formatType("text(max_len=1500)").constraint).toBe("max 1,500");
});

/// A blob's limit is a size and reads better as one: 30000 as `30 kB` is the
/// difference between a number and a quantity a reader can judge.
test("a blob bound is a size", () => {
  expect(formatType("blob(max_len=30000)").constraint).toBe("max 30 kB");
});

/// The case that made this necessary. A newtype over a scalar collapses to the
/// name the reader knows plus what it really is.
test("a named newtype collapses to name and underlying type", () => {
  const formatted = formatType(
    "composite(path=TextName, codec=structural_v1, shape=newtype<text(max_len=50)>)",
  );

  expect(formatted.name).toBe("TextName");
  expect(formatted.shape).toBe("text");
  expect(formatted.constraint).toBe("max 50");
});

test("optionality survives the wrapper", () => {
  const formatted = formatType(
    "composite(path=TextDescription, codec=structural_v1, shape=newtype<text(max_len=1500)>)?",
  );

  expect(formatted.name).toBe("TextDescription");
  expect(formatted.optional).toBe(true);
  expect(formatted.constraint).toBe("max 1,500");
});

/// The twenty-line column. Its fields are already listed as nested rows below,
/// so the only news here is that it is a record and how many fields it has.
test("the composite that motivated all of this becomes one line", () => {
  const raw =
    "composite(path=Profile, codec=structural_v1, shape=record{" +
    "description:composite(path=TextDescription, codec=structural_v1, shape=newtype<text(max_len=1500)>)?, " +
    "name:composite(path=TextName, codec=structural_v1, shape=newtype<text(max_len=50)>)?, " +
    "pic:composite(path=Thumbnail, codec=structural_v1, shape=record{bytes:blob(max_len=30000), " +
    "mime_type:composite(path=AssetMimeType, codec=structural_v1, shape=newtype<text(max_len=64)>)})?, " +
    "socials:composite(path=Socials, codec=structural_v1, shape=record{bluesky:text(unbounded)?}), " +
    "url:composite(path=Url, codec=structural_v1, shape=newtype<text(unbounded)>)?})";

  const formatted = formatType(raw);

  expect(formatted.name).toBe("Profile");
  expect(formatted.shape).toBe("5 fields");
  // Nothing of the wall survives.
  expect(formatted.shape).not.toMatch(/codec|structural_v1|composite/);
});

/// Commas inside a nested record are not field separators. Counting them as
/// such would report a wrong number confidently, which is worse than the wall.
test("nested commas do not inflate the field count", () => {
  const raw = "record{a:record{x:text(unbounded), y:text(unbounded)}, b:ulid}";

  expect(formatType(raw).shape).toBe("2 fields");
});

test("an empty record has no fields", () => {
  expect(formatType("record{}").shape).toBe("0 fields");
});

/// icydb's format is its own and will change. Anything unrecognised passes
/// through — worse-looking than before, never wrong.
test("an unrecognised shape passes through unchanged", () => {
  expect(formatType("some_future_kind(with=stuff)")).toEqual({
    name: "some_future_kind(with=stuff)",
    shape: null,
    constraint: null,
    optional: false,
  });
});
