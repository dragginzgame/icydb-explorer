# Project picker — Design

**Date:** 2026-07-31
**Status:** Approved
**Follows:** `2026-07-30-icp-identity-design.md`

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
| Pool on switch | Cleared | See "The load-bearing correctness point" |
| Rejected: project root in the `AgentPool` cache key | — | Fixes correctness but keeps agents, and exported private key material, cached for projects the user has left |
| Rejected: cwd as a fallback when nothing is persisted | — | Two sources of truth for "which project", with a precedence rule to explain and test, to preserve a behaviour the empty state already covers |

## The load-bearing correctness point

`AgentPool` is keyed `(environment name, identity name)`. Two projects both having a
`local` environment with a `default` identity is the **normal** case, not an edge
case.

Without invalidation, switching from project A to project B and querying `local`
reuses A's cached agent — pointed at **A's replica URL** — and renders B's canister
ids against A's replica. Wrong data, shown confidently: the failure class this
project has hit repeatedly (see the `.icp/` layout Critical in
`2026-07-29-icydb-explorer-design.md`'s history, and the `AgentPool` keying note in
`2026-07-30-icp-identity-design.md`).

So `AgentPool` gains `clear()`, called on every successful project switch, and a test
asserts the map is empty afterwards.

## What does not change

The `view/` icydb boundary, the read-only guarantee (query calls only), the ic-agent
transport, the DTO contract, `discovery::discover`'s signature, and identity
selection. This makes one already-parameterised thing re-settable at runtime.

## Architecture

### `ProjectState` — mutable project state

A new wrapper replacing `Project` as the managed state:

```rust
pub struct ProjectState(Mutex<Project>);

impl ProjectState {
    pub fn snapshot(&self) -> Project;   // clones under the lock, releases it
    pub fn replace(&self, project: Project);
}
```

All eight commands change `project: State<'_, Project>` to
`project: State<'_, ProjectState>` plus one `let project = project.snapshot();` line.
`find_environment(&project, ..)` and everything downstream are untouched.

**The lock is never held across an `.await`.** That is the entire reason `snapshot`
clones instead of returning a guard. This project already shipped that bug once, in
`AgentPool::get` holding a pool-wide lock across a 20-second subprocess; the invariant
is stated in a comment and covered by a test rather than left to a reader's goodwill.

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
| No `.icp/` anywhere up the tree | `Ok(Project)` with no environments — adopted, existing explicit empty state renders |
| `discover()` failed reading `.icp/` | `Ok(Project { error: Some(..) })` — the shape `list_environments` already returns, rendered through the identical path |
| Config file unwritable | Switch succeeds for this session; `persistWarning` is set and shown as a dismissible note, distinct from the error banner |

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
