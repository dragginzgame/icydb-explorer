import { open } from "@tauri-apps/plugin-dialog";

type Props = {
  /** The open project's absolute root, or null if none is open. */
  root: string | null;
  /** True while a switch is in flight, so a second dialog can't be opened. */
  busy: boolean;
  onSelect: (path: string) => void;
};

/** The last path segment — what the user actually recognises. The full path
 * stays available as the button's title. */
function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Opens a native folder dialog and hands the chosen path to `onSelect`.
 *
 * The dialog lives here rather than in Rust so `select_project` stays a
 * plain "adopt this path" command with no dialog in its test path.
 *
 * Cancelling is a no-op by design: `open` resolves to `null` and nothing is
 * called, nothing changes, and no error is shown. A cancelled dialog is not
 * a failure. */
export function ProjectSelector({ root, busy, onSelect }: Props) {
  const choose = () => {
    void open({ directory: true, multiple: false }).then((picked) => {
      if (typeof picked === "string") {
        onSelect(picked);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={choose}
      disabled={busy}
      title={root ?? undefined}
      className="rounded border px-2 py-1 text-sm disabled:opacity-50"
    >
      {root ? `📁 ${basename(root)}` : "Choose a project…"}
    </button>
  );
}
