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

/** What a statement is missing before icydb will run it, if anything.
 *
 *  icydb rejects `LIMIT`/`OFFSET` without an explicit ordering, and this app
 *  refuses to send an unbounded `SELECT`. So a bare `SELECT * FROM User` needs
 *  *both* a bound and an ordering, and a `SELECT ... LIMIT 100` needs only the
 *  ordering. Both used to be reported, in different places and different words:
 *  the first as prose from the backend telling the reader to "add an ORDER BY
 *  (e.g. by any column)", which names the rule and then leaves them to it.
 *
 *  Both are now one offer with a real clause in it, built from the entity's
 *  actual primary key. Naming the rule is worth something; doing the thing is
 *  worth more, and it is the difference between this being usable by someone who
 *  does not write SQL and not.
 *
 *  `null` when there is nothing to fix, when the statement is too incomplete to
 *  judge, or when no primary key is known — in which case there is nothing
 *  honest to propose.
 */
export function orderByAssist(sql: string, schema: SchemaDto | null): OrderByAssist | null {
  const upper = sql.toUpperCase();

  // Only a SELECT that has actually named a table. Offering a clause while the
  // reader is still typing `SELECT * FROM Us` is noise, and the table name is
  // what makes the primary key the right key to offer.
  if (!/^\s*SELECT\b/.test(upper)) return null;
  if (!/\bFROM\s+[A-Za-z_][A-Za-z0-9_]*/.test(sql)) return null;
  if (/\bORDER\s+BY\b/.test(upper)) return null;

  const keys = (schema?.columns ?? []).filter((column) => column.primaryKey);
  if (keys.length === 0) return null;

  const clause = `ORDER BY ${keys.map((column) => column.name).join(", ")}`;
  const bounded = /\bLIMIT\b|\bOFFSET\b/.test(upper);

  return {
    clause,
    // A statement with no bound needs one too, and this app will not send an
    // unbounded read — so offer the whole thing rather than fixing half and
    // leaving the reader to discover the other half.
    withLimit: bounded ? null : DEFAULT_LIMIT,
    insertion: bounded ? clause : `${clause} LIMIT ${DEFAULT_LIMIT}`,
  };
}

/** Matches `DEFAULT_ROW_LIMIT` in the Rust `commands.rs`, so the offer and what
 *  the backend would have appended agree. */
const DEFAULT_LIMIT = 100;

export type OrderByAssist = {
  /** The ordering clause alone. */
  clause: string;
  /** The bound to add alongside it, or null if the statement already has one. */
  withLimit: number | null;
  /** What pressing the key actually inserts. */
  insertion: string;
};

/** Inserts the assist where it belongs.
 *
 *  Before the `LIMIT`/`OFFSET` when there is one, because the ordering has to
 *  precede the window it orders — appending would give `LIMIT 100 ORDER BY id`,
 *  which is not valid SQL. At the end otherwise, since there is no window yet.
 */
export function applyOrderByAssist(sql: string, assist: OrderByAssist): string {
  const match = /\b(LIMIT|OFFSET)\b/i.exec(sql);
  if (!match) return `${sql.trimEnd()} ${assist.insertion}`;

  const head = sql.slice(0, match.index).trimEnd();
  const tail = sql.slice(match.index);

  return `${head} ${assist.clause} ${tail}`;
}

/** A complete, runnable statement for a table — the thing to offer someone
 *  looking at an empty editor.
 *
 *  Every part of it is required: this app will not send an unbounded read, and
 *  icydb will not accept the bound without an ordering. So the shortest correct
 *  starting point is longer than a newcomer would guess, which is exactly why it
 *  should be offered rather than described.
 */
export function starterQuery(entity: string, schema: SchemaDto | null): string {
  const keys = (schema?.columns ?? []).filter((column) => column.primaryKey);
  const ordering = keys.length > 0 ? ` ORDER BY ${keys.map((c) => c.name).join(", ")}` : "";

  return `SELECT * FROM ${entity}${ordering} LIMIT ${DEFAULT_LIMIT}`;
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
