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

// ── Containers ───────────────────────────────────────────────────────────────
// The strings below are verbatim from toko's running replica.

/// The column that motivated this. Unhandled, a map fell through to the catch-all
/// and printed its whole nested structure — five lines in a pane a few characters
/// wide, restating a record whose fields are already rows beneath it.
test("a named map collapses to its key and value types", () => {
  const raw =
    "composite(path=ProjectMap, codec=structural_v1, shape=newtype<map<principal, " +
    "composite(path=Project, codec=structural_v1, shape=record{pid:principal, " +
    "status:enum(ProjectStatus)})>>)";

  expect(formatType(raw)).toEqual({
    name: "ProjectMap",
    shape: "map<principal → Project>",
    constraint: null,
    optional: false,
  });
});

/// A bare map keeps the compact form in its *name*, which is what lets a named
/// wrapper around it collapse — `composite` takes `inner.shape ?? inner.name`, so
/// a shape here would be discarded and the reader would see only `ProjectMap`.
test("a bare map reads as its key and value", () => {
  expect(formatType("map<principal, ulid>").name).toBe("map<principal → ulid>");
});

/// A map's value is routinely a composite full of its own commas, so the split has
/// to happen at the top level only — otherwise `principal, composite(path=P,
/// codec=…)` becomes three parts and the value type is `composite(path=P`.
test("a map with a comma-laden value type still splits into two", () => {
  const raw = "map<ulid, composite(path=Project, codec=structural_v1, shape=record{a:bool})>";

  expect(formatType(raw).name).toBe("map<ulid → Project>");
});

/// The same wall for the same reason: toko's `User.pins` printed its whole record.
test("a list of composites reads as a list of their name", () => {
  const raw =
    "list<composite(path=Pin, codec=structural_v1, shape=record{collection_id:ulid?, " +
    "is_hidden:bool, project_pid:principal})>";

  expect(formatType(raw).name).toBe("list<Pin>");
});

test("a set behaves like a list", () => {
  expect(formatType("set<ulid>").name).toBe("set<ulid>");
});

/// Already short, and must stay exactly as it was — this branch is for collapsing
/// walls, not for rewriting what already reads well.
test("a list of a scalar is unchanged", () => {
  expect(formatType("list<principal>").name).toBe("list<principal>");
});

/// A container nests: a list of maps keeps both levels compact rather than
/// collapsing one and dumping the other.
test("nested containers stay compact at every level", () => {
  expect(formatType("list<map<ulid, principal>>").name).toBe("list<map<ulid → principal>>");
});

/// A trailing `?` is read off before the container is, so an optional map is still
/// recognised as one.
test("an optional container is still collapsed", () => {
  const formatted = formatType("map<ulid, principal>?");

  expect(formatted.name).toBe("map<ulid → principal>");
  expect(formatted.optional).toBe(true);
});
