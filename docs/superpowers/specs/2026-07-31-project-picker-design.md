# Project picker — Design

**Date:** 2026-07-31
**Status:** Approved
**Follows:** `2026-07-30-icp-identity-design.md`

## Corrections found during implementation

This is a historical design record; the corrections below are recorded in place rather
than silently rewritten. Three corrections of substance, beyond the error-table merge
noted further down:

- **The `AgentPool` cache key does include the project root, and the pool is still
  cleared on switch.** The original "Decisions" table listed these as alternatives and
  rejected the key. Implementation found them to be complements, not alternatives — see
  the corrected row below and "The load-bearing correctness point".
- **`ProjectState` wraps `std::sync::Mutex<Option<Project>>`, not `Mutex<Project>`.**
  The `Option` represents "no project open" as a real state; `std::sync::Mutex` (not
  tokio's) makes the never-hold-a-lock-across-`.await` rule compiler-enforced. See
  "Architecture" below.
- **The lock invariant is pinned by a compile-time `Send` assertion in the test, not by
  the test's own `.await`.** See "Architecture" below.

## Purpose

Let the user choose which icp project to explore from inside the app, instead of
inheriting the process's working directory at launch.

## The gap this closes

`src-tauri/src/lib.rs:27` reads:

```rust
let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
```

The project root is the launch directory, resolved once, stored in immutable Tauri
managed state. Three consequences:

1. The only way to explore a different project is to quit, `cd`, and relaunch.
2. A packaged `.app` is effectively broken for this: a bundled app's working
   directory is typically `/`, so discovery finds nothing and every pane is empty.
3. The identity work made identity selectable at runtime while the project — the
   more fundamental choice — stayed fixed at startup.

The picker is what makes the explorer a distributable app rather than a tool you run
from a project directory.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Launch behaviour | Re-discover the last chosen folder; first run shows an explicit empty state with the picker | Makes a packaged build work, and removes `current_dir()` as a source of truth entirely |
| Projects open at once | One | No tabs, no workspace. Switching replaces. |
| Folder with no `.icp/` | Walk up to find one; if none, adopt the picked folder anyway and render the existing explicit empty state | Forgiving of picking `src/`; never silently rejects; preserves today's deliberate support for a project not yet deployed |
| Upward walk bound | The **ancestor** walk stops before `$HOME` and before `/`; the picked directory itself is always a candidate | `~/.icp` and `/.icp` would be config locations, not projects. Without the bound, one home-level `.icp` makes every folder in `$HOME` look like a project. Bounding only ancestors means explicitly picking `$HOME` still works. |
| Where the dialog lives | Frontend (`@tauri-apps/plugin-dialog`), passing a path to a Rust command | Keeps `select_project` a pure "adopt this path" function with no dialog in its test path |
| Pool on switch | Cleared, but not the whole fix — see "The load-bearing correctness point" | Retention hygiene: stops holding agents, and the private key material inside them, for projects the user has left |
| Project root in the `AgentPool` cache key | Included, alongside clearing the pool on every switch | Correctness — see "The load-bearing correctness point" below |
| Rejected: cwd as a fallback when nothing is persisted | — | Two sources of truth for "which project", with a precedence rule to explain and test, to preserve a behaviour the empty state already covers |

**Corrected — the "project root in the cache key" row above previously read "Rejected,"
on the reasoning that clearing the pool on switch already handled invalidation and
adding the root to the key only cost retention hygiene by keeping it out. Implementation
found clearing insufficient on its own (see below), so the shipped code does both: the
root is in the key, and the pool is still cleared. They are complements, not
alternatives — a reader who removed the root from the key on the strength of the
original row would reintroduce the exact bug it exists to prevent.**

## The load-bearing correctness point

**Corrected — this section originally said `AgentPool` gains `clear()` and that this is
what prevents stale agents from a previous project being served. Implementation found
clearing alone insufficient; the actual mechanism is below.**

`AgentPool` is keyed `(environment name, identity name, project root)`
(`src-tauri/src/agent/mod.rs`, `cache_key`). Two projects both having a `local`
environment with a `default` identity is the **normal** case, not an edge case.

Without a project-scoped key, switching from project A to project B and querying
`local` could reuse A's cached agent — pointed at **A's replica URL** — and render B's
canister ids against A's replica. Wrong data, shown confidently: the failure class this
project has hit repeatedly (see the `.icp/` layout Critical in
`2026-07-29-icydb-explorer-design.md`'s history, and the `AgentPool` keying note in
`2026-07-30-icp-identity-design.md`).

**Clearing the pool alone does not fix this.** Every command takes a
`ProjectState::snapshot()` and *then* awaits network calls, so a command that began
before a project switch can finish after it:

1. The frontend invokes a command against env `local`; it snapshots project **A**, then
   awaits.
2. The user picks project **B**. `select_project` clears the pool, then replaces the
   state.
3. The in-flight command resumes, misses the now-empty cache, and builds an agent for
   **A's replica URL** — inserting it under `("local", "default")` *after* the clear
   already ran.
4. The next query for **B** in env `local` hits that entry and runs B's canister ids
   against A's replica.

The fix is the project root as a third component of the cache key, derived from each
command's own snapshot, so the agent and the canister ids it queries always come from
one consistent project view — a late insert from project A lands under A's key, which
project B never looks up. `clear()` still runs on every successful switch (a test
asserts the map is empty afterwards), but it is retention hygiene, not correctness: it
stops the pool holding agents — and the private key material inside them — for projects
the user has walked away from.

## What does not change

The `view/` icydb boundary, the read-only guarantee (query calls only), the ic-agent
transport, the DTO contract, `discovery::discover`'s signature, and identity
selection. This makes one already-parameterised thing re-settable at runtime.

## Architecture

### `ProjectState` — mutable project state

**Corrected — this block originally showed `pub struct ProjectState(Mutex<Project>)`
with `snapshot`/`replace` returning/taking a bare `Project`, and said "all eight
commands change." Shipped: `Mutex<Option<Project>>` using `std::sync::Mutex`
specifically (not `tokio::sync::Mutex`), and seven commands change, not eight —
`select_project` is a new command, not one of the ones rewired.**

A new wrapper replacing `Project` as the managed state:

```rust
pub struct ProjectState(std::sync::Mutex<Option<Project>>);

impl ProjectState {
    pub fn snapshot(&self) -> Option<Project>;   // clones under the lock, releases it
    pub fn replace(&self, project: Project);
}
```

The `Option` is load-bearing: it is how "no project open" is represented — first
launch, or a remembered root that has since been moved or deleted — rather than a
fabricated empty `Project`.

`std::sync::Mutex`, not `tokio`'s, for two reasons. First, and most important: a
`std::sync::MutexGuard` is `!Send`, which makes the never-hold-a-lock-across-`.await`
rule *compiler-enforced* rather than a convention a reader has to honour. Second, it
keeps `snapshot`/`replace` synchronous, which keeps `list_environments` a plain `fn`:
Tauri's macro rejects an `async` command that takes a lifetime-bearing parameter such as
`State<'_, T>` and does not return `Result`
(`tauri-macros-2.6.3/src/command/wrapper.rs:176`, upstream issue #2533), so an async
`snapshot` would force `list_environments` to return a `Result` that can never actually
be `Err` purely to satisfy the macro.

Seven commands change `project: State<'_, Project>` to
`project: State<'_, ProjectState>` plus one `let project = project.snapshot();` line —
`list_environments`, `select_identity`, `canister_tree`, `list_tables`,
`describe_table`, `fetch_rows`, `run_sql`. `select_project` is new in this feature
rather than one of these seven. `find_environment(&project, ..)` and everything
downstream are untouched.

**The lock is never held across an `.await`.** That is the entire reason `snapshot`
clones instead of returning a guard. This project already shipped that bug once, in
`AgentPool::get` holding a pool-wide lock across a 20-second subprocess. The invariant
is pinned at *compile time*, not merely stated in a comment: the test contains an
explicit `fn requires_send<T: Send>(_: &T) {}` assertion, which a
`std::sync::MutexGuard` cannot satisfy — a guard-returning `snapshot` would fail to
compile, regardless of what the test's own runtime assertions check. (Holding a value across the
test's own `.await` does not by itself prove anything: `#[tokio::test]` runs on
`block_on`, which imposes no `Send` bound on its future, so that `.await` alone would
let a `!Send` guard ride along unnoticed. The `requires_send` assertion is what actually
pins it.)

### `discovery::resolve_root` — a pure function

```rust
pub fn resolve_root(picked: &Path, home: Option<&Path>) -> PathBuf
```

Returns the first of `picked` and its ancestors that contains a `.icp/` directory.

`picked` itself is **always** the first candidate, whatever it is. The bound applies to
the *ancestor* walk only: `home` and the filesystem root are never examined as
ancestors. So a home-level `.icp` cannot make every folder under `$HOME` resolve to
`$HOME`, while a project stored directly at `$HOME` is still found when picked exactly.

Finding nothing returns `picked` unchanged, so the caller lands in the existing explicit
"no `.icp/` here" state.

`home` is a parameter rather than an environment read, so the function is table-testable
against temporary directories with no global state.

### Persistence — one file, never fatal

`<app config dir>/project.json`:

```json
{ "root": "/Users/you/projects/thing" }
```

Located via Tauri's own `app_config_dir()` — no new dependency. Read at launch, written
on each successful switch. The stored value is the **already-resolved** root, so launch
runs `discover()` directly and does not re-walk upward.

Every failure mode is non-fatal:

| Failure | Result |
|---|---|
| File missing | First run — empty state with the picker |
| Unreadable or corrupt JSON | Treated as first run; not surfaced as an error |
| Recorded path no longer exists | Treated as first run |
| Write fails on switch | The switch still succeeds for this session, reported through `ProjectSelection.persist_warning` (below) rather than swallowed |

The chosen root is persisted **even when it holds no `.icp/`**. The user asked for that
folder; silently reverting to a different project on next launch is the more surprising
behaviour.

### `select_project` — the new command

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSelection {
    pub project: Project,
    /// `Some` when the root was adopted but could not be remembered for next
    /// launch. Never a reason to fail the switch.
    pub persist_warning: Option<String>,
}

#[tauri::command]
pub async fn select_project(
    path: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
    app: AppHandle,
) -> Result<ProjectSelection, AppError>
```

In order: pre-flight the path, resolve the root, discover, clear the pool, replace the
state, attempt to persist, return the new `Project` alongside any persist warning.

The wrapper exists for one reason: a config-write failure has nowhere to go in a bare
`Project`, and reusing `Project.error` for it would render a *storage* problem as a
*discovery* problem in the same banner. `ProjectSelection.project` is still a plain
`Project`, so `adoptProject` — shared with launch — takes exactly the type
`list_environments` returns and the two paths still cannot diverge.

### Frontend

- **`ProjectSelector.tsx`** — a button at the left end of the existing header, beside
  the environment and identity selectors, since "which project" sits above "which
  environment" exactly as identity does. Shows the root's **basename**, with the full
  absolute path as its `title`. Disabled while a switch is in flight.
- **Empty state** — with no project loaded, one centred panel: "Choose a project to
  explore", the picker button, and one line saying it is looking for a directory
  containing `.icp/`. Not three blank panes. A vanished persisted path lands here too.
- **`adoptProject(project)`** — the mount effect's body, extracted. Sets environments,
  the discovery error, the initial environment and the initial identity, and clears
  canister, entity, schema, rows, and SQL state. Launch and switch both call it, so
  they cannot drift — the same reasoning that makes `resolve_identity_store` a single
  function in `discovery`.
- **Cancelling the dialog is a no-op.** `open()` returns `null`; nothing is called,
  nothing changes, no error is shown.

### New dependencies

`tauri-plugin-dialog` (Rust) and `@tauri-apps/plugin-dialog` (JS), both first-party,
plus a capability entry in `src-tauri/capabilities/default.json`. A native folder
dialog has no viable in-webview substitute: `<input webkitdirectory>` yields a file
list, not a directory path.

## Error handling

| Condition | Behaviour |
|---|---|
| Dialog cancelled | Nothing happens |
| Path missing, or not a directory | `Err(AppError::Io)` naming the path. **The previous project stays loaded** — nothing was adopted, the pool is untouched. |
| No `.icp/` anywhere up the tree, or `discover()` failed reading one | `Ok(Project { error: Some(..) })` — adopted, with the failure rendered explicitly. These are one path: `discover()` returns `Err` when `<root>/.icp` is not a directory, and both cases use the same fallback `lib.rs` already uses at launch. |
| Config file unwritable | Switch succeeds for this session; `persistWarning` is set and shown as a dismissible note, distinct from the error banner |

The spec originally separated these; implementation found them to be the same code path, and one path rendering one explanation is the better behaviour.

All errors follow the established pattern: `AppError` variants with purpose-written
`explanation()` text, surfaced through `ErrorBanner`. No new user-facing copy may claim
the app enforces read-only access as a security boundary.

## Testing

| Scope | Approach |
|---|---|
| `resolve_root` | Table tests over real temp directories: `.icp/` in the picked dir, in the parent, in the grandparent, nowhere at all; a `.icp` in the fake `$HOME` is **not** adopted when picking a descendant; the *same* `.icp` **is** adopted when `$HOME` is picked exactly; `home = None` still stops before the filesystem root |
| Persistence | Round-trip write/read; missing file → `None`; corrupt JSON → `None`, not an error; recorded path no longer exists → treated as first run |
| `ProjectState` | `snapshot`/`replace`; a `tokio::test` asserting a snapshot held across an `.await` does not block a second snapshot — the lock invariant tested, not merely commented |
| `AgentPool::clear` | Insert two agents into the map from the in-module test, clear, assert empty |
| `select_project` helpers | The pure parts — root resolution, config read/write, the not-a-directory pre-flight — tested without Tauri `State`, matching how `commands.rs` tests its existing helpers |
| Frontend | Empty state renders the picker; a successful pick re-renders environments; cancel changes nothing; an embedded discovery error shows the banner; a `persistWarning` shows the note and *not* the error banner; switching clears the canister and entity selection |

Temp-directory fixtures must mirror the real `.icp/` layout. The prior phase's Critical
finding came from a fixture authored to match the code's assumptions.

## Out of scope

Multiple projects open at once, a recent-projects list, watching `.icp/` for changes, a
manual re-scan button, and remembering the selected environment or identity per project.
Each is a plausible follow-up; none is needed to close this gap.

## Known risks

- **A stale persisted path is indistinguishable from a first run.** Deliberate: the
  alternative is an error banner on every launch after moving a directory. The empty
  state names no path, so nothing misleading is shown.
- **`clear()` on switch discards warm agents for the project being left**, so switching
  back re-exports keyring identities and may re-prompt the Keychain. Accepted: the
  alternative retains private key material for projects the user has left.
- **The upward walk's `$HOME` bound is a heuristic.** A project stored directly at
  `$HOME` cannot be reached by walking up from a subdirectory; it must be picked exactly.
  That works, because the picked directory is always the first candidate — the bound
  excludes `$HOME` only as an *ancestor*.
