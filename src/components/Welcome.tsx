import icydbGlyph from "../assets/icydb-glyph.svg";
import type { AppErrorDto } from "../api/types";

import { CopyButton } from "./CopyButton";
import { ErrorBanner } from "./ErrorBanner";
import { ProjectSelector } from "./ProjectSelector";

/** The icydb this explorer is built against.
 *
 *  Pinned exactly in the workspace `Cargo.toml`, and asserted equal to it by
 *  `Welcome.test.tsx` — a version printed here that has drifted from the one the
 *  binary actually links is worse than none, because a reader would act on it. */
export const ICYDB_VERSION = "0.215.7";

/** The edits that turn the SQL surface on, verbatim from the change that made a
 *  real fleet readable.
 *
 *  Two blocks and two copy buttons, because they are two files: one pasted into the
 *  other does nothing, and a single block invites copying the whole thing into
 *  whichever file is open. Both are needed — the build options alone leave the
 *  generated glue behind a `#[cfg]` that is off, and the feature alone leaves
 *  nothing for it to compile. */
const BUILD_RS = `icydb_model::build_with_options!(
    "<your>::schema::path::Canister",
    icydb_model::build::BuildOptions::default()
        .with_sql_readonly_enabled(true)
        .with_sql_introspection_enabled(true)
);`;

const CARGO_TOML = `[features]
default = ["sql"]
sql = ["icydb/sql-explain"]`;

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
        deploying writes — for example <code>icp network start</code>,{" "}
        <code>icp canister create</code>, <code>icp canister install</code>. A project that has
        never been deployed has no environments to show.
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

/** The one requirement that is not about configuration at all. */
const FOUNDATION: Requirement[] = [
  {
    needs: "The canister actually uses icydb",
    how: (
      <>
        This reads icydb&apos;s own SQL endpoint and nothing else — it is not a generic
        canister browser, and there is no fallback for a canister that stores its state some
        other way. Built against icydb <code>{ICYDB_VERSION}</code>, pinned exactly. Responses
        are decoded structurally, so a nearby version often works; one that changed a response
        shape will not, and it will say so rather than show you the wrong thing.
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
        <Snippet />
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
  triedRoot,
  projectRoot = null,
  undeployed = false,
  busy,
  onSelect,
}: {
  /** Why the chosen folder could not be read, if one was chosen and rejected. */
  error: AppErrorDto | null;
  /** A directory that was picked and rejected. Drives both "Tried X" and the
   *  advice to try another — neither of which is true of a directory nobody
   *  picked, which is why this is not the same prop as `projectRoot`. */
  triedRoot: string | null;
  /** The adopted project's own root, when one opened. Used by the undeployed note,
   *  where the path is context rather than a complaint. Passing one prop for both
   *  meanings made the undeployed case either nameless or falsely accused of being
   *  the wrong directory. */
  projectRoot?: string | null;
  /** The project read fine and has nothing deployed. Its own situation, not a
   *  wrong directory, and worth saying — otherwise the reader is left to work out
   *  which of six cards applies to them. */
  undeployed?: boolean;
  busy: boolean;
  onSelect: (path: string) => void;
}) {
  // A block scroll container centring with `mx-auto`, not a flex one with
  // `justify-center`. As a flex container this stretched its single child to the
  // container's height — 851px against 1600px of content — so the cards overflowed
  // the child's box and its `padding-bottom` sat 800px above where they ended,
  // doing nothing at all. Two attempts at "add some padding" failed for that
  // reason before measuring found it. In normal flow the child's height is its
  // content, so the padding is part of the scrollable overflow.
  return (
    <div className="min-h-0 flex-1 overflow-auto p-8">
      <div className="mx-auto w-full max-w-2xl pb-8">
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
        {undeployed && !error && (
          <p className="mt-6 rounded-control border border-warn-border bg-warn-bg p-3 text-sm text-warn-text">
            This project has an <code>.icp/</code> layout but no deployed environments
            {projectRoot ? (
              <>
                {" at "}
                <code className="font-mono">{projectRoot}</code>
              </>
            ) : null}
            . Deploy it and refresh.
          </p>
        )}

        {error && (
          <div className="mt-6">
            {triedRoot && (
              <p className="mb-2 text-xs text-text-3">
                Tried <code className="font-mono text-text-2">{triedRoot}</code>
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
            {triedRoot
              ? "Try a different directory."
              : "Nothing is read until you choose one."}
          </span>
        </div>

        <Group
          title="Before anything else"
          note="The hard requirement. Nothing below matters without it."
          requirements={FOUNDATION}
        />
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

/** The edits to make, to copy.
 *
 *  Not applied for you, and the reason is worth stating rather than leaving as an
 *  omission: enabling this means editing a source tree and then *upgrading a
 *  canister*, which is an update call. This app makes none — `read_only_shape.rs`
 *  asserts there is no agent update call anywhere in it — and that is what makes it
 *  safe to point at a production fleet without thinking about it. Doing the edit for
 *  you would trade that guarantee for a convenience.
 *
 *  So: the exact lines, one click away, and you run the build.
 */
function Snippet() {
  return (
    <span className="mt-3 flex flex-col gap-3">
      <Block file="build.rs" code={BUILD_RS} />
      <Block
        file="Cargo.toml"
        note="the canister crate's own features, not icydb's"
        code={CARGO_TOML}
      />
    </span>
  );
}

/** One file's worth of change, named and separately copyable. */
function Block({ file, note, code }: { file: string; note?: string; code: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-baseline gap-2">
        <code className="font-mono text-xs font-semibold text-text-1">{file}</code>
        {note && <span className="text-xs text-text-3">— {note}</span>}
        <CopyButton
          value={code}
          label={`Copy the ${file} change`}
          className="ml-auto px-1 py-0.5"
        />
      </span>
      <pre className="overflow-x-auto rounded-control border border-rule bg-surface-0 p-2 font-mono text-xs leading-relaxed text-text-2">
        {code}
      </pre>
    </span>
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
