import type { ColumnDto, RelationDto, SchemaDto } from "../api/types";
import { formatType } from "../lib/formatType";

/** The schema of one entity.
 *
 *  The type column used to print icydb's own description verbatim, which for a
 *  scalar is exactly right and for a composite is twenty lines restating the
 *  nested rows drawn directly beneath it. `formatType` keeps what those rows do
 *  not say — the type's name, its shape, its bounds — and the raw string stays on
 *  hover, because it is the truth and someone will want it.
 *
 *  Colour carries the distinction rather than punctuation. A type's *name* is
 *  what a reader scans for, so it is the only thing at full contrast; shape and
 *  bounds are context and recede. The nesting prefix recedes furthest — it is
 *  structure the eye follows without reading.
 */
export function SchemaPanel({ schema }: { schema: SchemaDto }) {
  return (
    <div className="text-sm">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="sticky top-0 border-b border-rule bg-surface-inset px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3">
              Column
            </th>
            <th className="sticky top-0 border-b border-rule bg-surface-inset px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3">
              Type
            </th>
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((column) => (
            <SchemaRow key={column.name} column={column} />
          ))}
        </tbody>
      </table>

      {schema.relations.length > 0 && (
        <div className="mt-3">
          <div className="px-2 text-xs font-semibold uppercase tracking-wide text-text-3">
            Relations
          </div>
          <ul className="mt-1">
            {schema.relations.map((relation) => (
              <RelationRow key={relation.field} relation={relation} />
            ))}
          </ul>
        </div>
      )}

      {schema.indexes.length > 0 && (
        <div className="mt-3 px-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">Indexes</div>
          <ul className="mt-1">
            {schema.indexes.map((index) => (
              <li key={index} className="font-mono text-xs text-text-2">
                {index}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One relation the schema declares.
 *
 *  Coloured with `--accent` deliberately: this is metadata with the same
 *  standing as a primary key, so it takes the primary key's colour. Any link
 *  that crosses a canister boundary is the explorer's own inference and must
 *  never render like this one — the difference between "the schema says so" and
 *  "we guessed" is the most important thing on this pane.
 *
 *  The store path is on hover rather than on the row. It is what makes "same
 *  canister" checkable rather than merely asserted, so it has to be reachable,
 *  but it is a long qualified path and the pane is narrow.
 */
function RelationRow({ relation }: { relation: RelationDto }) {
  return (
    <li
      className="flex items-baseline gap-1.5 px-2 py-0.5 text-xs"
      title={`Declared by the schema. Target store: ${relation.targetStorePath}`}
    >
      <span className="font-mono text-text-2">{relation.field}</span>
      <span className="font-mono text-accent">→</span>
      <span className="font-mono text-accent">{relation.targetEntity}</span>
      {/* Cardinality reads as a plural, which is what a reader actually wants to
          know: whether following this lands on one row or many. */}
      <span className="ml-auto text-text-3">{cardinalityLabel(relation.cardinality)}</span>
    </li>
  );
}

/** icydb's cardinality as something a reader can act on.
 *
 *  `single` means one row; `list` and `set` both mean many, and the difference
 *  between them is about storage rather than about what a reader will see. An
 *  unrecognised value passes through unchanged rather than being forced into
 *  one of these — the Rust side maps the enum exhaustively, so a new value here
 *  means icydb grew a variant and guessing would be worse than showing it.
 */
function cardinalityLabel(cardinality: string): string {
  if (cardinality === "single") return "one";
  if (cardinality === "list" || cardinality === "set") return "many";

  return cardinality;
}

function SchemaRow({ column }: { column: ColumnDto }) {
  const type = formatType(column.typeName);
  // icydb renders nesting into the name with box-drawing characters. Splitting
  // it off lets the prefix recede while the field name stays legible — as one
  // string the eye has to step over the tree art to reach the name.
  const nesting = /^[\s├└─│|]+/.exec(column.name)?.[0] ?? "";
  const name = column.name.slice(nesting.length);

  return (
    <tr className="border-b border-rule align-baseline odd:bg-surface-1">
      <td className="px-2 py-1 font-mono text-xs">
        {nesting && <span className="text-text-3">{nesting}</span>}
        <span className={column.primaryKey ? "text-pk" : "text-text-1"}>{name}</span>
        {column.primaryKey && (
          // The key is a property of the column, so it belongs beside the
          // column — not in a third column that is empty on every other row.
          <span className="ml-1 text-xs uppercase tracking-wide text-pk">pk</span>
        )}
      </td>
      {/* The raw description on hover: this rendering is a summary, and a summary
          should never be the only place the truth lives. */}
      <td className="px-2 py-1" title={column.typeName}>
        <span className="font-mono text-xs text-text-1">{type.name}</span>
        {type.optional && (
          <span className="text-text-3" title="optional">
            ?
          </span>
        )}
        {type.shape && <span className="ml-1.5 text-xs text-text-3">{type.shape}</span>}
        {type.constraint && <span className="ml-1.5 text-xs text-text-3">{type.constraint}</span>}
      </td>
    </tr>
  );
}
