import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import type { AvailableUpdate } from "../api/update";

/** Which version's notice has been waved away.
 *
 *  The dismissed *version* rather than a boolean, so waving away 0.2.0 does not
 *  also silence 0.3.0. A boolean would turn one dismissal into a permanent
 *  opt-out that nobody chose and no setting could undo. */
const DISMISSED_KEY = "icydb.update.dismissed";

/** `localStorage` access, wrapped.
 *
 *  Reading it can throw outright — a webview with storage disabled, a privacy
 *  mode, a quota error on write. None of that is worth breaking the app's first
 *  paint over, so a failure here means "nothing was dismissed" and, on the write
 *  side, "this dismissal will not be remembered". The notice reappearing next
 *  launch is a far better failure than a blank window. */
function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Deliberately empty: see `readDismissed`.
  }
}

/** A quiet notice that a newer release exists.
 *
 *  It does not download, install, or replace anything — it says a version exists
 *  and offers to open its release page. That is the whole feature, and the
 *  restraint is deliberate: this app reads private keys out of the local identity
 *  store, so a code path that could silently replace its own binary would be a
 *  channel for pushing key-reading code to every install. A person reading a
 *  changelog before choosing to download is the control that replaces it.
 *
 *  Rendered `null` when there is nothing to say, which is the overwhelmingly
 *  common case — up to date, offline, or already dismissed. */
export function UpdateBar({ update }: { update: AvailableUpdate | null }) {
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());

  if (update === null) return null;
  if (dismissed === update.version) return null;

  return (
    <div
      // `status`, not `alert`: an available update is information, and `alert`
      // interrupts a screen-reader user mid-sentence for something that can wait.
      role="status"
      className="flex items-center gap-3 border-b border-rule bg-surface-1 px-4 py-2 text-xs"
    >
      <span className="text-text-2">
        Version <span className="font-semibold text-text-1">{update.version}</span> is available.
        You have {update.current}.
      </span>

      <button
        type="button"
        // No `void` on a floating promise here: `openUrl` rejects when the
        // capability scope denies the URL, and swallowing that would hide a
        // misconfigured scope behind a button that silently does nothing — the
        // exact failure `dialog:allow-save` produced. A rejection reaches the
        // console instead.
        onClick={() => {
          openUrl(update.url).catch((reason: unknown) => {
            console.error("could not open the release page", reason);
          });
        }}
        className="rounded-row text-accent hover:underline"
      >
        View release ↗
      </button>

      <button
        type="button"
        onClick={() => {
          setDismissed(update.version);
          writeDismissed(update.version);
        }}
        aria-label={`Dismiss the notice about version ${update.version}`}
        className="ml-auto shrink-0 rounded-row px-1 text-text-3 hover:text-text-1"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
