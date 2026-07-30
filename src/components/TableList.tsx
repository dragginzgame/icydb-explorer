import type { EntityDto } from "../api/types";

export function TableList({
  entities,
  selected,
  onSelect,
}: {
  entities: EntityDto[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (entities.length === 0) {
    return <p className="p-2 text-sm text-gray-500">No tables</p>;
  }

  return (
    <ul className="text-sm">
      {entities.map((entity) => {
        const isSelected = entity.name === selected;
        return (
          <li key={entity.name}>
            <button
              type="button"
              onClick={() => onSelect(entity.name)}
              className={`block w-full rounded px-2 py-1 text-left ${
                isSelected ? "bg-blue-100" : "hover:bg-gray-100"
              }`}
            >
              <div>{entity.name}</div>
              <div className="text-xs text-gray-400">
                {entity.columns} columns · {entity.indexes} indexes
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
