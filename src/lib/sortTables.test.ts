import { expect, test } from "vitest";

import type { EntityDto } from "../api/types";
import { sortEntities } from "./sortTables";

const entity = (name: string, indexes: number): EntityDto => ({
  name,
  storePath: "",
  storage: "stable",
  columns: 4,
  indexes,
  relations: 0,
  schemaVersion: 1,
});

/** Deliberately not alphabetical, so "declared order" is distinguishable from
 *  "name order" — a fixture already in name order would let either implementation
 *  pass every test. */
const entities = [
  entity("UserProjects", 0),
  entity("Address", 1),
  entity("User", 2),
  entity("UserFriends", 0),
];

const names = (list: EntityDto[]) => list.map((e) => e.name);
// This project targets ES2020, which has no `Array.prototype.at`.
const last = (list: string[]) => list[list.length - 1];

/// The default, because it is the order the schema was written in and silently
/// replacing it with something alphabetical would discard information.
test("schema order is the entities exactly as they arrived", () => {
  expect(names(sortEntities(entities, undefined, "declared", "asc"))).toEqual([
    "UserProjects",
    "Address",
    "User",
    "UserFriends",
  ]);
});

test("schema order reversed is the reverse", () => {
  expect(names(sortEntities(entities, undefined, "declared", "desc"))).toEqual([
    "UserFriends",
    "User",
    "Address",
    "UserProjects",
  ]);
});

test("sorting by name, both ways", () => {
  expect(names(sortEntities(entities, undefined, "name", "asc"))).toEqual([
    "Address",
    "User",
    "UserFriends",
    "UserProjects",
  ]);
  expect(names(sortEntities(entities, undefined, "name", "desc"))).toEqual([
    "UserProjects",
    "UserFriends",
    "User",
    "Address",
  ]);
});

/// Comparing identifiers by UTF-16 code unit puts `Z` before `a`, which reads as a
/// bug long before it is one.
test("name order is not case-sensitive code-unit order", () => {
  const mixed = [entity("Zebra", 0), entity("apple", 0)];

  expect(names(sortEntities(mixed, undefined, "name", "asc"))).toEqual(["apple", "Zebra"]);
});

test("sorting by index count, both ways", () => {
  expect(names(sortEntities(entities, undefined, "indexes", "asc"))).toEqual([
    "UserProjects",
    "UserFriends",
    "Address",
    "User",
  ]);
  expect(names(sortEntities(entities, undefined, "indexes", "desc"))).toEqual([
    "User",
    "Address",
    "UserProjects",
    "UserFriends",
  ]);
});

/// Two tables with the same count keep the order the schema gave them, rather than
/// shuffling between renders.
test("ties keep schema order, in both directions", () => {
  const ascending = sortEntities(entities, undefined, "indexes", "asc");
  // `UserProjects` and `UserFriends` both have 0 indexes and appear in that order
  // in the schema.
  expect(names(ascending).slice(0, 2)).toEqual(["UserProjects", "UserFriends"]);

  const descending = sortEntities(entities, undefined, "indexes", "desc");
  expect(names(descending).slice(2)).toEqual(["UserProjects", "UserFriends"]);
});

const counts = { User: 3, Address: 120, UserFriends: 0 };

test("sorting by row count, both ways", () => {
  expect(names(sortEntities(entities, counts, "rows", "asc")).slice(0, 3)).toEqual([
    "UserFriends",
    "User",
    "Address",
  ]);
  expect(names(sortEntities(entities, counts, "rows", "desc")).slice(0, 3)).toEqual([
    "Address",
    "User",
    "UserFriends",
  ]);
});

/// The real decision in this file. Counting is a full scan and user-initiated, so
/// most tables usually have no count — and "no count" is not a position on a
/// numeric scale. Treating it as zero would sort uncounted tables in among
/// genuinely empty ones and assert something nobody measured.
test("an uncounted table sorts last, whichever way the arrow points", () => {
  // `UserProjects` has no count.
  expect(last(names(sortEntities(entities, counts, "rows", "asc")))).toBe("UserProjects");
  expect(last(names(sortEntities(entities, counts, "rows", "desc")))).toBe("UserProjects");
});

/// A count that was attempted and failed is unknown for the same reason, and must
/// not be read as zero either.
test("a failed count is unknown, not zero", () => {
  const withFailure = { ...counts, UserProjects: null };

  const ascending = names(sortEntities(entities, withFailure, "rows", "asc"));
  expect(last(ascending)).toBe("UserProjects");
  // Specifically not first, which is where a zero would have put it.
  expect(ascending[0]).toBe("UserFriends");
});

test("several uncounted tables keep schema order among themselves", () => {
  const onlyOne = { User: 5 };

  expect(names(sortEntities(entities, onlyOne, "rows", "asc"))).toEqual([
    "User",
    "UserProjects",
    "Address",
    "UserFriends",
  ]);
});

/// With nothing counted there is nothing to order by, so the list must not
/// scramble — it stays as the schema declared it.
test("with no counts at all the order is unchanged", () => {
  expect(names(sortEntities(entities, undefined, "rows", "asc"))).toEqual(names(entities));
  expect(names(sortEntities(entities, {}, "rows", "desc"))).toEqual(names(entities));
});

/// Sorting must not mutate what it was given: the caller holds the entity list
/// that came from `SHOW ENTITIES`, and reordering it in place would make "schema
/// order" mean whatever was sorted last.
test("the input list is left alone", () => {
  const original = names(entities);
  sortEntities(entities, counts, "rows", "desc");
  sortEntities(entities, undefined, "name", "asc");

  expect(names(entities)).toEqual(original);
});

test("an empty list sorts to an empty list", () => {
  expect(sortEntities([], undefined, "name", "asc")).toEqual([]);
});

/// Order preservation at a size that reaches V8's other sort algorithm (it
/// switches above 22 elements), since a small list exercises only insertion sort.
///
/// Written to try to pin the both-unknown arm of the comparator and does not —
/// removing that arm leaves this green, because V8 tolerates the resulting
/// inconsistency for this data. Kept anyway: "unknowns keep declared order" is
/// real behaviour worth a test at scale, whichever line implements it.
test("many uncounted tables keep schema order among themselves", () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    entity(`Table${String(index).padStart(2, "0")}`, 0),
  );
  // One counted table, so the unknown branch is the one doing the work.
  const sorted = sortEntities(many, { Table15: 7 }, "rows", "asc");

  expect(names(sorted)[0]).toBe("Table15");
  // Every other table is unknown, and they keep the order they were declared in.
  expect(names(sorted).slice(1)).toEqual(
    names(many).filter((name) => name !== "Table15"),
  );
});
