/**
 * Shortens a long identifier while keeping both ends recognisable.
 *
 * Both ends matter: principals frequently share a prefix and canister ids
 * differ in the middle, so a head-only elision would render distinct values
 * identically. Groups are never split — a partial group reads as a different
 * identifier rather than a shortened one.
 *
 * Dash-separated values with four or more groups (principals, canister ids)
 * keep their first and last two groups. Anything else — no separators at all
 * (ULIDs, hex digests), or too few groups to keep two from each end — falls
 * back to a character split. The full value is always available to the
 * caller, which is why `Identifier` puts it in `title` and copies it on click
 * — this function is for display only and is deliberately lossy.
 */
export function elide(value: string, max = 24): string {
  if (value.length <= max) return value;

  const groups = value.split("-");
  if (groups.length >= 4) {
    return `${groups[0]}-${groups[1]}…${groups[groups.length - 2]}-${groups[groups.length - 1]}`;
  }

  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
