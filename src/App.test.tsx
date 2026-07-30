import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import * as commands from "./api/commands";
import type { EntityDto, IdentityRef, ResultDto, TreeNode } from "./api/types";

vi.mock("./api/commands");

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

function entity(name: string): EntityDto {
  return { name, storePath: "", storage: "stable", columns: 1, indexes: 0, relations: 0, schemaVersion: 1 };
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
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "SHOW CONSTRAINTS FROM demo_row" },
  });
  fireEvent.click(screen.getByRole("button", { name: /run/i }));

  expect(await screen.findByText("demo_row_pk")).toBeDefined();
  expect(screen.getByText(/primary_key/)).toBeDefined();
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
