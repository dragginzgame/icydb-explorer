import icydbGlyph from "../assets/icydb-glyph.svg";
import type { AppErrorDto } from "../api/types";

import { ErrorBanner } from "./ErrorBanner";
import { ProjectSelector } from "./ProjectSelector";

/** One thing that has to be true, and how to make it so. */
type Requirement = { needs: string; how: React.ReactNode };

/** What has to be true on the reader's own machine. Each of these they can fix. */
const LOCAL: Requirement[] = [
  {
    needs: "A project with an .icp/ directory",
    how: (
      <>
        Pick the project root, or any directory inside it — this walks up to find{" "}
        <code>.icp/</code>. Without one there is nothing to read: that directory is where
        canister ids and identities live.
      </>
    ),
  },
  {
    needs: "The project deployed at least once",
    how: (
      <>
        Canister ids come from <code>.icp/cache/mappings/&lt;network&gt;.ids.json</code>, which
        deploying writes. A project that has never been deployed has no environments to show.
      </>
    ),
  },
  {
    needs: "A usable identity",
    how: (
      <>
        Read from the project&apos;s own <code>.icp/cli-home/identity/</code> and from the
        user-level store. A <code>pem</code> or <code>keyring</code> identity works; the{" "}
        <code>anonymous</code> identity cannot, because icydb&apos;s SQL endpoints are
        controller-gated and it controls nothing.
      </>
    ),
  },
  {
    needs: "The replica running",
    how: (
      <>
        For a local environment, something has to be listening at the URL the project records.
        Start it the way the project normally does before opening this.
      </>
    ),
  },
];

/** What has to be true of the canisters. These the reader may not be able to fix
 *  themselves, which is exactly why they are listed apart — being told to check
 *  something you do not control is worse than being told who does. */
const CANISTER: Requirement[] = [
  {
    needs: "The icydb SQL surface compiled in",
    how: (
      <>
        A canister built with <code>BuildOptions::default()</code> has no{" "}
        <code>icydb_query</code> method at all, and nothing here can reach it. It needs{" "}
        <code>with_sql_readonly_enabled(true)</code>, and{" "}
        <code>with_sql_introspection_enabled(true)</code> for <code>SHOW</code> and{" "}
        <code>DESCRIBE</code> — plus the canister crate enabling its own <code>sql</code>{" "}
        feature, since Cargo does not forward a dependency&apos;s features to the crate that
        uses it.
      </>
    ),
  },
  {
    needs: "Your identity among the controllers",
    how: (
      <>
        <code>icydb_query</code> checks the caller is a controller, so a non-controller gets an
        error rather than rows. This offers whichever identity the project declares that the
        canisters actually accept, but if none of them is a controller no choice here fixes it.
      </>
    ),
  },
];

/** The first screen: no project open, or one that could not be read.
 *
 *  It exists because every failure before this point looked the same — a mostly
 *  empty window with one line of text — while the causes are entirely different
 *  and mostly not the app's. The requirements are split by who can act on them:
 *  four the reader owns, two the canister does. Being told to check something you
 *  have no control over, without being told that, is worse than not being told.
 */
export function Welcome({
  error,
  root,
  busy,
  onSelect,
}: {
  /** Why the chosen folder could not be read, if one was chosen and rejected. */
  error: AppErrorDto | null;
  /** The folder that was tried, so a rejection names what it was about. */
  root: string | null;
  busy: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-auto p-8">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3">
          <img src={icydbGlyph} alt="" aria-hidden="true" className="size-10 shrink-0" />
          <div>
            <h2 className="text-xl font-semibold text-text-1">icydb Explorer</h2>
            <p className="text-sm text-text-2">
              Browse the icydb databases inside a fleet of Internet Computer canisters.
              Read-only.
            </p>
          </div>
        </div>

        {/* The rejection first, before the requirements: the reader picked something
            and it did not work, so what happened to *their* choice outranks the
            general case. Rendered through `ErrorBanner` like every other failure,
            rather than reworded here — the backend's explanations are written to be
            read, and a second phrasing would be a second thing to keep true. */}
        {error && (
          <div className="mt-6">
            {root && (
              <p className="mb-2 text-xs text-text-3">
                Tried <code className="font-mono text-text-2">{root}</code>
              </p>
            )}
            <ErrorBanner error={error} />
          </div>
        )}

        <div className="mt-6 flex items-center gap-3">
          <ProjectSelector root={null} busy={busy} onSelect={onSelect} />
          {/* Keyed on whether a directory was actually *tried*, not on whether
              there is an error. An error can arrive without a pick — the
              mount-time load failing, say — and "Try a different directory" then
              advises against a choice the reader never made. Seen on screen before
              it was seen in a test. */}
          <span className="text-xs text-text-3">
            {root ? "Try a different directory." : "Nothing is read until you choose one."}
          </span>
        </div>

        <Group
          title="On your machine"
          note="Four things this app reads before it can show you anything."
          requirements={LOCAL}
        />
        <Group
          title="In the canisters"
          note="Build-time and deployment choices this app cannot change — if one of these is missing, the canister's owner is who can fix it."
          requirements={CANISTER}
        />
      </div>
    </div>
  );
}

function Group({
  title,
  note,
  requirements,
}: {
  title: string;
  note: string;
  requirements: Requirement[];
}) {
  return (
    <section className="mt-8">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">{title}</h3>
      <p className="mt-1 text-xs text-text-3">{note}</p>
      <dl className="mt-3 flex flex-col gap-3">
        {requirements.map((requirement) => (
          <div
            key={requirement.needs}
            className="rounded-control border border-rule bg-surface-1 p-3"
          >
            <dt className="text-sm font-semibold text-text-1">{requirement.needs}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-text-2">{requirement.how}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
