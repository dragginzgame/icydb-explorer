import { getVersion } from "@tauri-apps/api/app";

import { isNewer } from "../lib/compareVersions";

/** Where published releases are announced.
 *
 *  `releases/latest` rather than `releases`: GitHub's "latest" endpoint omits
 *  both drafts and prereleases. That is exactly the behaviour wanted here, and
 *  it is load-bearing rather than incidental — this project's release workflow
 *  creates every release as a *draft*, so an unpublished, unreviewed build is
 *  invisible to this check until a person publishes it. Listing all releases
 *  and taking the first would advertise builds nobody had looked at yet. */
const LATEST_RELEASE =
  "https://api.github.com/repos/dragginzgame/icydb-explorer/releases/latest";

/** Long enough for a slow connection, short enough that a black-holed request
 *  cannot leave a check pending for the life of the session. Nothing waits on
 *  this — the app is fully usable while it is outstanding — so the only cost of
 *  the timeout expiring is that no bar appears. */
const TIMEOUT_MS = 5_000;

/** A published release newer than the running build. */
export type AvailableUpdate = {
  /** The release's version, without the tag's `v`. */
  version: string;
  /** The version currently running, so the bar can state both. "0.2.0 is
   *  available" alone leaves the reader to remember what they have. */
  current: string;
  /** Its page on GitHub, for a person to read before downloading anything. */
  url: string;
};

/** Reads `tag_name` and `html_url` off a release response.
 *
 *  Written against `unknown` and checking both fields, because this is parsing a
 *  response from a remote service: a shape change, an error document, or an HTML
 *  error page served with a JSON content type all arrive here, and none of them
 *  should throw. */
function releaseFields(body: unknown): { tag: string; url: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const { tag_name: tag, html_url: url } = record;
  if (typeof tag !== "string" || typeof url !== "string") return null;
  if (tag === "" || url === "") return null;
  return { tag, url };
}

/** Asks GitHub whether a newer release has been published.
 *
 *  Resolves to `null` for every non-answer — offline, rate-limited, a shape this
 *  does not recognise, a timeout, or simply being up to date — and never
 *  rejects. That total quiet is the point: a failed update check is not a
 *  problem the person using this app has to solve, and surfacing it would put an
 *  error in front of someone whose only crime was opening a laptop on a train.
 *  It is also why this deliberately does not go through `AppError` like every
 *  other fallible call in the app.
 *
 *  One consequence worth naming: this is the app's only outbound request to a
 *  host the user did not choose. Everything else talks to the IC replica their
 *  own project configuration names. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  // A manual controller rather than `AbortSignal.timeout`, whose static-method
  // typing is not in this project's ES2020 lib.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const fields = releaseFields(await response.json());
    if (fields === null) return null;

    const current = await getVersion();
    if (!isNewer(fields.tag, current)) return null;

    return { version: fields.tag.replace(/^v/, ""), current, url: fields.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
