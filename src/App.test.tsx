import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import * as commands from "./api/commands";
import type { EntityDto, ResultDto, TreeNode } from "./api/types";

vi.mock("./api/commands");

// A resolve-on-demand promise so the test controls exactly when each
// `listTables` call settles, independent of call order.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function entity(name: string): EntityDto {
  return { name, storePath: "", storage: "stable", columns: 1, indexes: 0, relations: 0, schemaVersion: 1 };
}

test("a stale canister's tables never overwrite a newer selection", async () => {
  const tree: TreeNode = {
    pid: "root-id",
    role: "root",
    children: [
      { pid: "aaaaa-aa", role: "canister-a", children: [] },
      { pid: "bbbbb-bb", role: "canister-b", children: [] },
    ],
  };

  vi.mocked(commands.listEnvironments).mockResolvedValue([
    { name: "local", replicaUrl: "http://localhost", rootCanisterId: "root-id", identity: null, artifacts: [] },
  ]);
  vi.mocked(commands.canisterTree).mockResolvedValue(tree);

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
