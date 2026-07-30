import type { SchemaDto } from "../api/types";

export function SchemaPanel({ schema }: { schema: SchemaDto }) {
  return (
    <div className="text-sm">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="border-b px-2 py-1 text-left font-semibold">Column</th>
            <th className="border-b px-2 py-1 text-left font-semibold">Type</th>
            <th className="border-b px-2 py-1 text-left font-semibold">Key</th>
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((column) => (
            <tr key={column.name} className="border-b">
              <td className="px-2 py-1 font-mono text-xs">{column.name}</td>
              <td className="px-2 py-1">
                {column.typeName}
                {column.optional ? "?" : ""}
              </td>
              <td className="px-2 py-1">{column.primaryKey ? "PK" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {schema.indexes.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase text-gray-500">Indexes</div>
          <ul className="list-disc pl-5">
            {schema.indexes.map((index) => (
              <li key={index} className="font-mono text-xs">
                {index}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
