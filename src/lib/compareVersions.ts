/** Decides whether a published release is newer than the running build.
 *
 *  Deliberately not a semver library. The only versions ever compared here are
 *  this app's own tags, which are plain `MAJOR.MINOR.PATCH`, and the cost of
 *  being wrong is lopsided: advertising an update that does not exist, or
 *  nagging someone to "upgrade" to an older build, is worse than staying quiet.
 *  So every uncertain case resolves to "no update", never to a guess.
 */

/** A parsed `MAJOR.MINOR.PATCH`. */
export type Version = [number, number, number];

/** Parses `v1.2.3`, `1.2.3`, or `1.2.3-rc.1` into its numeric parts.
 *
 *  `null` for anything else — including a two-part `1.2`, which this app does
 *  not publish and where supplying a `0` patch would invent an ordering rather
 *  than read one.
 *
 *  A prerelease or build suffix is matched but discarded, so `1.2.3-rc.1` and
 *  `1.2.3` compare equal and neither is offered as an upgrade over the other.
 *  That is the conservative reading, and it costs nothing in practice:
 *  GitHub's `releases/latest` omits prereleases entirely, so a suffixed tag
 *  should never reach this function through the update check. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a strictly higher version than `current`.
 *
 *  Component-wise, most significant first — not a string or numeric comparison
 *  of the whole thing, both of which order `0.10.0` below `0.9.0`. */
export function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (left === null || right === null) return false;

  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}
