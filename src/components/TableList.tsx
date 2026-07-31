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
    return <p className="p-2 text-sm text-text-2">No tables</p>;
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
              className={`block w-full rounded-row px-2 py-1 text-left ${
                isSelected ? "bg-sel-bg text-sel-text" : "hover:bg-surface-2"
              }`}
            >
              <div>{entity.name}</div>
              <div className="text-xs text-text-3">
                {entity.columns} columns · {entity.indexes} indexes
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
