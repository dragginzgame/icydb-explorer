/**
 * Copies `text`, resolving `true` only if it actually landed.
 *
 * Two routes, because neither is sufficient alone. `navigator.clipboard`
 * requires a secure context and transient user activation, and its behaviour in
 * a Tauri webview varies by platform — Tauri ships a whole clipboard plugin
 * because of this. Rather than take that dependency for one feature, this falls
 * back to a hidden textarea plus the deprecated `execCommand("copy")`, which
 * works in every webview and needs nothing.
 *
 * Never throws. The caller shows a "Copied" confirmation, so a route that
 * silently failed must report `false` rather than let the UI lie.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present but refused — fall through to the textarea route below.
  }

  let area: HTMLTextAreaElement | undefined;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen rather than hidden: a `display: none` textarea cannot be
    // selected, so the copy would silently do nothing.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area?.remove();
  }
}
