import type { IdentityRef } from "../api/types";

/** A `<select>` listing every `icp` identity the resolved store declares,
 * usable or not — an unusable one is still shown (disabled, with its reason
 * appended to the label) rather than silently omitted, so it reads as
 * "unsupported" instead of "missing".
 *
 * `unusableReason` is read straight off the DTO: it's computed once by
 * `IdentityRef::new` in `src-tauri/src/discovery/types.rs` and rendered
 * verbatim here rather than re-derived from `kind` in TypeScript, so the
 * rule lives in exactly one place.
 *
 * `IdentityRef` carries no principal, so none is displayed here. */
export function IdentitySelector({
  identities,
  selected,
  onSelect,
}: {
  identities: IdentityRef[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (identities.length === 0) {
    return null;
  }

  return (
    <select
      value={selected ?? ""}
      onChange={(event) => onSelect(event.target.value)}
      className="rounded border px-2 py-1 text-sm"
    >
      {identities.map((identity) => {
        const label =
          identity.unusableReason === null
            ? `${identity.name} (${identity.kind})`
            : `${identity.name} (${identity.kind}) — ${identity.unusableReason}`;
        return (
          <option key={identity.name} value={identity.name} disabled={identity.unusableReason !== null}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
