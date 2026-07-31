# Project picker — parked follow-ups

**Date:** 2026-07-31
**Branch:** `feat/project-picker`
**Spec:** `docs/superpowers/specs/2026-07-31-project-picker-design.md`
**Plan:** `docs/superpowers/plans/2026-07-31-project-picker.md`

Recorded here because the phase's SDD workspace is deleted at completion and
these should outlive it. Every item below was found by a review, triaged as
may-ship, and deliberately not fixed. None blocks the feature.

## From the final whole-branch review's re-review

1. **Dangling cross-reference in a comment.** `src-tauri/src/project/config.rs`
   says "see this module's finding notes", which matches nothing in the repo —
   a pointer to a document that does not exist. One-line fix: either delete the
   clause or point it here.
2. **That same comment omits the reassuring half.** It records that
   `root.display().to_string()` is lossy for non-UTF-8 paths and why that is not
   fixed, but not the consequence: because `read_recorded_root` rejects a path
   that is not an existing directory, a lossily-written root degrades to "not
   remembered" and the app lands on the empty state. It can never open the
   *wrong* project. Saying so would make the limitation defensible on its face
   rather than merely acknowledged.

## Correctness, bounded and understood

3. **Re-selecting the same root after editing its `.icp/` can serve a stale
   agent.** The pool key is `(root, env, identity)`, which distinguishes
   projects but not project *versions*. If a query is in flight, the user edits
   `.icp` so `local` points at a different port, and re-picks the same root,
   the in-flight command can insert an agent for the old URL under a key the new
   snapshot also uses. Usually surfaces as `ReplicaUnreachable`; with both
   replicas running it is wrong data. Closing it needs a generation counter in
   the cache key — the same trick `App.tsx`'s `projectGeneration` uses for the
   canister tree. Out of scope for the feature's stated property (distinct
   projects), and the recourse today is to relaunch.
4. **`cache_key`'s root encoding is injective; `project.json`'s is not.**
   `agent/mod.rs` hex-encodes `as_encoded_bytes()`, so two roots differing only
   in invalid UTF-8 produce distinct keys. The persistence layer still writes
   `display().to_string()` — see items 1-2. Fixing it faithfully would change
   `project.json`'s on-disk shape, which was explicitly out of scope.

## Platform

5. **Windows is unsupported in practice, and now says so.** Home-directory
   resolution reads only `HOME` (`commands.rs`), normally unset on Windows, so
   `resolve_root`'s ancestor bound would be inert there — a `.icp` at
   `C:\Users\me` would be adopted for every folder beneath it. The identity
   store lookup at `discovery/icp_dir.rs:405` has the same `HOME`-only
   assumption, so making one half work would be misleading. `resolve_root`'s doc
   comment and the README were corrected to state the bound conditionally rather
   than the code being changed. If Windows support is ever wanted, both reads
   need `%USERPROFILE%` together.

## Ergonomics

6. **`ProjectSelector` has no `.catch` on `open()`.** A dialog rejection (OS
   failure, or a capability regression) becomes an unhandled promise rejection
   with no user feedback — the button just appears inert. `busy` is not set by
   `choose()`, so nothing hangs. Reporting it needs an error channel the
   component does not have; an `onError` prop is the obvious shape, and can be
   added now that Task 6 has shipped and the interface is no longer in flight.
7. **Switching identity still discards the canister and entity selection.**
   Pre-existing, carried over from the identity phase's follow-up list
   (`2026-07-30-icydb-author-review.md`, item 5). Canister ids do not depend on
   identity, so re-fetching the tree while preserving the selection would be
   kinder. Note the new `projectGeneration` counter is *not* the mechanism for
   this — identity changes already re-run the forest effect.
8. **`SqlConsole`'s typed query text survives a project switch.** Judged not a
   defect: it is user-typed input rather than project-derived data, and
   `handleRunSql` guards on the current env/canister/identity. Worth knowing if
   it ever reads as surprising.

## Housekeeping

9. **Duplicated `scratch(name)` test helper** in `project/config.rs` and
   `lib.rs` (14 lines, the second acknowledging the duplication). Acceptable;
   a shared test-support module would be the fix if a third copy appears.
10. **`discovery/types.rs` names `lib.rs`'s `discover_project()`**, which this
    branch renamed to `recorded_project`. Phrased as history ("used to fall
    back…"), and the function did exist under that name at the branch point, so
    two reviewers split on whether it needs touching.
11. **Pre-existing `cargo fmt --check` drift in seven files** —
    `agent/export.rs`, `agent/identity.rs`, `commands.rs`,
    `discovery/icp_dir.rs`, `discovery/types.rs`, `view/mod.rs`,
    `tests/integration.rs`. Predates this branch (the three diffs this branch
    *did* introduce were fixed). No CI gates formatting. A single
    `cargo fmt` commit would clear it, kept separate so it never mixes with
    behavioural review.

## Still-absent test infrastructure

Unchanged from earlier phases, and the reason 9 tests stay `#[ignore]`d: a
local replica with the fixture canister installed, a second fixture built with
`ICYDB_BUILD_TARGET=ic` and deployed detached, and a running toko replica.
