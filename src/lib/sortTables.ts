import type { EntityDto } from "../api/types";
import type { RowCounts } from "../components/TableList";

/** What to order the table list by.
 *
 *  `declared` is icydb's own order, as `SHOW ENTITIES` returned it — the default,
 *  because it is the order the schema was written in and silently replacing it
 *  with something alphabetical would discard information the reader might be
 *  relying on.
 */
export type SortField = "declared" | "name" | "indexes" | "rows";
export type SortDirection = "asc" | "desc";

/** Orders the table list.
 *
 *  Stable throughout: `declared` order is the tiebreaker, so two tables with the
 *  same index count keep the order the schema gave them rather than shuffling
 *  between renders.
 *
 *  The one real decision here is what to do with a table whose rows have not been
 *  counted. Counting is a full scan and user-initiated, so most of the time most
 *  tables have no count — and "no count" is not a position on a numeric scale.
 *  Treating it as zero would sort uncounted tables in among genuinely empty ones
 *  and assert something nobody measured. So an uncounted table sorts *after* every
 *  counted one, in both directions, and keeps its declared order among the others.
 *  Reversing the direction reverses the counted tables; it does not promote the
 *  unknowns to the top.
 *
 *  A count that was attempted and failed (`null`) is unknown for the same reason
 *  and goes with them.
 */
export function sortEntities(
  entities: EntityDto[],
  counts: RowCounts | undefined,
  field: SortField,
  direction: SortDirection,
): EntityDto[] {
  if (field === "declared") {
    return direction === "asc" ? entities : [...entities].reverse();
  }

  const sign = direction === "asc" ? 1 : -1;

  // `Array.prototype.sort` is stable by specification (ES2019 onward), and the
  // copy below starts in declared order — so ties keep the order the schema gave
  // them without any tiebreaking here. An earlier version compared declared
  // positions explicitly; removing that changed no test, which is how it was
  // found to be doing nothing. Relying on the documented guarantee is both
  // shorter and the actual mechanism.
  return [...entities].sort((a, b) => {
    if (field === "name") {
      // `localeCompare` rather than `<`: entity names are identifiers today, but
      // comparing them by UTF-16 code unit would put `Z` before `a`, which reads
      // as a bug long before it is one.
      return sign * a.name.localeCompare(b.name);
    }

    if (field === "indexes") {
      return sign * (a.indexes - b.indexes);
    }

    const left = knownCount(counts, a.name);
    const right = knownCount(counts, b.name);
    // Unknown is not a value on this scale, so it never competes on it: it sorts
    // last whichever way the arrow points. Deliberately not multiplied by `sign`
    // — doing that uniformly would promote the unknowns to the top on `desc`,
    // which is the bug this shape exists to avoid.
    // Two unknowns are *equal*, not "a after b". Without this arm the next line
    // fires for both orderings of the same pair and the comparator becomes
    // inconsistent, which the spec leaves implementation-defined. No test here
    // distinguishes it — V8 tolerates the inconsistency for this data even at 30
    // elements, which was checked — so this is kept for correctness rather than
    // because a red test demanded it.
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;

    return sign * (left - right);
  });
}

/** A table's row count, or `null` when nobody knows it — uncounted and
 *  count-failed alike, because neither is a number to sort by. */
function knownCount(counts: RowCounts | undefined, name: string): number | null {
  if (!counts || !(name in counts)) return null;

  return counts[name];
}

/** How the control reads. `declared` is deliberately not called "none": it is a
 *  real order, not the absence of one. */
export const SORT_LABELS: Record<SortField, string> = {
  declared: "Schema order",
  name: "Name",
  indexes: "Indexes",
  rows: "Rows",
};
