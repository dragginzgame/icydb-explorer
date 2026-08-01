import type { RowsDto } from "../api/types";

/** What this app can write a page of rows out as. */
export type ExportFormat = "csv" | "json";

/** Serialises the rows currently on screen.
 *
 *  Deliberately the *displayed* values, not a typed dump. `ValueDto` carries a
 *  `kind` and a `display` string — the display is what the backend's view layer
 *  produced and what the grid shows, and it is the only representation this app
 *  actually has. Writing a file that looked round-trippable would be a claim the
 *  data cannot support: a `map` cell exports as the same rendered text you can
 *  read on screen, not as reconstructable JSON.
 *
 *  Scope is one page. The grid holds what has been fetched, so exporting is
 *  "save what I am looking at", not "dump the table" — the latter would be an
 *  unbounded read, which this app does not issue.
 */
export function exportRows(rows: RowsDto, format: ExportFormat): string {
  return format === "json" ? toJson(rows) : toCsv(rows);
}

/** The filename offered in the save dialog. */
export function exportFilename(rows: RowsDto, format: ExportFormat): string {
  return `${rows.entity}.${format}`;
}

function toJson(rows: RowsDto): string {
  const records = rows.rows.map((row) => {
    const record: Record<string, string> = {};
    rows.columns.forEach((column, index) => {
      record[column] = row[index]?.display ?? "";
    });
    return record;
  });

  // Pretty-printed: this is a file a person opens and reads, not a wire format.
  return `${JSON.stringify(records, null, 2)}\n`;
}

/** RFC 4180: a field is quoted when it contains a comma, a quote or a newline,
 *  and an embedded quote is doubled.
 *
 *  Worth doing properly rather than joining on commas. Structured cells are
 *  exactly the ones this app exists to display, and their rendered form is full
 *  of commas — `{name: "Rem", tags: ["red", "primary"]}` would otherwise split
 *  into five columns and silently corrupt every row after it. Newlines matter
 *  for the same reason: expanded arrays render one item per line. */
function csvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;

  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: RowsDto): string {
  const header = rows.columns.map(csvField).join(",");
  const body = rows.rows.map((row) =>
    rows.columns.map((_, index) => csvField(row[index]?.display ?? "")).join(","),
  );

  // CRLF, per RFC 4180 — it is what spreadsheet software expects, and the
  // quoting above already means a lone LF inside a field is data rather than a
  // row break.
  return [header, ...body].join("\r\n") + "\r\n";
}
