import type { ValueDto } from "../api/types";

// Numeric kinds get right-aligned, tabular-figure rendering so columns of
// numbers line up. Kept in sync with `OutputValue`'s numeric variants in
// `src-tauri/src/view/value.rs`.
const NUMERIC_KINDS = new Set([
  "int",
  "int128",
  "intbig",
  "nat",
  "nat128",
  "natbig",
  "float32",
  "float64",
  "decimal",
]);

// Identifier-shaped kinds get monospace rendering so runs of hex/base32
// characters stay visually aligned and distinguishable from prose.
const IDENTIFIER_KINDS = new Set(["principal", "ulid", "subaccount", "account", "blob"]);

export function ValueCell({ value }: { value: ValueDto }) {
  const { kind, display } = value;

  if (kind === "null") {
    return <div className="italic text-text-3">null</div>;
  }

  if (NUMERIC_KINDS.has(kind)) {
    return <div className="text-right tabular-nums">{display}</div>;
  }

  if (IDENTIFIER_KINDS.has(kind)) {
    return (
      <div className="font-mono text-xs truncate text-pk" title={display}>
        {display}
      </div>
    );
  }

  return (
    <div className="truncate" title={display}>
      {display}
    </div>
  );
}
