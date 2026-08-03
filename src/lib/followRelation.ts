import type { ColumnDto, RelationDto, SchemaDto, ValueDto } from "../api/types";

/** How many rows a followed relation reads at most.
 *
 *  Matches `DEFAULT_LIMIT` in `suggestSql` and `DEFAULT_ROW_LIMIT` in the Rust
 *  `commands.rs`. This app never issues an unbounded read, and a followed
 *  relation is no exception — a `set` field with ten thousand keys is a page,
 *  not a table dump. */
export const FOLLOW_LIMIT = 100;

/** What following a relation will do, before the target's schema is known.
 *
 *  Two-stage on purpose. The keys come from the row that was clicked, but the
 *  *column* to match them against is the target entity's primary key — and this
 *  app holds a schema only for the entity currently selected. So a plan is built
 *  from what is in hand, and the statement is built once the target has been
 *  described. Guessing `id` would be wrong on any entity that names its key
 *  something else, and would fail as a confusing SQL error rather than as a
 *  missing piece of information. */
export type FollowPlan = {
  /** The entity to read from. */
  targetEntity: string;
  /** The target keys this row holds. Empty for a relation field with nothing in
   *  it, which is a real state and not an error. */
  keys: string[];
  /** Whether this lands on one row or a page of them — from the relation's
   *  cardinality, so the UI can say which before running anything. */
  many: boolean;
};

/** The keys a relation cell holds.
 *
 *  A `single` relation's cell is the key itself. A `list`/`set` relation's cell
 *  holds many, and they arrive as `items` rather than being parsed back out of
 *  the rendered `[a, b]` — see `ValueDto`. An element whose display is empty is
 *  dropped: that is a null inside the list, which is not a key.
 */
export function relationKeys(value: ValueDto): string[] {
  if (value.items) {
    return value.items.map((item) => item.display).filter((display) => display !== "");
  }

  return value.display === "" ? [] : [value.display];
}

/** What following this relation from this cell would do.
 *
 *  `null` when there is nothing to follow — a null single relation, or a list
 *  relation with an empty list. Both are ordinary states of a row, so the caller
 *  should render no affordance rather than an affordance that fails.
 */
export function followPlan(relation: RelationDto, value: ValueDto): FollowPlan | null {
  const keys = relationKeys(value);
  if (keys.length === 0) return null;

  return {
    targetEntity: relation.targetEntity,
    keys,
    // `list` and `set` both hold many keys. `single` holds one — but a plan is
    // read from the cardinality rather than from `keys.length`, so a one-element
    // list still reads as "many" and the UI does not promise a single row it
    // cannot guarantee.
    many: relation.cardinality !== "single",
  };
}

/** The statement that follows a plan, given the target's primary key.
 *
 *  `ORDER BY` is not optional: icydb rejects `LIMIT`/`OFFSET` without an
 *  explicit ordering, so the bound this app always applies would make the
 *  statement fail on its own. Ordering by the key being matched is both correct
 *  and free — it is the column the lookup already uses.
 */
export function followStatement(plan: FollowPlan, primaryKey: string): string {
  const predicate =
    plan.keys.length === 1
      ? `${primaryKey} = ${quote(plan.keys[0])}`
      : `${primaryKey} IN (${plan.keys.map(quote).join(", ")})`;

  return `SELECT * FROM ${plan.targetEntity} WHERE ${predicate} ORDER BY ${primaryKey} LIMIT ${FOLLOW_LIMIT}`;
}

/** A SQL string literal.
 *
 *  Doubling the quote is SQL's own escape and what icydb's lexer expects. A ulid
 *  cannot contain one, but a relation key is whatever type the target's key is —
 *  text included — and a key that ends a literal early would not be a display
 *  bug, it would be a statement that reads something else. Every key goes
 *  through here, so no caller has to remember to.
 */
function quote(value: string): string {
  // A global regex rather than `replaceAll`, which this project's ES2020 target
  // does not provide.
  return `'${value.replace(/'/g, "''")}'`;
}

/** The primary key of a described entity, or null if it declares none.
 *
 *  Null is a real answer, not a failure: without a key column there is nothing
 *  to match a relation's keys against, and the honest response is to say so
 *  rather than to fall back to `id` and query a column that may not exist.
 *
 *  A composite key returns null too. Matching one would need the relation to
 *  carry every part of it, and it carries a single value per key — so the right
 *  answer is "this app cannot follow that", not a statement matching one column
 *  of several and silently over-reporting.
 */
export function primaryKeyOf(schema: SchemaDto): string | null {
  const keys = schema.columns.filter((column: ColumnDto) => column.primaryKey);

  return keys.length === 1 ? keys[0].name : null;
}
