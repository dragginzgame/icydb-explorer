import { useState } from "react";

import type { RelationDto, RowsDto, ValueDto } from "../api/types";
import { followPlan } from "../lib/followRelation";
import { type FleetIndex, fleetLinks } from "../lib/fleetLinks";

import { PaneEmpty } from "./PaneStates";
import { CopyButton } from "./CopyButton";
import { ValueCell, formatExpanded, hasOwnCopyControl, isExpandable } from "./ValueCell";

// Enough rows to fill the pane without implying a page size we do not know.
const SKELETON_ROWS = 8;

/** Which cell is expanded, if any. One at a time: two open sub-rows in a wide
 *  table push the row you were reading off-screen. */
type Expanded = { row: number; column: number } | null;

// `hasMore` is a prop, not something this component derives: scalar paging
// is LIMIT/OFFSET, and only the caller — which knows the requested page size
// and current offset — can tell whether another page may exist. That keeps
// this component a dumb, trivially testable renderer.
export function RowGrid({
  rows,
  hasMore,
  onLoadMore,
  loading = false,
  loadingMore = false,
  skeletonColumns,
  relations,
  onFollow,
  fleet,
  onGoToCanister,
}: {
  /** The page to render, or `null` when there is no page: a fetch is in flight
   *  (with `loading`) or one failed (without it). Nullable rather than a
   *  caller-synthesised empty `RowsDto`, because every synthesised shape has to
   *  come from *somewhere* — and the only shape a caller has lying around is the
   *  previously selected entity's, which is the wrong table's. */
  rows: RowsDto | null;
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
  /** Whether the next page is in flight. A page against a large table can take
   *  seconds, and a control that does not change on click reads as one that did
   *  not register it. */
  loadingMore?: boolean;
  /** How many columns the entity being loaded has, for sizing skeletons while
   *  `rows` is null. A count, not names: the caller knows the arity from
   *  `EntityDto.columns` before any row arrives, but not the names — those come
   *  with the schema or the first page. See the skeleton branch below for what
   *  is drawn in the header when the names are not known yet. */
  skeletonColumns?: number;
  /** The relations the rendered entity declares, so a cell holding a target's
   *  key can offer to follow it. Absent (or empty) means no cell does — which is
   *  also the right state for a grid showing a statement's output, since the
   *  columns there need not be the entity's own. */
  relations?: RelationDto[];
  /** Follow one. Absent means the affordance is never drawn, however many
   *  relations are declared: an affordance with nothing behind it is worse than
   *  none. */
  onFollow?: (relation: RelationDto, cell: ValueDto) => void;
  /** Principal → role for the fleet, so a cell holding a canister's id can say
   *  which canister it is. Absent means no resolution is offered — which is right
   *  while the fleet is still loading, since a principal with no name attached is
   *  what the reader already has. */
  fleet?: FleetIndex;
  /** Go to a canister named by a cell. Absent leaves the role visible but inert:
   *  knowing `jzyzi-…` is `project_ledger` is worth something on its own. */
  onGoToCanister?: (pid: string) => void;
}) {
  const [expanded, setExpanded] = useState<Expanded>(null);

  // `expanded` holds indices into `rows`, so it is only meaningful for the data
  // it was captured against. The grid now stays mounted across a fetch (which is
  // what wiring `loading` requires), so without this a cell open in column 4 of
  // a 6-column entity would leave `row[openColumn]` undefined the moment a
  // 2-column entity arrived — a TypeError with no error boundary above it.
  //
  // The identity is the entity plus the column count, NOT the row count:
  // `loadMore` appends rows, and an open sub-row surviving that is the desired
  // behaviour. `null` is its own identity, so the null `rows` that a caller
  // passes while a fetch is in flight also clears the expansion — which means
  // in `App` the clearing happens one render *earlier* than the new entity's
  // data arriving. That does not make the entity/arity comparison redundant:
  // it is what covers a caller that swaps one page for another without a null
  // in between (`SqlResultView`, and any future one), which is the case
  // `RowGrid.test.tsx` drives directly.
  //
  // Adjusting state during render (rather than in an effect) is React's
  // documented pattern for exactly this — it discards the stale render before
  // anything is committed, so no sub-row ever paints against the wrong data.
  const identity = rows === null ? null : `${rows.entity}/${rows.columns.length}`;
  const [seenIdentity, setSeenIdentity] = useState<string | null>(identity);
  if (seenIdentity !== identity) {
    setSeenIdentity(identity);
    setExpanded(null);
  }
  const live: Expanded = seenIdentity === identity ? expanded : null;

  const toggle = (row: number, column: number) =>
    setExpanded((current) =>
      current && current.row === row && current.column === column ? null : { row, column },
    );

  // Loading, empty, failed and "nothing selected" are four different states.
  // Skeletons carry the real column count so the grid does not reflow when data
  // lands — the count comes from `rows` when a page is already in hand, and from
  // `skeletonColumns` (the selected entity's own arity) when one is not.
  if (loading && (rows === null || rows.rows.length === 0)) {
    const columnNames = rows?.columns ?? null;
    const columnCount = columnNames?.length ?? skeletonColumns ?? 0;
    // Nothing to size against: the caller owns the empty state, and a
    // zero-column table would be noise on top of it.
    if (columnCount === 0) return null;
    return <RowSkeletons columnCount={columnCount} columnNames={columnNames} loading={loading} />;
  }

  // A fetch that is no longer in flight and produced nothing: a rejection. The
  // caller renders the error; this must not fall through to "No rows", which
  // would claim the table is empty when nobody managed to look.
  if (rows === null) return null;

  if (rows.rows.length === 0) {
    // Not "doesn't have any rows *yet*": this app is strictly read-only and
    // will never add them, so "yet" promises something it cannot deliver. What
    // is worth saying instead is the distinction a reader actually needs —
    // the table is there, it just holds nothing, which is a different situation
    // from a table that could not be read at all.
    return <PaneEmpty title="No rows">{rows.entity} exists but is empty.</PaneEmpty>;
  }

  return (
    <div className="flex flex-col">
      <div>
        <table className="min-w-full border-collapse text-sm" aria-busy={loading}>
          <thead className="sticky top-0 bg-surface-inset">
            <tr>
              {/* A position in what is on screen, not a row id and not a position
                  in the table. Those differ the moment a statement carries an
                  OFFSET, and a merged sweep has no table position at all — so this
                  counts the rows in front of the reader and claims nothing more.
                  `#` rather than a word, because a column head that reads like a
                  column name invites it to be mistaken for one. */}
              <th
                title="Position in the rows shown here. Not a row id, and not a position in the table."
                className="w-0 border-b border-rule px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-text-3"
              >
                #
              </th>
              {rows.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((row, rowIndex) => {
              const openColumn = live && live.row === rowIndex ? live.column : null;
              return (
                // eslint-disable-next-line react/no-array-index-key
                <ExpandableRow
                  key={rowIndex}
                  row={row}
                  rowIndex={rowIndex}
                  columns={rows.columns}
                  openColumn={openColumn}
                  onToggle={toggle}
                  relations={relations}
                  onFollow={onFollow}
                  fleet={fleet}
                  onGoToCanister={onGoToCanister}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        // Full width and padded: it is the one action at the bottom of a long
        // scroll, and a small button hugging the left edge of a wide pane is easy
        // to scroll straight past. The padding also keeps it off the last row's
        // rule, which it previously sat flush against.
        <div className="p-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
            className="w-full rounded-control border border-rule py-1.5 text-sm text-text-2 hover:bg-surface-2 disabled:text-text-3"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The loading grid: a header row and `SKELETON_ROWS` placeholder rows at the
 *  entity's real column count, so nothing reflows when the data lands.
 *
 *  `columnNames` is null on a first load — the caller knows the arity from
 *  `EntityDto.columns` long before it knows the names, which arrive with the
 *  schema or the first page. In that case each header cell gets a skeleton bar
 *  rather than a name.
 *
 *  A bar, not an empty `<th>`: an empty cell has no line box, so the header row
 *  would be shorter than the real one and the whole grid would shift down by a
 *  few pixels the moment the names arrived — the exact reflow this component
 *  exists to prevent, reintroduced in the one row that frames everything else.
 *  And a bar, not a guessed name: inventing "column 1" would be a claim about
 *  the data, and the previous entity's names (what this used to show) were a
 *  false one. The tradeoff is that a reader cannot tell *which* columns are
 *  coming until they arrive; they can tell how many, and that the pane is
 *  working rather than empty, which is what the skeleton is for. */
function RowSkeletons({
  columnCount,
  columnNames,
  loading,
}: {
  columnCount: number;
  columnNames: string[] | null;
  /** Threaded through rather than hardcoded: this table is only ever rendered
   *  from the branch that already knows a fetch is in flight, but writing
   *  `aria-busy="true"` here and `aria-busy={loading}` on the real grid would
   *  be two literals that could silently drift apart. One prop, one source. */
  loading: boolean;
}) {
  const columns = Array.from({ length: columnCount }, (_, index) => index);

  return (
    <table className="min-w-full border-collapse text-sm" aria-busy={loading}>
      <thead className="sticky top-0 bg-surface-inset">
        <tr>
          {/* Present here too: the real grid has this column, and a header that
              appeared only once data landed would shift every column right at the
              moment this table exists to keep still. */}
          <th className="w-0 border-b border-rule px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-text-3">
            #
          </th>
          {columns.map((columnIndex) => (
            <th
              key={columnIndex}
              className="border-b border-rule px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-text-3"
            >
              {columnNames ? (
                columnNames[columnIndex]
              ) : (
                <div
                  data-skeleton="true"
                  aria-hidden="true"
                  className="h-3 w-16 rounded-row bg-surface-2"
                />
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
          <tr key={rowIndex} className="border-b border-rule">
            {/* A bar, not the ordinal. The position is knowable, but printing
                1..8 beside skeletons would assert there are eight rows coming. */}
            <td className="w-0 px-2 py-1">
              <div
                data-skeleton="true"
                aria-hidden="true"
                className="h-3 w-3 rounded-row bg-surface-2"
              />
            </td>
            {columns.map((columnIndex) => (
              <td key={columnIndex} className="px-2 py-1">
                <div
                  data-skeleton="true"
                  aria-hidden="true"
                  className="h-3 w-24 rounded-row bg-surface-2"
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The control that follows a relation from the cell holding its keys.
 *
 *  `--accent` deliberately, the same colour a primary key gets: this is metadata
 *  the schema declares, and the reader is entitled to trust it. An inferred
 *  cross-canister link is a guess and must never render this way — that
 *  distinction only means something if the declared case claims the colour.
 *
 *  No popover. For a declared relation there is exactly one target and it is in
 *  this same canister, so there is nothing to choose: a dialog whose only content
 *  is "here is the statement, press OK" is a speed bump, and the statement lands
 *  in the SQL bar the moment it runs, which is already where this app says what
 *  it ran. An inferred link does need one, because picking among candidates is a
 *  real decision.
 */
function FollowButton({
  relation,
  cell,
  onFollow,
}: {
  relation: RelationDto;
  cell: ValueDto;
  onFollow: (relation: RelationDto, cell: ValueDto) => void;
}) {
  const plan = followPlan(relation, cell);
  // Never rendered without a plan — the caller checks — but reading the count
  // from the plan rather than re-deriving it keeps one source for "how many".
  const count = plan?.keys.length ?? 0;
  const many = plan?.many ?? false;

  return (
    <button
      type="button"
      onClick={() => onFollow(relation, cell)}
      aria-label={`Follow ${relation.field} to ${relation.targetEntity}`}
      title={
        `Declared by the schema. Reads ${many ? `${count} ` : ""}` +
        `${relation.targetEntity}${many && count !== 1 ? " rows" : " row"} ` +
        `from this canister — the target store is ${relation.targetStorePath}.`
      }
      // `hover:text-sel-text` is not decoration: in Terminal `--accent` and
      // `--sel-bg` are the same green, so accent-on-selection would be invisible
      // exactly when hovered. `tokens-only.test.ts` caught this and is right to.
      className="shrink-0 rounded-row px-1 font-mono text-xs leading-tight text-accent hover:bg-sel-bg hover:text-sel-text"
    >
      →
    </button>
  );
}

/** Names the canister a cell's principal points at.
 *
 *  The role, not an arrow: `jzyzi-fd777-77774-qaafq-cai` tells a reader nothing,
 *  and the point of this is the name. Clicking navigates there, but the label
 *  earns its place even when it cannot — which is why the inert form still
 *  renders rather than being suppressed when no handler is given.
 *
 *  Its own visual language, not declared's `--accent` or an inference's `--warn`.
 *  This is neither: certain, because the value literally is the canister's id,
 *  but a jump to a *canister* rather than a relation to rows. Putting it on the
 *  same confidence scale as those would say it is a weaker version of one of
 *  them, when it is a different thing entirely.
 */
function FleetChip({
  link,
  onGoTo,
}: {
  link: { pid: string; role: string };
  onGoTo?: (pid: string) => void;
}) {
  const label = (
    <>
      <span aria-hidden="true" className="text-text-3">
        ↳
      </span>
      {link.role}
    </>
  );
  const shared = "flex shrink-0 items-center gap-1 rounded-row border border-rule px-1 font-sans text-xs";

  if (!onGoTo) {
    return (
      <span
        title={`${link.pid} is this fleet's ${link.role} canister.`}
        className={`${shared} bg-surface-1 text-text-2`}
      >
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onGoTo(link.pid)}
      aria-label={`Go to ${link.role}`}
      title={`${link.pid} is this fleet's ${link.role} canister. Opens it.`}
      className={`${shared} bg-surface-1 text-text-2 hover:border-rule-strong hover:bg-surface-2`}
    >
      {label}
    </button>
  );
}

/** One data row plus, when a cell is expanded, the sub-row beneath it.
 *
 *  Split out because a row renders as two sibling `<tr>`s, which a `.map` in the
 *  parent cannot express without a fragment per row — and the fragment would
 *  need the key, obscuring which element it belongs to. */
function ExpandableRow({
  row,
  rowIndex,
  columns,
  openColumn,
  onToggle,
  relations,
  onFollow,
  fleet,
  onGoToCanister,
}: {
  row: RowsDto["rows"][number];
  rowIndex: number;
  columns: string[];
  openColumn: number | null;
  onToggle: (row: number, column: number) => void;
  relations?: RelationDto[];
  onFollow?: (relation: RelationDto, cell: ValueDto) => void;
  /** Principal → role for the fleet, so a cell holding a canister's id can say
   *  which canister it is. Absent means no resolution is offered — which is right
   *  while the fleet is still loading, since a principal with no name attached is
   *  what the reader already has. */
  fleet?: FleetIndex;
  /** Go to a canister named by a cell. Absent leaves the role visible but inert:
   *  knowing `jzyzi-…` is `project_ledger` is worth something on its own. */
  onGoToCanister?: (pid: string) => void;
}) {
  // Stripe by the row's position in the *data*, not in the DOM. The sub-row
  // rendered below (when this row's cell is open) is itself a sibling `<tr>`
  // in the same `<tbody>`, so an `nth-child`-based selector (Tailwind's
  // `odd:`) would count it too — inserting or removing that one extra `<tr>`
  // shifts the DOM parity of every row beneath it, and the banding would
  // visibly reshuffle on every expand/collapse. Keying off `rowIndex` instead
  // ties the stripe to the data, so a sub-row appearing or disappearing next
  // to it cannot move it.
  const striped = rowIndex % 2 === 0;

  // Belt as well as braces. The parent invalidates `expanded` when the data's
  // identity changes, but this row is the place the stale index would actually
  // throw, and a TypeError here has no error boundary above it — it blanks the
  // window. Resolving the cell once, defensively, makes an out-of-range index
  // render nothing instead.
  const openCell = openColumn === null ? undefined : row[openColumn];

  // Stable and grid-unique: a row/column pair never repeats within one
  // render of this grid. Computed only when something is open — an id with
  // nothing in the document to match it is not a fallback, it is the exact
  // dangling reference `aria-controls` must never point at.
  const subRowId = openColumn === null ? undefined : `row-${rowIndex}-col-${openColumn}-subrow`;

  return (
    <>
      {/* Zebra on `surface-1`, not `surface-inset`: the sticky header uses
          `surface-inset`, so zebra there would make every other data row the
          same colour as the header and defeat both cues at once. */}
      <tr className={["border-b border-rule", striped && "bg-surface-1"].filter(Boolean).join(" ")}>
        {/* `tabular-nums` so the digits line up down the column, and `w-0` so it
            takes only the width its widest number needs. */}
        <td className="w-0 whitespace-nowrap px-2 py-1 align-top text-right font-mono text-xs tabular-nums text-text-3">
          {rowIndex + 1}
        </td>
        {row.map((cell, columnIndex) => {
          const column = columns[columnIndex];
          // A relation is matched by column name, which is what the DTO gives:
          // `RelationDto.field` names the field on this entity.
          const relation = relations?.find((candidate) => candidate.field === column);
          // No plan means nothing to follow — a null single relation, or a list
          // relation holding an empty list. Both are ordinary states of a row, so
          // the cell gets no affordance rather than one that would fail.
          const followable = relation && onFollow && followPlan(relation, cell) !== null;
          // Exact, not inferred: this cell's value *is* one of these canisters'
          // ids. Most principals in a fleet's data are users and resolve to
          // nothing, which is the correct answer and the common case.
          const links = fleet ? fleetLinks(cell, fleet) : [];
          // Every cell is clipped to `max-w-cell`, so the value on screen is often
          // not the whole value — which makes "copy this cell" the only way to get
          // at the rest of it short of expanding and selecting by hand. Skipped
          // where the kind already carries its own control, rather than offering
          // two ways to do one thing.
          const copyable = cell.display !== "" && !hasOwnCopyControl(cell);
          const valueCell = (
            <ValueCell
              value={cell}
              column={column}
              expanded={openColumn === columnIndex}
              subRowId={openColumn === columnIndex ? subRowId : undefined}
              onToggle={isExpandable(cell) ? () => onToggle(rowIndex, columnIndex) : undefined}
            />
          );

          return (
            // eslint-disable-next-line react/no-array-index-key
            <td key={columnIndex} className="px-2 py-1 align-top">
              {/* Wrapped only when there is something to wrap. Every cell in the
                  app would otherwise gain a flex container for the sake of the
                  few that hold a relation key. */}
              {followable || links.length > 0 || copyable ? (
                /* No wrapping. `flex-wrap` was here for the fleet chips, and it
                   put the copy control on a second line whenever the value filled
                   `max-w-cell` — which made every long cell a two-line row and the
                   grid half as dense. The value truncates instead: its
                   `overflow-hidden` zeroes the flex automatic minimum, so it gives
                   up width to keep the controls beside it rather than under it. */
                <div className="group flex items-start gap-1">
                  {valueCell}
                  {followable && (
                    <FollowButton relation={relation} cell={cell} onFollow={onFollow} />
                  )}
                  {links.map((link) => (
                    <FleetChip key={link.pid} link={link} onGoTo={onGoToCanister} />
                  ))}
                  {copyable && (
                    /* Revealed on hover so a hundred rows are not a hundred visible
                       controls — but `focus-visible` too, or the control would be
                       unreachable by keyboard. Hidden with `opacity`, not
                       `display`, so it keeps its place in the tab order and in the
                       accessibility tree either way. */
                    <CopyButton
                      value={cell.display}
                      label={`Copy ${columns[columnIndex] ?? "value"}`}
                      className="px-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  )}
                </div>
              ) : (
                valueCell
              )}
            </td>
          );
        })}
      </tr>
      {openCell && (
        <tr id={subRowId} className="border-b border-rule">
          {/* `+ 1` for the ordinal column, which is not in `row`. Without it the
              sub-row stops one column short and the grid's last column escapes
              the expanded panel. */}
          <td colSpan={row.length + 1} className="bg-surface-2 px-2 py-2 pl-8">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-2">
              {formatExpanded(openCell.display)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
