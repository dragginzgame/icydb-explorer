/**
 * Shortens a long identifier while keeping both ends recognisable.
 *
 * Both ends matter: principals frequently share a prefix and canister ids
 * differ in the middle, so a head-only elision would render distinct values
 * identically. In the group-based form groups are never split — a partial group
 * reads as a different identifier rather than a shortened one.
 *
 * Dash-separated values with four or more groups (principals, canister ids)
 * keep their first and last two groups, *provided that form actually fits in
 * `max` and actually shortens the value*. Anything else — no separators at all
 * (ULIDs, hex digests), too few groups to keep two from each end, or a
 * group-based form that would not honour the bound — falls back to a character
 * split, which may land mid-group by design. The full value is always available
 * to the caller, which is why `Identifier` puts it in `title` and copies it on
 * click — this function is for display only and is deliberately lossy.
 *
 * Two invariants hold on every path, and they are the point of the bound:
 *
 *   result.length <= max   and   result.length <= value.length
 *
 * The second is not redundant. The group-based form is unbounded in the length
 * of the groups it keeps, so it could return *more* characters than it was
 * given — and worse, an unshortened value whose `…` sits where a real `-` was,
 * which reads as "middle omitted" when nothing was omitted at all. A caller
 * sizing a column from the returned length was being lied to.
 *
 * Known and accepted: two identifiers sharing a head and a tail elide to the
 * same string. Distinguishing them would defeat the purpose of eliding; the full
 * value in `title` is the answer.
 */
export function elide(value: string, max = 24): string {
  if (value.length <= max) return value;

  const groups = value.split("-");
  if (groups.length >= 4) {
    const grouped = `${groups[0]}-${groups[1]}…${groups[groups.length - 2]}-${groups[groups.length - 1]}`;
    if (grouped.length <= max && grouped.length < value.length) return grouped;
  }

  return characterSplit(value, max);
}

/** Head/tail split, sized to fit `max`. Reached only when `value` is longer than
 *  `max`, so the result is always a strict shortening. */
function characterSplit(value: string, max: number): string {
  // No room for a head, an ellipsis and a tail: a bare truncation is all that
  // honours the bound. Only reachable from a caller passing an absurd `max`.
  if (max < 3) return value.slice(0, Math.max(0, max));

  const budget = max - 1; // the ellipsis itself
  // The 4/8 preference is the shape a ULID has always elided to, kept exactly
  // when the budget allows it and scaled down proportionally when it does not.
  const tail = Math.min(4, Math.floor(budget / 3));
  const head = Math.min(8, budget - tail);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
