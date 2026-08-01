import { exportFilename, exportRows } from "./exportRows";

const rows = {
  entity: "User",
  columns: ["id", "profile"],
  rows: [
    [
      { kind: "ulid", display: "01H8" },
      { kind: "map", display: '{name: "Rem", tags: ["red", "primary"]}' },
    ],
    [
      { kind: "ulid", display: "01H9" },
      { kind: "text", display: "plain" },
    ],
  ],
  rowCount: 2,
  nextCursor: null,
};

test("json export is one record per row, keyed by column", () => {
  const parsed = JSON.parse(exportRows(rows, "json"));

  expect(parsed).toHaveLength(2);
  expect(parsed[0].id).toBe("01H8");
  expect(parsed[1].profile).toBe("plain");
});

test("csv starts with the header row", () => {
  expect(exportRows(rows, "csv").split("\r\n")[0]).toBe("id,profile");
});

/// The whole reason to write a real CSV encoder rather than join on commas.
/// Structured cells are exactly what this app exists to display, and their
/// rendered form is full of commas — unquoted, this row would split into five
/// columns and corrupt every row after it.
test("a value containing commas stays one field", () => {
  const csv = exportRows(rows, "csv");
  const dataLine = csv.split("\r\n")[1];

  expect(dataLine).toBe('01H8,"{name: ""Rem"", tags: [""red"", ""primary""]}"');
});

test("embedded quotes are doubled, not dropped", () => {
  const quoted = {
    ...rows,
    rows: [[{ kind: "text", display: 'he said "hi"' }, { kind: "text", display: "x" }]],
  };

  expect(exportRows(quoted, "csv")).toContain('"he said ""hi"""');
});

/// Expanded arrays render one item per line, so a newline inside a cell is
/// ordinary data here — it must not become a row break.
test("a value containing a newline stays one row", () => {
  const multiline = {
    ...rows,
    rows: [[{ kind: "list", display: "red\nprimary" }, { kind: "text", display: "x" }]],
  };
  const csv = exportRows(multiline, "csv");

  // Header, the quoted field spanning two physical lines, then the trailing break.
  expect(csv).toContain('"red\nprimary"');
  expect(csv.split("\r\n")).toHaveLength(3);
});

test("an empty page still exports its header", () => {
  const empty = { ...rows, rows: [], rowCount: 0 };

  expect(exportRows(empty, "csv")).toBe("id,profile\r\n");
  expect(JSON.parse(exportRows(empty, "json"))).toEqual([]);
});

/// A row shorter than the header would otherwise shift every later column.
test("a short row is padded rather than shifting columns", () => {
  const ragged = { ...rows, rows: [[{ kind: "ulid", display: "01H8" }]] };

  expect(exportRows(ragged, "csv").split("\r\n")[1]).toBe("01H8,");
  expect(JSON.parse(exportRows(ragged, "json"))[0].profile).toBe("");
});

test("the filename is derived from the entity", () => {
  expect(exportFilename(rows, "csv")).toBe("User.csv");
  expect(exportFilename(rows, "json")).toBe("User.json");
});
