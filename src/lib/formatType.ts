/** A type broken into the parts worth showing separately. */
export type FormattedType = {
  /** The name a reader would call this: `text`, `ulid`, `Profile`, `Authority`. */
  name: string;
  /** The shape behind a named wrapper — `record`, `newtype`, `enum` — or null
   *  for a plain scalar. Shown quietly; it is structure, not identity. */
  shape: string | null;
  /** Bounds and the like: `max 1500`, `30 kB`. Also quiet. */
  constraint: string | null;
  /** Whether the field may be absent. */
  optional: boolean;
};

/** Makes an icydb type string readable.
 *
 *  icydb describes a field with its complete structure, which for a scalar is
 *  ideal and for a composite is a wall. One real column from toko's `User`:
 *
 *      composite(path=Profile, codec=structural_v1, shape=record{description:
 *      composite(path=TextDescription, codec=structural_v1, shape=newtype<text(
 *      max_len=1500)>)?, name:composite(path=TextName, ...
 *
 *  — twenty rendered lines for one row, and *entirely redundant*: the schema
 *  panel already lists `description`, `name`, `pic` and the rest as their own
 *  nested rows underneath. The wall restates the tree drawn directly below it.
 *
 *  So this keeps what the string says that the tree does not — the type's name,
 *  its shape, its bounds — and drops what the tree already shows. The raw string
 *  stays available on hover, because it is the truth and someone will want it.
 *
 *  Deliberately not a parser. icydb's format is its own and will change; a
 *  grammar would break loudly on a shape this does not know. Everything here is
 *  a narrowing of a recognised prefix, and anything unrecognised passes through
 *  unchanged — worse-looking than before, never wrong.
 */
export function formatType(raw: string): FormattedType {
  let rest = raw.trim();

  // A trailing `?` is the whole reason to care about optionality, and it is the
  // one modifier applied outside the type it modifies.
  const optional = rest.endsWith("?");
  if (optional) rest = rest.slice(0, -1);

  // `composite(path=X, codec=..., shape=Y)` — the path is the name a reader
  // knows the type by; the codec is machinery they never chose.
  const composite = /^composite\(path=([^,)]+),.*?shape=(.*)\)$/s.exec(rest);
  if (composite) {
    const inner = formatType(composite[2]);

    return {
      name: composite[1],
      // A newtype wrapping a scalar is worth collapsing: `TextName` over
      // `newtype<text(max_len=50)>` reads as `TextName · text`, not as two
      // levels of indirection the reader must unpick.
      shape: inner.shape ?? inner.name,
      constraint: inner.constraint,
      optional,
    };
  }

  const newtype = /^newtype<(.*)>$/s.exec(rest);
  if (newtype) {
    const inner = formatType(newtype[1]);

    return { ...inner, optional: optional || inner.optional };
  }

  // `record{a:..., b:...}` — the fields are the nested rows below, so only the
  // count is news here.
  const record = /^record\{(.*)\}$/s.exec(rest);
  if (record) {
    return {
      name: "record",
      shape: `${countFields(record[1])} fields`,
      constraint: null,
      optional,
    };
  }

  const enumeration = /^enum\((.+)\)$/.exec(rest);
  if (enumeration) {
    return { name: enumeration[1], shape: "enum", constraint: null, optional };
  }

  // `map<K, V>` — the whole reason this branch exists. Unhandled, a map fell
  // through to the catch-all and printed its entire nested structure: toko's
  // `UserProjects.projects` rendered as five lines of
  // `map<principal, composite(path=Project, codec=structural_v1, shape=record{…})>`
  // in a pane a few characters wide. The key and value types are the news; the
  // machinery inside them is not.
  const map = /^map<(.*)>$/s.exec(rest);
  if (map) {
    const [key, value] = splitAtDepth0(map[1]);

    return {
      // Composed into the *name* rather than the shape, because a named wrapper
      // around this (`ProjectMap`) collapses `inner.shape ?? inner.name` — so a
      // shape here would be discarded and the reader would see only `ProjectMap`.
      name: `map<${formatType(key).name} → ${formatType(value ?? "").name}>`,
      shape: null,
      constraint: null,
      optional,
    };
  }

  // `list<X>`/`set<X>` — same wall for the same reason. toko's `User.pins` is a
  // `list<composite(path=Pin, …)>` and printed its whole record inline.
  const sequence = /^(list|set)<(.*)>$/s.exec(rest);
  if (sequence) {
    return {
      name: `${sequence[1]}<${formatType(sequence[2]).name}>`,
      shape: null,
      constraint: null,
      optional,
    };
  }

  const bounded = /^(\w+)\(max_len=(\d+)\)$/.exec(rest);
  if (bounded) {
    return {
      name: bounded[1],
      shape: null,
      constraint: bytesOrLength(bounded[1], Number(bounded[2])),
      optional,
    };
  }

  // `text(unbounded)` says less than `text` does — the parenthesis draws the eye
  // to the absence of a limit, which is the default.
  const unbounded = /^(\w+)\(unbounded\)$/.exec(rest);
  if (unbounded) {
    return { name: unbounded[1], shape: null, constraint: null, optional };
  }

  return { name: rest, shape: null, constraint: null, optional };
}

/** Splits on commas at the top level only.
 *
 *  A map's value type is routinely a composite full of its own commas, so
 *  `"principal, composite(path=Project, codec=structural_v1, …)"` has to break
 *  into two parts rather than four. Same depth-tracking as `countFields`, which
 *  needs the count rather than the pieces.
 */
function splitAtDepth0(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of body) {
    if (char === "{" || char === "<" || char === "(") depth += 1;
    else if (char === "}" || char === ">" || char === ")") depth -= 1;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());

  return parts;
}

/** Counts a record's fields by splitting only at its own depth — a nested
 *  `record{}` or `<>` contains commas that are not field separators. */
function countFields(body: string): number {
  let depth = 0;
  let fields = body.trim() === "" ? 0 : 1;

  for (const char of body) {
    if (char === "{" || char === "<" || char === "(") depth += 1;
    else if (char === "}" || char === ">" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) fields += 1;
  }

  return fields;
}

/** A blob's limit is a size and reads better as one; everything else is a count
 *  of characters. 30000 as `30 kB` is the difference between a number and a
 *  quantity a reader can judge. */
function bytesOrLength(kind: string, limit: number): string {
  if (kind !== "blob") return `max ${limit.toLocaleString()}`;

  return limit >= 1000 ? `max ${Math.round(limit / 1000)} kB` : `max ${limit} B`;
}
