import type { EntityDto, SchemaDto } from "../api/types";

/** One thing the console can offer to insert. */
export type Suggestion = {
  /** The text inserted when taken. */
  text: string;
  /** What kind of thing it is, so the UI can group or label it. */
  kind: "column" | "table" | "keyword";
  /** Shown beside a column: its type, and whether it is the primary key. */
  detail?: string;
};

/** The statements this app will actually send. Offering anything else would be
 *  suggesting a query the classifier rejects before it leaves the machine. */
const STATEMENTS = ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"] as const;

/** Clauses worth completing once a statement is under way. `ORDER BY` earns its
 *  place because icydb requires one alongside `LIMIT`. */
const CLAUSES = ["FROM", "WHERE", "ORDER BY", "LIMIT", "OFFSET"] as const;

/** What to offer for the statement as typed so far.
 *
 *  Context-aware rather than a flat dictionary, because a flat list of every
 *  identifier is not help — it is the same scrolling the schema pane already
 *  offers. What makes this useful is that after `FROM` it offers tables, and
 *  after `SELECT`/`WHERE`/`ORDER BY` it offers the columns of the table the
 *  statement actually names.
 *
 *  One honest limitation: this app holds a full `SchemaDto` only for the entity
 *  currently selected. If the statement names a different table, its columns are
 *  unknown here — inventing them would be worse than offering nothing, so in
 *  that case only tables and keywords are offered. `DESCRIBE`-ing every entity
 *  up front to fix that would be a query per table for suggestions the reader
 *  may never look at.
 */
export function suggestSql(
  sql: string,
  entities: EntityDto[] | null,
  schema: SchemaDto | null,
): Suggestion[] {
  const trimmed = sql.trimStart();

  // Nothing typed yet: the only useful thing is how a statement may begin.
  if (trimmed === "") {
    return STATEMENTS.map((text) => ({ text, kind: "keyword" as const }));
  }

  const word = currentWord(sql);
  const expecting = expecting_(sql);

  const pool: Suggestion[] = [];
  if (expecting === "table") {
    pool.push(...tableSuggestions(entities));
  } else if (expecting === "column") {
    pool.push(...columnSuggestions(sql, schema));
    // A column position is also where a clause often follows, so keywords stay
    // available rather than being crowded out.
    pool.push(...CLAUSES.map((text) => ({ text, kind: "keyword" as const })));
  } else {
    pool.push(...CLAUSES.map((text) => ({ text, kind: "keyword" as const })));
    pool.push(...tableSuggestions(entities));
  }

  return filterByPrefix(pool, word);
}

/** The `ORDER BY` this statement needs but does not have, if any.
 *
 *  icydb rejects `LIMIT`/`OFFSET` without an explicit ordering, and that is the
 *  single most-hit failure in this app — so this turns reading an error into
 *  taking an offer. Uses the real primary key, and every column of a composite
 *  one, rather than guessing a name.
 *
 *  `null` when the statement already orders, has no `LIMIT` to justify one, or
 *  when no primary key is known — in which case there is nothing honest to
 *  propose.
 */
export function orderByAssist(sql: string, schema: SchemaDto | null): string | null {
  const upper = sql.toUpperCase();
  if (!/\bLIMIT\b|\bOFFSET\b/.test(upper)) return null;
  if (/\bORDER\s+BY\b/.test(upper)) return null;

  const keys = (schema?.columns ?? []).filter((column) => column.primaryKey);
  if (keys.length === 0) return null;

  return `ORDER BY ${keys.map((column) => column.name).join(", ")}`;
}

/** Inserts the assist before the `LIMIT`/`OFFSET` that requires it.
 *
 *  Appending would produce `... LIMIT 100 ORDER BY id`, which is not valid SQL —
 *  the ordering has to precede the window it orders. */
export function applyOrderByAssist(sql: string, assist: string): string {
  const match = /\b(LIMIT|OFFSET)\b/i.exec(sql);
  if (!match) return `${sql.trimEnd()} ${assist}`;

  const head = sql.slice(0, match.index).trimEnd();
  const tail = sql.slice(match.index);

  return `${head} ${assist} ${tail}`;
}

/** The partial word the cursor sits in, which suggestions filter against. */
function currentWord(sql: string): string {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(sql);

  return match ? match[0] : "";
}

/** What the statement is asking for at its end. */
function expecting_(sql: string): "table" | "column" | "clause" {
  // Look at the last clause keyword, not the whole statement, so a long query
  // is judged by where the cursor actually is.
  const upper = sql.toUpperCase();
  const lastFrom = Math.max(upper.lastIndexOf(" FROM"), upper.lastIndexOf("\nFROM"));
  const lastSelect = upper.lastIndexOf("SELECT");
  const lastWhere = upper.lastIndexOf("WHERE");
  const lastOrder = upper.lastIndexOf("ORDER BY");
  const lastDescribe = Math.max(upper.lastIndexOf("DESCRIBE"), upper.lastIndexOf("SHOW COLUMNS"));

  const columnish = Math.max(lastWhere, lastOrder);

  // `FROM` and `DESCRIBE` both name a table next.
  if (lastFrom > columnish && lastFrom > lastSelect) return "table";
  if (lastDescribe > columnish && lastDescribe > lastFrom) return "table";
  if (columnish >= 0 || lastSelect >= 0) return "column";

  return "clause";
}

function tableSuggestions(entities: EntityDto[] | null): Suggestion[] {
  return (entities ?? []).map((entity) => ({
    text: entity.name,
    kind: "table" as const,
    detail: `${entity.columns} columns`,
  }));
}

/** Columns, but only when the statement names the table this app has a schema
 *  for. Offering another table's columns would be a confident lie. */
function columnSuggestions(sql: string, schema: SchemaDto | null): Suggestion[] {
  if (!schema) return [];

  const named = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1];
  if (named && named.toLowerCase() !== schema.entity.toLowerCase()) return [];

  return schema.columns
    // icydb's own bookkeeping columns appear in a schema but are not something
    // to write into a query.
    .filter((column) => !column.name.startsWith("__icydb"))
    .map((column) => ({
      text: column.name,
      kind: "column" as const,
      detail: column.primaryKey ? `${column.typeName} · primary key` : column.typeName,
    }));
}

/** Case-insensitive prefix match, and never the word already complete —
 *  suggesting what is already typed is noise. */
function filterByPrefix(pool: Suggestion[], word: string): Suggestion[] {
  if (word === "") return pool;

  const needle = word.toLowerCase();

  return pool.filter(
    (suggestion) =>
      suggestion.text.toLowerCase().startsWith(needle) &&
      suggestion.text.toLowerCase() !== needle,
  );
}

/** Replaces the partial word at the end of `sql` with `text`. */
export function applySuggestion(sql: string, text: string): string {
  const word = currentWord(sql);
  const head = word === "" ? sql : sql.slice(0, sql.length - word.length);
  const spacer = head === "" || /\s$/.test(head) ? "" : "";

  return `${head}${spacer}${text} `;
}
