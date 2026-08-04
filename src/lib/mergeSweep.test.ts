import { expect, test } from "vitest";

import type { SweepOutcomeDto } from "../api/types";
import { ORIGIN_COLUMN, mergeSweep, summarise } from "./mergeSweep";

const label = (canister: string) => ({ "aaa": "shard_1", "bbb": "shard_2", "ccc": "shard_3" })[canister] ?? canister;

const page = (canister: string, ...names: string[]): SweepOutcomeDto => ({
  canister,
  result: {
    type: "rows",
    entity: "User",
    columns: ["id", "handle"],
    rows: names.map((name) => [
      { kind: "ulid", display: `id-${name}` },
      { kind: "text", display: name },
    ]),
    rowCount: names.length,
    nextCursor: null,
  },
  error: null,
});

const refused = (canister: string, explanation = "not a controller"): SweepOutcomeDto => ({
  canister,
  result: null,
  error: { kind: "notController", explanation },
});

test("rows from every canister land in one grid, each tagged with its origin", () => {
  const merged = mergeSweep([page("aaa", "juno"), page("bbb", "remco", "kit")], label);

  expect(merged.rows?.columns).toEqual([ORIGIN_COLUMN, "id", "handle"]);
  expect(merged.rows?.rows).toHaveLength(3);
  expect(merged.rows?.rows.map((row) => row[0].display)).toEqual([
    "shard_1",
    "shard_2",
    "shard_2",
  ]);
  // The origin column is prepended, so the table's own data keeps its order.
  expect(merged.rows?.rows[0].map((cell) => cell.display)).toEqual(["shard_1", "id-juno", "juno"]);
});

/// The origin column has to be distinguishable from a real one: an entity is free
/// to have a field called `canister`.
test("the origin column is marked as the explorer's own", () => {
  const merged = mergeSweep([page("aaa", "juno")], label);

  expect(merged.rows?.columns[0]).toBe("_canister");
  expect(merged.rows?.columns[0].startsWith("_")).toBe(true);
});

/// The single most misleading thing a fan-out can do is present a refusal as an
/// empty result — a partly-authorised sweep would then read as a definitive
/// "not found".
test("a canister that could not answer is not counted as empty", () => {
  const merged = mergeSweep([page("aaa", "juno"), refused("bbb")], label);

  const states = merged.statuses.map((status) => status.state);
  expect(states).toEqual(["rows", "refused"]);
  expect(merged.statuses[1].rowCount).toBe(0);
  // And it is not the same state as a canister that answered with nothing.
  expect(merged.statuses[1].state).not.toBe("empty");
});

/// Answering with no rows is a real answer and must read differently from being
/// unable to answer.
test("answering with no rows is its own state", () => {
  const merged = mergeSweep([page("aaa"), refused("bbb")], label);

  expect(merged.statuses[0].state).toBe("empty");
  expect(merged.statuses[1].state).toBe("refused");
});

/// One failure must never void the answers that did arrive.
test("one refusal does not discard the rest of the sweep", () => {
  const merged = mergeSweep([refused("aaa"), page("bbb", "remco"), refused("ccc")], label);

  expect(merged.rows?.rows).toHaveLength(1);
  expect(merged.rows?.rows[0][0].display).toBe("shard_2");
});

/// "Nobody could look" must not render as "there is nothing there" — the same
/// `RowsDto | null` distinction the rest of the app carries.
test("a sweep where nothing answered has no grid at all", () => {
  const merged = mergeSweep([refused("aaa"), refused("bbb")], label);

  expect(merged.rows).toBeNull();
  expect(merged.statuses.every((status) => status.state === "refused")).toBe(true);
});

/// The error is carried through, because a reader needs to know *why* — a
/// controller-gated endpoint and a stopped canister need different responses.
test("a refusal carries its reason", () => {
  const merged = mergeSweep([refused("aaa", "the replica refused the call")], label);

  expect(merged.statuses[0].error?.explanation).toBe("the replica refused the call");
});

/// Fleet order, not a global sort. Each canister ordered its own page, so
/// re-sorting here would order only what was fetched — not the same thing, and
/// not something to present as if it were.
test("rows keep fleet order and are never re-sorted", () => {
  const merged = mergeSweep([page("bbb", "zoe"), page("aaa", "adam")], label);

  // `zoe` precedes `adam` because shard_2 was asked first, which is what fleet
  // order means. A global sort would have put `adam` first.
  expect(merged.rows?.rows.map((row) => row[2].display)).toEqual(["zoe", "adam"]);
});

/// Pool members share a schema, so disagreeing columns mean something is wrong.
/// Worth seeing rather than force-fitting into the first shape that arrived.
test("a canister whose columns disagree is reported rather than merged", () => {
  const odd: SweepOutcomeDto = {
    canister: "bbb",
    result: {
      type: "rows",
      entity: "User",
      columns: ["id", "handle", "extra"],
      rows: [
        [
          { kind: "ulid", display: "x" },
          { kind: "text", display: "y" },
          { kind: "text", display: "z" },
        ],
      ],
      rowCount: 1,
      nextCursor: null,
    },
    error: null,
  };
  const merged = mergeSweep([page("aaa", "juno"), odd], label);

  expect(merged.rows?.rows).toHaveLength(1);
  expect(merged.statuses[1].state).toBe("other");
});

/// A result that is not a row page has no single grid to belong in.
test("a non-rows result is reported rather than merged", () => {
  const schema: SweepOutcomeDto = {
    canister: "bbb",
    result: { type: "count", entity: "User", rowCount: 4 },
    error: null,
  };
  const merged = mergeSweep([page("aaa", "juno"), schema], label);

  expect(merged.statuses[1].state).toBe("other");
  expect(merged.rows?.rows).toHaveLength(1);
});

/// "12 rows" alone invites the reader to believe that is all of them, which it is
/// not when a member of the pool refused.
test("the summary names how many canisters answered, not just how many rows", () => {
  const merged = mergeSweep([page("aaa", "a"), page("bbb", "b"), refused("ccc")], label);

  const text = summarise(merged.statuses);
  expect(text).toContain("2 rows");
  expect(text).toContain("2 of 3 canisters");
  expect(text).toContain("1 could not be read");
});

test("a fully-answered sweep says so without a caveat", () => {
  const merged = mergeSweep([page("aaa", "a"), page("bbb", "b")], label);

  const text = summarise(merged.statuses);
  expect(text).toBe("2 rows from 2 of 2 canisters");
  expect(text).not.toContain("could not");
});

test("one row reads as a row rather than rows", () => {
  const merged = mergeSweep([page("aaa", "only")], label);

  expect(summarise(merged.statuses)).toBe("1 row from 1 of 1 canister");
});
