import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import App from "./App";
import * as commands from "./api/commands";
import type { EntityDto, Environment, IdentityRef, ResultDto, TreeNode } from "./api/types";

vi.mock("./api/commands");

const dialogOpen = vi.hoisted(() => vi.fn());
const dialogSave = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen, save: dialogSave }));

// The pane layout (widths, the schema collapse, and whether the SQL bar is
// open) persists to `localStorage`, and vitest gives one jsdom to the whole
// file rather than one per test. So a test that opens the SQL bar would leave
// it open for every test after it — and those tests click the "SQL" button
// that only exists while it is *closed*, which would make the suite depend on
// its own declaration order. Cleared per test so each starts from the default
// layout.
beforeEach(() => localStorage.clear());

// A single usable identity, reused by every fixture `Environment` below so
// the app's initial-selection fallback (first usable entry in
// `identities`, since none of these fixtures configures a default) always
// has something to land on — otherwise the cascading fetch effects would
// early-return on a null identity and never call `canisterTree` at all.
const usableIdentity: IdentityRef = {
  name: "default",
  algorithm: "secp256k1",
  kind: "keyring",
  pemPath: null,
  unusableReason: null,
};

// A resolve-on-demand promise so the test controls exactly when each
// `listTables` call settles, independent of call order. `reject` is included
// too (unused by the earlier tests below, which only ever resolve) so the
// same helper covers a call that's expected to fail, like a timed-out
// `selectIdentity` export.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// `columns` is a parameter, not a fixed 1, because the app now sizes the row
// skeletons from `EntityDto.columns` — so a test whose `entity()` arity
// disagrees with the arity its `fetchRows` fixture returns is testing a
// contradiction. Defaulted so the tests that do not care stay unchanged.
function entity(name: string, columns = 1): EntityDto {
  return { name, storePath: "", storage: "stable", columns, indexes: 0, relations: 0, schemaVersion: 1 };
}

/** A `RowsDto` of `columns.length` columns and `rowCount` rows, where every cell
 *  is `<column>-<rowIndex>` — so any cell on screen names both the table it came
 *  from and the row it belongs to. */
function rowsFixture(entityName: string, columns: string[], rowCount: number): ResultDto {
  return {
    type: "rows",
    entity: entityName,
    columns,
    rows: Array.from({ length: rowCount }, (_, rowIndex) =>
      columns.map((column) => ({ kind: "text", display: `${column}-${rowIndex}` })),
    ),
    rowCount,
    nextCursor: null,
  };
}

/** Every skeleton placeholder in the grid's body, excluding the header row's —
 *  so a count means "8 rows x N columns" and nothing else. */
function bodySkeletons(): NodeListOf<Element> {
  return document.querySelectorAll('tbody [data-skeleton="true"]');
}

function environmentFixture(): Environment {
  return {
    name: "local",
    replicaUrl: "http://localhost",
    canisters: [{ name: "root", id: "root-id" }],
    identity: null,
    identities: [usableIdentity],
    artifacts: [],
  };
}

test("a stale canister's tables never overwrite a newer selection", async () => {
  const forest: TreeNode[] = [
    {
      pid: "root-id",
      role: "root",
      children: [
        { pid: "aaaaa-aa", role: "canister-a", children: [] },
        { pid: "bbbbb-bb", role: "canister-b", children: [] },
      ],
    },
  ];

  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [usableIdentity],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue(forest);

  const forA = deferred<ResultDto>();
  const forB = deferred<ResultDto>();
  vi.mocked(commands.listTables).mockImplementation((_env, canisterId) => {
    if (canisterId === "aaaaa-aa") return forA.promise;
    if (canisterId === "bbbbb-bb") return forB.promise;
    throw new Error(`unexpected canister ${canisterId}`);
  });

  render(<App />);

  // Wait for the fleet tree to render, then select A and, before its
  // `listTables` resolves, switch to B — exactly the "click through a
  // fleet tree quickly" scenario the review flagged.
  await screen.findByText("canister-a");
  fireEvent.click(screen.getByText("canister-a"));
  fireEvent.click(screen.getByText("canister-b"));

  // Resolve out of order: B (the current selection) settles first, then
  // A (the stale one) settles after. Without a staleness guard, A's later
  // response would overwrite B's just-rendered table list.
  forB.resolve({ type: "entities", entities: [entity("table_b")] });
  await screen.findByText("table_b");

  forA.resolve({ type: "entities", entities: [entity("table_a")] });

  // Flush the task queue so A's (stale) `.then` has a chance to run and —
  // if the bug were still present — clobber the table list. A macrotask
  // tick (not just a microtask) is needed because React's commit for a
  // state update triggered from a raw, un-awaited promise callback isn't
  // guaranteed to flush within the same microtask turn.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.getByText("table_b")).toBeDefined();
  expect(screen.queryByText("table_a")).toBeNull();
});

test("shows an explicit empty state when discovery finds no environments and no error", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [],
  });

  render(<App />);

  await screen.findByText(/no environments were found/i);
});

test("shows an explicit banner when no identity is usable, rather than a silently blank app", async () => {
  // Every identity in the store is unusable (here: only `anonymous`) — the
  // exact case the show-unusable-with-reason design exists for.
  // `initialIdentityFor` returns `null` for this environment, every
  // cascading effect early-returns on that `null`, and previously nothing
  // told the user why the app looked empty (`identityError` is only ever
  // set by a *failed* `selectIdentity` call, never by there being nothing
  // to select in the first place).
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [
          {
            name: "anonymous",
            algorithm: "secp256k1",
            kind: "anonymous",
            pemPath: null,
            unusableReason:
              "the anonymous identity cannot be used: icydb's SQL endpoints are controller-gated",
          },
        ],
        artifacts: [],
      },
    ],
  });

  // `canisterTree` isn't stubbed for this test (there's nothing it could
  // sensibly be called with), so its call history is cleared here rather
  // than trusting no earlier test in this file left calls on the same
  // module-level mock — `vi.mock` calls aren't reset between tests
  // automatically in this project's vitest config.
  vi.mocked(commands.canisterTree).mockClear();

  render(<App />);

  // Matched against the banner `<p>` specifically: the (disabled) `<option>`
  // in `IdentitySelector` also renders `unusableReason`, so an unscoped
  // `/controller-gated/` query would match twice.
  const banner = await screen.findByText(/no usable identity is available/i);
  expect(banner.textContent).toMatch(/controller-gated/);
  // Never silently blank: nothing should even attempt to query with a null
  // identity.
  expect(commands.canisterTree).not.toHaveBeenCalled();
});

test("shows the discovery error rather than a silent blank pane", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: { kind: "io", explanation: "not an .icp project layout" },
    environments: [],
  });

  render(<App />);

  await screen.findByText(/not an \.icp project layout/i);
  // The empty-state hint is specific to "genuinely nothing deployed yet" —
  // it must not also render alongside a real discovery error.
  expect(screen.queryByText(/no environments were found/i)).toBeNull();
});

/// A long explanation must scroll inside its own region rather than pushing the
/// panes out of the window. Bounding the container is fine; truncating the text
/// is not — the backend's explanation is the most useful thing it produces on a
/// failure and is rendered verbatim in full (see `ErrorBanner`'s own comment).
///
/// jsdom has no layout engine, so this cannot observe panes actually being
/// squeezed — it pins the mechanism instead: a bounded, scrollable container
/// that still carries the whole string, plus a pane still mounted alongside it.
test("a very long error explanation scrolls in its own region instead of squeezing the panes", async () => {
  const explanation = "SQL surface disabled. ".repeat(400);
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: { kind: "unknown", explanation },
    environments: [],
  });

  render(<App />);

  expect(await screen.findByText(new RegExp(explanation.slice(0, 40)))).toBeInTheDocument();
  const region = document.querySelector("[data-banner-region]");
  expect(region).not.toBeNull();
  expect(region!.className).toMatch(/overflow-(?:auto|y-auto)/);
  expect(region!.className).toMatch(/max-h-/);
  // The panes are still mounted, not squeezed out of existence.
  expect(await screen.findByRole("region", { name: "Rows" })).toBeInTheDocument();
  // This is the one fixture where the banner region is actually mounted, so it is
  // where the shrinkability walk (see its own test further down) gets to confirm
  // that this region's `shrink-0` is still a legal opt-out: it is a scroll region
  // with a `max-h` bound of its own, not an unbounded ancestor of one.
  expect(unshrinkableAncestors()).toEqual([]);
});

test("a stale SQL console run never overwrites a newer canister's result", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [usableIdentity],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    {
      pid: "root-id",
      role: "root",
      children: [
        { pid: "aaaaa-aa", role: "canister-a", children: [] },
        { pid: "bbbbb-bb", role: "canister-b", children: [] },
      ],
    },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({ type: "entities", entities: [] });

  const forA = deferred<{ result: ResultDto; limitAppended: boolean; orderByMissing: boolean }>();
  const forB = deferred<{ result: ResultDto; limitAppended: boolean; orderByMissing: boolean }>();
  vi.mocked(commands.runSql).mockImplementation((_env, canisterId) => {
    if (canisterId === "aaaaa-aa") return forA.promise;
    if (canisterId === "bbbbb-bb") return forB.promise;
    throw new Error(`unexpected canister ${canisterId}`);
  });

  render(<App />);

  await screen.findByText("canister-a");
  fireEvent.click(screen.getByText("canister-a"));
  // The console lives in the SQL bar, which starts collapsed — open it before
  // driving it. (It stays open across the canister switch below: the bar's
  // expanded state is layout, not selection.)
  fireEvent.click(screen.getByRole("button", { name: "SQL" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SELECT 1" } });
  fireEvent.click(screen.getByRole("button", { name: /run/i }));

  // Switch canisters and re-run before A's runSql resolves.
  fireEvent.click(screen.getByText("canister-b"));
  fireEvent.click(screen.getByRole("button", { name: /run/i }));

  forB.resolve({ result: { type: "count", entity: "b_row", rowCount: 2 }, limitAppended: false, orderByMissing: false });
  await screen.findByText(/b_row/);

  // A's stale response arrives after B's has already rendered.
  forA.resolve({ result: { type: "count", entity: "a_row", rowCount: 1 }, limitAppended: false, orderByMissing: false });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.getByText(/b_row/)).toBeDefined();
  expect(screen.queryByText(/a_row/)).toBeNull();
});

test("switching environments re-derives the identity for the new environment", async () => {
  // Two environments whose `identities` lists don't overlap by name: if the
  // app carried "alice" over into "ic" instead of re-deriving, `ic`'s
  // `canisterTree` call would be made with an identity that doesn't even
  // exist there.
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [
          { name: "alice", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
        ],
        artifacts: [],
      },
      {
        name: "ic",
        replicaUrl: "https://icp0.io",
        canisters: [{ name: "root", id: "root-id-2" }],
        identity: null,
        identities: [
          { name: "carol", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
        ],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  render(<App />);

  await waitFor(() => {
    expect(commands.canisterTree).toHaveBeenCalledWith("local", "alice");
  });

  fireEvent.change(screen.getByDisplayValue("local"), { target: { value: "ic" } });

  await waitFor(() => {
    expect(commands.canisterTree).toHaveBeenCalledWith("ic", "carol");
  });
  // Never re-uses "local"'s identity for "ic" — that name isn't even in
  // "ic"'s `identities`, so a carried-over selection would either fail
  // obscurely at the backend or (worse) silently resolve to the wrong
  // identity if a same-named one happened to exist there.
  expect(commands.canisterTree).not.toHaveBeenCalledWith("ic", "alice");
});

test("switching identity before a slow selectIdentity call resolves does not resurrect its error", async () => {
  // Three identities so the initial fallback ("alice", first in the list)
  // is distinct from both identities this test actually drives through
  // `selectIdentity`. "slow-password" stands in for a password-protected
  // identity whose eager export can take up to 20s (`EXPORT_TIMEOUT` in
  // `src-tauri/src/agent/export.rs`) before it ultimately fails.
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [
          { name: "alice", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
          { name: "slow-password", algorithm: "secp256k1", kind: "pem", pemPath: "/x", unusableReason: null },
          { name: "bob", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
        ],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  const forSlow = deferred<void>();
  const forBob = deferred<void>();
  vi.mocked(commands.selectIdentity).mockImplementation((_env, identity) => {
    if (identity === "slow-password") return forSlow.promise;
    if (identity === "bob") return forBob.promise;
    throw new Error(`unexpected identity ${identity}`);
  });

  render(<App />);

  // Wait for the identity selector to actually render (it depends on the
  // async `listEnvironments` resolving first) before driving it.
  await screen.findByDisplayValue("local");
  const identitySelect = screen.getAllByRole("combobox")[1];

  // Pick the slow identity, then — before it resolves — pick a working one.
  fireEvent.change(identitySelect, { target: { value: "slow-password" } });
  fireEvent.change(identitySelect, { target: { value: "bob" } });

  // The later (current) selection succeeds first.
  forBob.resolve();
  await waitFor(() => {
    expect(identitySelect).toHaveValue("bob");
  });

  // The abandoned selection's export finally times out and rejects. Without
  // a staleness guard this would still call `setIdentityError`, planting a
  // banner about "slow-password" even though the session has long since
  // moved on to "bob".
  forSlow.reject({
    kind: "unknown",
    explanation: "`icp identity export slow-password` timed out after 20s",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.queryByText(/timed out/i)).toBeNull();
  expect(identitySelect).toHaveValue("bob");
});

test("renders SHOW CONSTRAINTS results from the console", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [usableIdentity],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "root-id", role: "root", children: [{ pid: "aaaaa-aa", role: "canister-a", children: [] }] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({ type: "entities", entities: [] });
  vi.mocked(commands.runSql).mockResolvedValue({
    result: {
      type: "constraints",
      entity: "demo_row",
      constraints: [
        {
          name: "demo_row_pk",
          kind: "primary_key",
          origin: "declared",
          validationState: "valid",
          fields: ["id"],
          semantics: "immediate",
        },
      ],
    },
    limitAppended: false,
    orderByMissing: false,
  });

  render(<App />);

  await screen.findByText("canister-a");
  fireEvent.click(screen.getByText("canister-a"));
  // The console lives in the SQL bar, which starts collapsed.
  fireEvent.click(screen.getByRole("button", { name: "SQL" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "SHOW CONSTRAINTS FROM demo_row" },
  });
  fireEvent.click(screen.getByRole("button", { name: /run/i }));

  expect(await screen.findByText("demo_row_pk")).toBeDefined();
  expect(screen.getByText(/primary_key/)).toBeDefined();
  expect(screen.getByText("declared")).toBeDefined();
  // `validationState`'s camelCase field name matters most here: a regression
  // back to `validation_state` would leave this cell `undefined` and render
  // empty, with no compile error and no throw — this is the one assertion
  // that would actually catch that.
  expect(screen.getByText("valid")).toBeDefined();
  expect(screen.getByText("id")).toBeDefined();
  expect(screen.getByText("immediate")).toBeDefined();
});

test("switching environments abandons an in-flight identity selection", async () => {
  // Two environments so the switch is real: "local" starts on "alice" (the
  // initial fallback) and has a second, slow-to-select identity;
  // "ic" has a single, unrelated identity of its own.
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/project",
    error: null,
    environments: [
      {
        name: "local",
        replicaUrl: "http://localhost",
        canisters: [{ name: "root", id: "root-id" }],
        identity: null,
        identities: [
          { name: "alice", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
          { name: "slow-password", algorithm: "secp256k1", kind: "pem", pemPath: "/x", unusableReason: null },
        ],
        artifacts: [],
      },
      {
        name: "ic",
        replicaUrl: "https://icp0.io",
        canisters: [{ name: "root", id: "root-id-2" }],
        identity: null,
        identities: [
          { name: "carol", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null },
        ],
        artifacts: [],
      },
    ],
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  const forSlow = deferred<void>();
  vi.mocked(commands.selectIdentity).mockImplementation((_env, identity) => {
    if (identity === "slow-password") return forSlow.promise;
    throw new Error(`unexpected identity ${identity}`);
  });

  render(<App />);

  await screen.findByDisplayValue("local");
  const identitySelect = screen.getAllByRole("combobox")[1];

  // Start a slow selection for "local", then switch environments entirely
  // before it resolves — abandoning that in-flight request, not just
  // superseding it with another selection in the same environment (that
  // case is covered by the test above).
  fireEvent.change(identitySelect, { target: { value: "slow-password" } });
  fireEvent.change(screen.getByDisplayValue("local"), { target: { value: "ic" } });

  await waitFor(() => {
    expect(commands.canisterTree).toHaveBeenCalledWith("ic", "carol");
  });

  // The abandoned "local" selection's export finally times out and rejects.
  // Without clearing `identityRequestRef` on an environment switch, this
  // would still pass the "am I the latest request" check (it only ever
  // compared a request against itself, never against an environment change
  // happening out from under it) and plant an error banner for an identity
  // — and environment — the user has since left.
  forSlow.reject({
    kind: "unknown",
    explanation: "`icp identity export slow-password` timed out after 20s",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.queryByText(/timed out/i)).toBeNull();
  // Still cleanly on "ic"'s own identity, not reverted to or stuck on
  // "local"'s.
  expect(screen.getAllByRole("combobox")[1]).toHaveValue("carol");
});

test("offers the picker and no panes when no project is open", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue(null);

  render(<App />);

  expect(await screen.findByText(/choose a project to explore/i)).toBeInTheDocument();
  expect(screen.queryByText(/no environments were found/i)).not.toBeInTheDocument();
  // "No panes" is now something this test can actually assert: each pane is a
  // named region, so their absence is checkable rather than implied.
  for (const name of ["Canisters", "Tables", "Rows", "Schema"]) {
    expect(screen.queryByRole("region", { name })).not.toBeInTheDocument();
  }
});

test("adopts the project returned by a pick", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue(null);
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: { root: "/Users/me/projects/toko", environments: [environmentFixture()], error: null },
    persistWarning: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);
  dialogOpen.mockResolvedValue("/Users/me/projects/toko");

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /choose a project/i }));

  await waitFor(() =>
    expect(commands.selectProject).toHaveBeenCalledWith("/Users/me/projects/toko"),
  );
  expect(await screen.findByRole("button", { name: /toko/i })).toBeInTheDocument();
  expect(screen.queryByText(/choose a project to explore/i)).not.toBeInTheDocument();
});

test("renders a discovery error carried by an adopted project", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue(null);
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: {
      root: "/Users/me/Documents",
      environments: [],
      error: { kind: "io", explanation: "no .icp layout at /Users/me/Documents" },
    },
    persistWarning: null,
  });
  dialogOpen.mockResolvedValue("/Users/me/Documents");

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /choose a project/i }));

  expect(await screen.findByText(/no \.icp layout/i)).toBeInTheDocument();
});

test("shows a persist warning as a note, not as an error banner", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue(null);
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: { root: "/Users/me/projects/toko", environments: [environmentFixture()], error: null },
    persistWarning: "Could not write project.json: permission denied",
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);
  dialogOpen.mockResolvedValue("/Users/me/projects/toko");

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /choose a project/i }));

  expect(await screen.findByText(/won't be remembered/i)).toBeInTheDocument();
  expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
});

test("keeps the current project when a pick is rejected", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);
  vi.mocked(commands.selectProject).mockRejectedValue({
    kind: "io",
    explanation: "/nope is not a directory",
  });
  dialogOpen.mockResolvedValue("/nope");

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /toko/i }));

  expect(await screen.findByText(/is not a directory/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /toko/i })).toBeInTheDocument();
});

/// A canister id from the old project means nothing in the new one. The
/// effects keyed on `canister`/`entity` clear their own derived data, but the
/// *selections* themselves are not derived — without `adoptProject` nulling
/// them, they would survive the switch and the app would try to query a
/// canister that isn't in the new project.
test("switching projects clears the canister and entity selection", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/first",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow")],
  });
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: { root: "/Users/me/projects/second", environments: [environmentFixture()], error: null },
    persistWarning: null,
  });
  dialogOpen.mockResolvedValue("/Users/me/projects/second");

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  expect(await screen.findByText("DemoRow")).toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: /first/i }));

  // The entity list belonged to the old project's canister selection; with
  // the selection cleared there is nothing to list.
  await waitFor(() => expect(screen.queryByText("DemoRow")).not.toBeInTheDocument());
});

/// Both projects declare a `local` environment with a `default` identity —
/// the common case, and the one that used to break. The canister tree effect
/// is keyed on a project-adoption generation counter precisely so that
/// identical env/identity names still force a refetch; without it React bails
/// out of the state updates, the effect never re-runs, and the previous
/// project's canisters stay on screen, where clicking one would query the old
/// project's canister id through the new project's agent.
test("switching projects reloads the canister tree even when env and identity names match", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/first",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree)
    .mockResolvedValueOnce([{ pid: "aaaaa-aa", role: "canister-from-first", children: [] }])
    .mockResolvedValueOnce([{ pid: "bbbbb-bb", role: "canister-from-second", children: [] }]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow")],
  });
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: {
      root: "/Users/me/projects/second",
      environments: [environmentFixture()],
      error: null,
    },
    persistWarning: null,
  });
  dialogOpen.mockResolvedValue("/Users/me/projects/second");

  render(<App />);
  fireEvent.click(await screen.findByText("canister-from-first"));
  expect(await screen.findByText("DemoRow")).toBeInTheDocument();

  // Selected by `title` (the project selector button's full path), not by
  // its visible text: the visible text is `📁 first`, which a loose
  // `/first/i` name match would also match against the
  // "canister-from-first" tree node rendered above.
  fireEvent.click(await screen.findByTitle("/Users/me/projects/first"));

  // The new project's tree must replace the old one's.
  expect(await screen.findByText("canister-from-second")).toBeInTheDocument();
  expect(screen.queryByText("canister-from-first")).not.toBeInTheDocument();
  // And the old canister's entity list must not survive the switch.
  expect(screen.queryByText("DemoRow")).not.toBeInTheDocument();
});

/// `adoptProject` used to reset `sqlResult`/`sqlError` but leave
/// `sqlLimitAppended`/`sqlOrderByMissing` stale: run an unbounded `SELECT` in
/// project A (the console reports a default LIMIT was added), switch to
/// project B, and the note used to persist beside an empty console with no
/// query ever having run against B.
test("switching projects clears the stale 'default LIMIT was added' note", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/first",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({ type: "entities", entities: [] });
  vi.mocked(commands.runSql).mockResolvedValue({
    result: { type: "count", entity: "demo_row", rowCount: 3 },
    limitAppended: true,
    orderByMissing: false,
  });
  vi.mocked(commands.selectProject).mockResolvedValue({
    project: { root: "/Users/me/projects/second", environments: [environmentFixture()], error: null },
    persistWarning: null,
  });
  dialogOpen.mockResolvedValue("/Users/me/projects/second");

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  // The console lives in the SQL bar, which starts collapsed. It stays open
  // across the project switch below, so the stale note is still on screen to
  // be absent from.
  fireEvent.click(await screen.findByRole("button", { name: "SQL" }));
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));

  expect(await screen.findByText(/A default LIMIT was added/)).toBeInTheDocument();

  fireEvent.click(await screen.findByTitle("/Users/me/projects/first"));

  await waitFor(() =>
    expect(screen.queryByText(/A default LIMIT was added/)).not.toBeInTheDocument(),
  );
});

/// The four panes, each with its own accessible name, so a failure in one is
/// anchored in one. Before this the schema lived inside the Tables aside and
/// errors were inserted above the panes, shifting everything below them.
test("the shell presents four named panes", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);

  render(<App />);

  for (const name of ["Canisters", "Tables", "Rows", "Schema"]) {
    expect(await screen.findByRole("region", { name })).toBeInTheDocument();
  }
});

/// `overflow-hidden` on the pane row is about WIDTH, not height: the three
/// side panes are `shrink-0` and `PANE_BOUNDS` allows up to 1520px of fixed
/// width between them, so on a window narrower than that, dragged to those
/// maxima, the row is wider than its container — without the clip that
/// overflow reaches all the way to the document, which gains a horizontal
/// scrollbar and slides the full-width header out of alignment with the panes
/// (see the comment above the pane row in `App.tsx`). The phase's own mutation
/// record shows removing this class is invisible to every other test in the
/// suite; this is the cheap class-presence guard for it, the same shape as the
/// `@container` guard above.
test("the pane row clips its own overflow", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);

  render(<App />);

  const canistersPane = await screen.findByRole("region", { name: "Canisters" });
  const paneRow = canistersPane.parentElement;
  expect(paneRow).not.toBeNull();
  expect(paneRow!.className).toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/);
});

/// The Tables pane used to render nothing at all in two of its three blank
/// conditions: no canister picked (every launch, since nothing
/// auto-selects one) and `listTables` in flight. Only the third — a canister
/// with no entities — had a state, drawn inside `TableList` itself. This
/// drives the first two in one render, `deferred` holding `listTables` open
/// so the loading state is observable before it resolves.
test("the Tables pane shows a named empty state before a canister is picked, and a loading state while listing", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  const forTables = deferred<ResultDto>();
  vi.mocked(commands.listTables).mockReturnValue(forTables.promise);

  render(<App />);

  const tablesPane = await screen.findByRole("region", { name: "Tables" });
  expect(within(tablesPane).getByText("No canister selected")).toBeInTheDocument();
  expect(within(tablesPane).getByText(/select a canister to see its tables/i)).toBeInTheDocument();

  fireEvent.click(await screen.findByText("canister-a"));

  expect(within(tablesPane).getByText(/loading tables/i)).toBeInTheDocument();
  expect(within(tablesPane).queryByText("No canister selected")).not.toBeInTheDocument();

  forTables.resolve({ type: "entities", entities: [entity("DemoRow", 2)] });

  expect(await within(tablesPane).findByText("DemoRow")).toBeInTheDocument();
  expect(within(tablesPane).queryByText(/loading tables/i)).not.toBeInTheDocument();
});

/// The Canisters pane had neither a loading nor an empty state: `forest ===
/// null` (a fetch in flight) and `forest === []` (an environment that
/// genuinely lists none) both used to render an empty scroll region —
/// indistinguishable from each other and from a project with nothing to show.
/// `deferred` holds `canisterTree` open so the loading state is observable
/// before it resolves to the empty forest.
test("the Canisters pane shows a loading state while the tree fetches, and a named empty state when it resolves empty", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  const forTree = deferred<TreeNode[]>();
  vi.mocked(commands.canisterTree).mockReturnValue(forTree.promise);

  render(<App />);

  const canistersPane = await screen.findByRole("region", { name: "Canisters" });
  expect(within(canistersPane).getByText(/loading canisters/i)).toBeInTheDocument();

  forTree.resolve([]);

  expect(await within(canistersPane).findByText("No canisters")).toBeInTheDocument();
  expect(
    within(canistersPane).getByText(/this environment has nothing deployed yet/i),
  ).toBeInTheDocument();
  expect(within(canistersPane).queryByText(/loading canisters/i)).not.toBeInTheDocument();
});

/// Each pane owns its own failure. The rows fetch failing used to insert a
/// banner above the whole pane row, pushing every pane down; now the banner
/// lives inside the pane that failed, and the panes beside it do not move.
/// Scoped with `within` on purpose — an unscoped `getByRole("alert")` would
/// pass just as well for a banner rendered above the panes.
test("a failed rows fetch is anchored inside the Rows pane", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow")],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "DemoRow",
    columns: [{ name: "id", typeName: "Ulid", primaryKey: true, optional: false }],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockRejectedValue({
    kind: "backend",
    explanation: "E14: the SQL surface is disabled on this canister",
  });

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("DemoRow"));

  const rowsPane = await screen.findByRole("region", { name: "Rows" });
  const banner = await within(rowsPane).findByRole("alert");
  // Verbatim, whole: `explanation` is the most useful thing the backend
  // produces for a failure and is never truncated or paraphrased.
  expect(banner).toHaveTextContent("E14: the SQL surface is disabled on this canister");
  // The schema pane loaded fine and keeps showing its own content — a failure
  // in one pane is not a failure of the shell.
  expect(within(await screen.findByRole("region", { name: "Schema" })).getByText("id"))
    .toBeInTheDocument();
  // Nothing is in flight any more, so the pane must not also be pretending to
  // load. `rows` is null here for the same reason it is null mid-fetch, so the
  // only thing separating the two states is the error itself.
  expect(bodySkeletons()).toHaveLength(0);
  // Nor may it claim the table is empty: nobody managed to look. "No rows" is a
  // statement about the data, and a rejected fetch produced none to speak of.
  expect(screen.queryByText(/no rows/i)).not.toBeInTheDocument();
});

/// The skeleton state was shipped in phase 2a with no call site: `App` set rows
/// to null before each fetch and only rendered the grid when rows existed, so
/// "mounted, loading, no rows" was unreachable and the words "Loading rows…"
/// stayed on screen. This is the test that would have caught that.
///
/// The two tables have DIFFERENT arities on purpose — 2 columns then 6 — and
/// that is the whole point of the test. An earlier version of this file used two
/// 2-column fixtures, so its asserted count was satisfied by *either* entity's
/// arity, and it passed while the app was in fact sizing the skeletons from the
/// previously selected table's shape and then reflowing when the real data
/// landed. With different arities, only the selected entity's own count passes.
test("a pending row fetch shows skeletons at the SELECTED table's column count", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("NarrowRow", 2), entity("WideRow", 6)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "NarrowRow",
    columns: [],
    indexes: [],
  });

  const wide = deferred<ResultDto>();
  vi.mocked(commands.fetchRows).mockImplementation((_env, _canister, entityName) =>
    entityName === "NarrowRow"
      ? Promise.resolve(rowsFixture("NarrowRow", ["narrow_a", "narrow_b"], 1))
      : wide.promise,
  );

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("NarrowRow"));
  expect(await screen.findByText("narrow_a-0")).toBeInTheDocument();

  // The wide table's fetch never settles, so the app stays in the state that
  // used to be unreachable: grid mounted, loading, no rows.
  fireEvent.click(screen.getByText("WideRow"));

  // 8 skeleton rows × WideRow's OWN 6 columns — not NarrowRow's 2.
  await waitFor(() => expect(bodySkeletons()).toHaveLength(48));
  expect(screen.queryByText(/loading rows/i)).not.toBeInTheDocument();
  // And not under the previous table's headers, which would reflow away the
  // instant the real data arrived.
  expect(screen.queryByText("narrow_a")).not.toBeInTheDocument();
  expect(screen.queryByText("narrow_b")).not.toBeInTheDocument();
});

/// The first fetch of a session has no previous page to borrow a shape from, and
/// used to render nothing at all — an empty pane for the length of an IC call.
/// It does not need one: `SHOW ENTITIES` already reported the arity, so the
/// skeletons are correctly sized before a single row exists.
test("the first fetch of a session already shows correctly sized skeletons", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("WideRow", 6)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "WideRow",
    columns: [],
    indexes: [],
  });
  const first = deferred<ResultDto>();
  vi.mocked(commands.fetchRows).mockReturnValue(first.promise);

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("WideRow"));

  await waitFor(() => expect(bodySkeletons()).toHaveLength(48));
  // The header row is drawn too, at the same count, so the grid does not shift
  // down when the real names arrive. Deliberately unnamed: the arity is known
  // this early but the names are not, and the previous table's names — what
  // this used to show — were a lie.
  expect(document.querySelectorAll('thead [data-skeleton="true"]')).toHaveLength(6);
});

/// Selecting a canister with no tables clears the entity selection, so nothing
/// is in flight and there is nothing to load. This used to show 8 skeleton rows
/// at the *previous* table's arity under its column names, forever, because the
/// shape was held in a ref that outlived the selection — and the empty state was
/// unreachable. After a project switch those were the previous project's column
/// names.
test("switching to a canister with no tables shows the empty state, not skeletons", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    {
      pid: "root-id",
      role: "root",
      children: [
        { pid: "aaaaa-aa", role: "canister-a", children: [] },
        { pid: "bbbbb-bb", role: "canister-empty", children: [] },
      ],
    },
  ]);
  vi.mocked(commands.listTables).mockImplementation((_env, canisterId) =>
    Promise.resolve(
      canisterId === "aaaaa-aa"
        ? { type: "entities", entities: [entity("WideRow", 6)] }
        : { type: "entities", entities: [] },
    ),
  );
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "WideRow",
    columns: [],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockResolvedValue(
    rowsFixture("WideRow", ["w1", "w2", "w3", "w4", "w5", "w6"], 1),
  );

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("WideRow"));
  expect(await screen.findByText("w1-0")).toBeInTheDocument();

  fireEvent.click(screen.getByText("canister-empty"));

  expect(await screen.findByText(/select a table to see its rows/i)).toBeInTheDocument();
  expect(bodySkeletons()).toHaveLength(0);
  // Nor the departed table's headers sitting above a fake loading state.
  expect(screen.queryByText("w1")).not.toBeInTheDocument();
  expect(screen.getByText("No tables")).toBeInTheDocument();
  // The explanatory line too, not just the title — it is the part that tells the
  // reader this is a fact about the canister rather than a failure to read it.
  expect(screen.getByText(/doesn't expose any icydb entities/i)).toBeInTheDocument();
});

/// `max-w-cell` is `min(22rem, 42cqw)`, and `cqw` resolves against the nearest
/// ancestor with `container-type: inline-size` — established by an
/// `@container` class. The real invariant is not "the Rows pane has this
/// class" (what this test used to assert): it is that EVERY `max-w-cell`
/// element in the app has such an ancestor, whichever of `RowGrid`'s two call
/// sites drew it. The narrower version passed while the SQL bar's call site
/// (`SqlResultView`, which shares no ancestor with the Rows pane's
/// `@container`) had no container of its own — exactly the defect this
/// broader assertion exists to catch.
///
/// Nothing else would catch it: jsdom evaluates no container queries and no
/// layout, `tokens-only`'s existence check covers `bg-`/`text-`/`border-`/
/// `rounded-` but NOT `max-w-`, and every width test asserts only that a class
/// is present somewhere. So the whole suite stayed green while one call site's
/// grid was broken. This is a class-presence, DOM-structure assertion, which
/// is all jsdom can offer — it cannot evaluate container queries or resolve
/// widths, only confirm that the container the width depends on is declared
/// in the ancestor chain.
///
/// Both call sites are driven in this one render: a table selected in the Rows
/// pane populates `RowGrid` there, and running a `SELECT` in the SQL bar
/// populates `SqlResultView`'s separate `RowGrid`. Distinct column names in
/// the two fixtures (`a`/`b` vs `x`/`y`) keep the two grids' cell text from
/// colliding under `findByText`.
test("every max-w-cell element in the app has an @container ancestor", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "DemoRow",
    columns: [],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockResolvedValue(rowsFixture("DemoRow", ["a", "b"], 1));
  vi.mocked(commands.runSql).mockResolvedValue({
    result: rowsFixture("DemoRow", ["x", "y"], 1),
    limitAppended: false,
    orderByMissing: false,
  });

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("DemoRow"));
  expect(await screen.findByText("a-0")).toBeInTheDocument();

  // The second call site: `SqlResultView`'s `RowGrid`, reached through the SQL
  // bar, which starts collapsed.
  fireEvent.click(screen.getByRole("button", { name: "SQL" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SELECT x, y FROM DemoRow" } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("x-0")).toBeInTheDocument();

  const cells = document.querySelectorAll('[class*="max-w-cell"]');
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) {
    let node: Element | null = cell;
    let hasContainerAncestor = false;
    while (node) {
      if (node.classList.contains("@container")) {
        hasContainerAncestor = true;
        break;
      }
      node = node.parentElement;
    }
    expect(hasContainerAncestor).toBe(true);
  }
});

/// A paging failure must not throw away what the reader is already reading.
/// Rendering the banner and the grid as alternatives (`{!rowsError && …}`) meant
/// a rejected "Load more" replaced 100 rows with an error, recoverable only by
/// re-selecting the table.
test("a failed Load more keeps the rows already on screen", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "DemoRow",
    columns: [],
    indexes: [],
  });
  // A full first page (100 == the backend's DEFAULT_ROW_LIMIT) is what makes
  // "Load more" appear at all; the second page then rejects.
  vi.mocked(commands.fetchRows).mockImplementation((_env, _canister, _entity, offset) =>
    offset === 0
      ? Promise.resolve(rowsFixture("DemoRow", ["id", "handle"], 100))
      : Promise.reject({ kind: "backend", explanation: "E9: the replica rejected the query" }),
  );

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("DemoRow"));
  expect(await screen.findByText("id-0")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /load more/i }));

  expect(await screen.findByText(/E9: the replica rejected the query/)).toBeInTheDocument();
  // The page the reader was looking at is still there — first row, last row, and
  // the header — beside the banner rather than replaced by it.
  expect(screen.getByText("id-0")).toBeInTheDocument();
  expect(screen.getByText("id-99")).toBeInTheDocument();
  expect(screen.getByText("handle")).toBeInTheDocument();
});

/// Keeping the grid mounted across a fetch — which is what gives `loading` a
/// call site — means its expansion state now survives one. Phase 2a added
/// identity-based invalidation in `RowGrid` for exactly this moment; this is
/// the test that it actually fires when driven through the real app, rather
/// than only through `RowGrid`'s own props.
///
/// Both entities have two columns on purpose. A stale `{row: 0, column: 1}`
/// would still be *in range* for the new entity, so it would render a sub-row
/// against the wrong data rather than being silently swallowed by
/// `ExpandableRow`'s defensive out-of-range guard — which is what makes this
/// discriminate the entity half of the identity and not just the arity.
test("switching tables with a cell expanded clears the expansion", async () => {
  const longA = `A${"x".repeat(60)}`;
  const longB = `B${"y".repeat(60)}`;

  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow", 2), entity("OtherRow", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "DemoRow",
    columns: [],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockImplementation((_env, _canister, entityName) =>
    Promise.resolve({
      type: "rows",
      entity: entityName,
      columns: ["id", "payload"],
      rows: [
        [
          { kind: "ulid", display: entityName === "DemoRow" ? "u-1" : "u-2" },
          { kind: "text", display: entityName === "DemoRow" ? longA : longB },
        ],
      ],
      rowCount: 1,
      nextCursor: null,
    }),
  );

  render(<App />);
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("DemoRow"));

  fireEvent.click(await screen.findByRole("button", { name: "Expand payload" }));
  expect(screen.getByRole("button", { name: "Collapse payload" })).toBeInTheDocument();

  fireEvent.click(screen.getByText("OtherRow"));
  await screen.findByText(longB);

  // Invalidated, not carried over: the new table's cell is collapsed, and no
  // sub-row is showing the new entity's value under an old table's expansion.
  expect(await screen.findByRole("button", { name: "Expand payload" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Collapse payload" })).not.toBeInTheDocument();
  expect(screen.getAllByText(longB)).toHaveLength(1);
});

/// The SQL bar is a bar, not a fifth pane: closed it is one row with a button,
/// open it holds the console and its result. Click to open, close button to
/// close — no keyboard shortcut, that is phase 3.
test("the SQL bar starts closed, opens on click, and closes again", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  render(<App />);

  const open = await screen.findByRole("button", { name: "SQL" });
  expect(open).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

  fireEvent.click(open);
  expect(screen.getByRole("textbox")).toBeInTheDocument();

  const close = screen.getByRole("button", { name: /close sql/i });
  expect(close).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(close);

  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "SQL" })).toBeInTheDocument();
});

/** Every element in the rendered tree that scrolls its own overflow. */
function scrollRegions(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      ".overflow-auto, .overflow-y-auto, .overflow-scroll",
    ),
  ];
}

/** Every element on some scroll region's ancestor chain that is a flex item in a
 *  COLUMN container and cannot shrink — see the test below for what that means
 *  and why `shrink-0` counts only on a scroll region itself. Returned as class
 *  lists so a failure names the offender instead of just counting it. */
function unshrinkableAncestors(): string[] {
  const offenders: string[] = [];
  for (const scroller of scrollRegions()) {
    for (let node: HTMLElement | null = scroller; node && node !== document.body; ) {
      // Annotated rather than inferred: `node` is reassigned from `parent` at the
      // bottom of the loop, so leaving this to inference makes the two types
      // depend on each other and `tsc` reports TS7022 (`vitest` alone does not).
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      const inColumn = parent.classList.contains("flex-col");
      const isFlexItem = parent.classList.contains("flex");
      const exempt =
        node.classList.contains("min-h-0") ||
        (node === scroller && node.classList.contains("shrink-0"));
      if (isFlexItem && inColumn && !exempt) {
        offenders.push(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`);
      }
      node = parent;
    }
  }
  return offenders;
}

/// A flex item's default `min-height: auto` refuses to shrink below its content,
/// so a scroll region whose column-flex ancestors lack `min-h-0` makes its pane
/// grow instead of scrolling. Phase 2b measured that in a browser (an 800px page
/// becoming 11312px, with nothing scrolling) and left it unguarded because jsdom
/// has no layout engine.
///
/// It does not need one: the requirement is structural. Walk up from each scroll
/// region and assert every column-flex ancestor on its chain carries `min-h-0`.
/// This is the real property, not a proxy for it.
///
/// `shrink-0` is accepted only on a scroll region ITSELF, never on an ancestor of
/// one. The distinction is the whole point: an element that owns its own bound
/// (the banner region below is `max-h-[40vh] shrink-0 overflow-auto` — capped by
/// the `max-h`, scrolling because of the `overflow`, and `shrink-0` so tight
/// vertical space squeezes the pane shell instead of it) is legitimately
/// unshrinkable. An intermediate ancestor is not: it has no bound of its own, so
/// refusing to shrink is exactly how it grows to its content height and stops its
/// descendant scroller from ever scrolling. Accepting `shrink-0` everywhere made
/// this walk blind to precisely the bug it describes — swapping the open SQL
/// bar's `min-h-0` for `shrink-0` left it reporting zero offenders while the bar
/// grew past its `basis-1/3` on a tall result.
///
/// `Pane`'s own `<section>` is deliberately exempt and must stay that way: it is a
/// flex item in a ROW container, where per CSS Flexbox §4.5 the automatic minimum
/// applies only on the main axis — so `min-width` binds (covered by its `min-w-0`)
/// and `min-height: auto` computes to 0. That is why the walk tests the PARENT's
/// direction rather than blindly demanding `min-h-0` on every ancestor.
test("every scroll region can actually shrink: its column-flex ancestors carry min-h-0", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "aaaaa-aa", role: "canister-a", children: [] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("DemoRow", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "DemoRow",
    columns: [{ name: "id", typeName: "Ulid", primaryKey: true, optional: false }],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockResolvedValue(rowsFixture("DemoRow", ["a", "b"], 1));

  render(<App />);

  // Mount every pane's scroll region at once: a canister and a table selected
  // (so Rows and Schema populate) and the SQL bar opened — it starts closed.
  // The schema pane is expanded by default (`schemaCollapsed` is false unless
  // something set it), so no click is needed to reach its scroll region.
  fireEvent.click(await screen.findByText("canister-a"));
  fireEvent.click(await screen.findByText("DemoRow"));
  await screen.findByText("a-0");
  fireEvent.click(screen.getByRole("button", { name: "SQL" }));
  expect(screen.getByRole("textbox")).toBeInTheDocument();

  const scrollers = scrollRegions();

  // Canisters, Tables, Rows, and Schema each own exactly one scroll region
  // (`Pane`'s own invariant, see `Pane.test.tsx`), plus the SQL bar's own —
  // five in total. A lower count would mean some pane failed to mount and
  // this walk is weaker than it looks.
  //
  // Counted excluding the banner region, which also carries `overflow-auto` but
  // is not a pane's. It is absent from this fixture (nothing here warns or
  // errors), so the count would happen to be right today — and would turn into a
  // baffling `6 !== 5` inside a test about `min-h-0` the moment a future fixture
  // surfaced a warning here. Excluded by its `data-banner-region` marker so the
  // number keeps meaning "every pane mounted its scroll region". The walk below
  // still covers it.
  const paneScrollers = scrollers.filter((node) => !node.matches("[data-banner-region]"));
  expect(paneScrollers.length).toBe(5);

  expect(unshrinkableAncestors()).toEqual([]);
});

test("the settings gear offers theme choices from the header", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([]);

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /settings/i }));

  expect(screen.getByRole("menuitemradio", { name: /terminal/i })).toBeInTheDocument();
});

/// Capability marks are decoration on top of the tree and must never gate it.
/// This started as a real defect: probing ran inside the handler that set the
/// forest, so a probe that threw took the whole fleet pane down with it. A
/// metadata read failing must not cost the user their navigation.
test("a failing capability probe still leaves the fleet navigable", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "root-id", role: "root", children: [{ pid: "aaaaa-aa", role: "project_hub", children: [] }] },
  ]);
  vi.mocked(commands.sqlCapabilities).mockRejectedValue(
    { kind: "agent", explanation: "metadata unavailable" },
  );

  render(<App />);

  expect(await screen.findByText("project_hub")).toBeInTheDocument();
  // Unmarked, because unknown is not the same as "has nothing".
  expect(screen.queryByText(/no tables/)).not.toBeInTheDocument();
});

/// Export saves the page in hand rather than re-querying, and writes only what
/// the reader can already see.
test("exporting writes the rows on screen to the chosen path", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "root-id", role: "root", children: [{ pid: "aaaaa-aa", role: "hub", children: [] }] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("User", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "User",
    columns: [],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockResolvedValue(rowsFixture("User", ["id", "handle"], 1));
  dialogSave.mockResolvedValue("/tmp/User.csv");

  render(<App />);
  fireEvent.click(await screen.findByText("hub"));
  fireEvent.click(await screen.findByText("User"));
  // Counted before the click, because mock calls accumulate across this file.
  const fetchesBeforeExport = vi.mocked(commands.fetchRows).mock.calls.length;
  fireEvent.click(await screen.findByRole("button", { name: /export csv/i }));

  await waitFor(() => expect(vi.mocked(commands.writeExport)).toHaveBeenCalled());
  const [path, contents] = vi.mocked(commands.writeExport).mock.calls[0];
  expect(path).toBe("/tmp/User.csv");
  expect(contents).toContain("id,handle");
  // No further fetch: export uses the page already in hand.
  expect(vi.mocked(commands.fetchRows).mock.calls.length).toBe(fetchesBeforeExport);
});

/// Cancelling the save dialog is an ordinary outcome, not a failure — nothing
/// should be written and no error shown.
test("cancelling the save dialog writes nothing", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue({
    root: "/Users/me/projects/toko",
    environments: [environmentFixture()],
    error: null,
  });
  vi.mocked(commands.canisterTree).mockResolvedValue([
    { pid: "root-id", role: "root", children: [{ pid: "aaaaa-aa", role: "hub", children: [] }] },
  ]);
  vi.mocked(commands.listTables).mockResolvedValue({
    type: "entities",
    entities: [entity("User", 2)],
  });
  vi.mocked(commands.describeTable).mockResolvedValue({
    type: "schema",
    entity: "User",
    columns: [],
    indexes: [],
  });
  vi.mocked(commands.fetchRows).mockResolvedValue(rowsFixture("User", ["id", "handle"], 1));
  dialogSave.mockResolvedValue(null);
  const writesBeforeCancel = vi.mocked(commands.writeExport).mock.calls.length;

  render(<App />);
  fireEvent.click(await screen.findByText("hub"));
  fireEvent.click(await screen.findByText("User"));
  fireEvent.click(await screen.findByRole("button", { name: /export json/i }));

  await waitFor(() => expect(dialogSave).toHaveBeenCalled());
  expect(vi.mocked(commands.writeExport).mock.calls.length).toBe(writesBeforeCancel);
});
