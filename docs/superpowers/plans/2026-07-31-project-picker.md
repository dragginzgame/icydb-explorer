# Project Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which icp project to explore from inside the app, replacing the startup-only `current_dir()` discovery, and remember that choice across launches.

**Architecture:** The project root stops being a startup constant and becomes mutable, optional Tauri managed state (`ProjectState(Mutex<Option<Project>>)`). A new `select_project` command resolves a picked path up to the nearest `.icp/`, re-runs the existing `discovery::discover`, clears the `AgentPool` (whose `(environment, identity)` key is not unique across projects), swaps the state, and persists the root. The frontend opens a native folder dialog via `tauri-plugin-dialog` and adopts the returned project through the same code path launch uses.

**Tech Stack:** Rust 1.96.0, Tauri 2 (`tauri` 2.11.5), `tauri-plugin-dialog` 2.7.2, `tokio::sync::Mutex`, React 19 + TypeScript, `@tauri-apps/plugin-dialog` 2.7.2, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-project-picker-design.md` — read it before Task 1.

## Global Constraints

- **Read-only guarantee is untouched.** The app calls only `icydb_query` via `agent.query`. This plan adds no network call sites. No user-facing copy may claim the app enforces read-only access as a security boundary.
- **Never hold a lock across an `.await`.** `ProjectState::snapshot` clones and releases; a `MutexGuard` must never be alive at an `await` point. This project already shipped that bug once in `AgentPool::get`.
- **Never print, log, or embed private key material in an error.** Unchanged from prior phases; `agent/export.rs` remains the only module handling PEM bytes.
- **No new user-facing sentinel values.** Absent state is `Option`/`null`, never an empty-string root or a fabricated environment. Precedent: `IdentityRef.pem_path` was made `Option<PathBuf>` for exactly this reason.
- **Exact dependency versions:** `tauri-plugin-dialog = "2.7.2"` (Rust), `@tauri-apps/plugin-dialog` `^2.7.2` (JS). Capability permission string is `dialog:allow-open` — least privilege; `dialog:default` would also grant `allow-save` and `allow-message`, which this app does not use.
- **Test fixtures mirror reality.** Filesystem fixtures follow the existing pattern: committed directories under `src-tauri/tests/fixtures/`. A fixture authored to match the code's assumptions caused this project's one Critical finding.
- **Rust MSRV 1.96.0.** Do not use APIs newer than that.
- **`cargo test` from `src-tauri/`, `npm test` from the repo root.** Both suites must be green at every commit. Baseline: 100 backend tests, 25 frontend tests. Final: 120 backend, 36 frontend.

## Spec deviation you must know about

The spec's error table lists "no `.icp/` anywhere up the tree" and "`discover()` failed" as two outcomes. **In the code they are one.** `discovery::discover` at `src-tauri/src/discovery/icp_dir.rs:26-34` returns `Err(AppError::Io(..))` when `<root>/.icp` is not a directory. So both conditions land in the same fallback already used at `src-tauri/src/lib.rs:28`:

```rust
Project { root, environments: Vec::new(), error: Some(error) }
```

Build exactly that one path. Do **not** invent a second branch to distinguish them — the frontend renders `Project.error` explicitly either way, which is the behaviour the spec wanted.

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/discovery/root.rs` *(new)* | `resolve_root` — pure ancestor walk to the nearest `.icp/` |
| `src-tauri/src/discovery/mod.rs` | Re-export `resolve_root` |
| `src-tauri/src/project/mod.rs` *(new)* | `ProjectState` — mutable, optional project state |
| `src-tauri/src/project/config.rs` *(new)* | Read/write the remembered root; every failure non-fatal |
| `src-tauri/src/error.rs` | One new variant: `NoProjectSelected` |
| `src-tauri/src/agent/mod.rs` | `AgentPool::clear` |
| `src-tauri/src/commands.rs` | 7 commands rewired to `ProjectState`; new `select_project` |
| `src-tauri/src/lib.rs` | Startup reads the remembered root; registers the dialog plugin and the new command |
| `src-tauri/capabilities/default.json` | `dialog:allow-open` |
| `src/api/types.ts` | `ProjectSelection`; `Project` now nullable at the boundary |
| `src/api/commands.ts` | `selectProject` wrapper; `listEnvironments` returns `Project \| null` |
| `src/components/ProjectSelector.tsx` *(new)* | The header button + folder dialog |
| `src/App.tsx` | `adoptProject`, the no-project empty state, the persist note |
| `README.md` | Replace "launch from the project directory" with the picker |

---

### Task 1: `resolve_root` — the ancestor walk

**Files:**
- Create: `src-tauri/src/discovery/root.rs`
- Modify: `src-tauri/src/discovery/mod.rs`
- Create fixtures: `src-tauri/tests/fixtures/root_walk/` (see Step 1)

**Interfaces:**
- Consumes: nothing.
- Produces: `discovery::resolve_root(picked: &Path, home: Option<&Path>) -> PathBuf`

**Behaviour, exactly:**
1. `picked` is **always** the first candidate, whatever it is. If `picked/.icp` is a directory, return `picked`.
2. Then walk ancestors. An ancestor is a candidate only if it is **neither** `home` **nor** the filesystem root, and only if the walk has not already passed `home`. Stop as soon as `home` or the filesystem root is reached.
3. Return the first candidate containing a `.icp` directory.
4. If no candidate qualifies, return `picked` unchanged.

Why the bound: `~/.icp` and `/.icp` would be config locations, not projects. Without it, a single home-level `.icp` makes every folder under `$HOME` resolve to `$HOME`. Bounding *ancestors only* means explicitly picking `$HOME` still works.

- [ ] **Step 1: Create the fixture tree**

`.icp` only needs to *be a directory*, so a single tracked file inside suffices. Git does not track empty directories — every otherwise-empty directory below gets a `.keep` file.

```bash
cd src-tauri/tests/fixtures
mkdir -p root_walk/project/.icp/cache
mkdir -p root_walk/project/src/backend
mkdir -p root_walk/home/.icp/cache
mkdir -p root_walk/home/sub/deep
mkdir -p root_walk/bare/sub
touch root_walk/project/.icp/cache/.keep
touch root_walk/project/src/backend/.keep
touch root_walk/home/.icp/cache/.keep
touch root_walk/home/sub/deep/.keep
touch root_walk/bare/sub/.keep
```

Resulting tree, and what each part is for:

```
root_walk/
  project/            .icp/ here  — the "found by walking up" case
    .icp/cache/.keep
    src/backend/.keep             — pick this, expect `project`
  home/               .icp/ here  — stands in for $HOME
    .icp/cache/.keep
    sub/deep/.keep                — pick this with home=home, expect `sub/deep` (unchanged)
  bare/                           — no .icp/ anywhere
    sub/.keep
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/discovery/root.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    const FIXTURES: &str = "tests/fixtures/root_walk";

    fn fixture(relative: &str) -> PathBuf {
        Path::new(FIXTURES).join(relative)
    }

    #[test]
    fn the_picked_directory_is_itself_the_first_candidate() {
        assert_eq!(
            resolve_root(&fixture("project"), None),
            fixture("project")
        );
    }

    #[test]
    fn walks_up_one_level_to_find_the_project() {
        assert_eq!(
            resolve_root(&fixture("project/src"), None),
            fixture("project")
        );
    }

    #[test]
    fn walks_up_two_levels_to_find_the_project() {
        assert_eq!(
            resolve_root(&fixture("project/src/backend"), None),
            fixture("project")
        );
    }

    #[test]
    fn returns_the_picked_path_unchanged_when_no_icp_exists_anywhere() {
        assert_eq!(resolve_root(&fixture("bare/sub"), None), fixture("bare/sub"));
    }

    /// The whole reason `home` is a parameter: a home-level `.icp` must not
    /// make every folder under it resolve to home.
    #[test]
    fn an_icp_in_home_is_not_adopted_when_a_descendant_is_picked() {
        let home = fixture("home");
        assert_eq!(
            resolve_root(&fixture("home/sub/deep"), Some(&home)),
            fixture("home/sub/deep")
        );
    }

    /// The other half of the same rule: the bound excludes home as an
    /// *ancestor*, so picking it exactly still works.
    #[test]
    fn the_same_icp_in_home_is_adopted_when_home_is_picked_exactly() {
        let home = fixture("home");
        assert_eq!(resolve_root(&home, Some(&home)), home);
    }

    /// With no home to stop at, the walk must still stop at the filesystem
    /// root rather than considering `/` a candidate.
    #[test]
    fn the_walk_stops_at_the_filesystem_root_when_home_is_none() {
        // An absolute path guaranteed not to exist, so nothing along it can
        // hold a `.icp`. The assertion that matters is that this returns at
        // all, unchanged, instead of adopting `/`.
        let picked = Path::new("/icydb-explorer-nonexistent/a/b");
        assert_eq!(resolve_root(picked, None), picked.to_path_buf());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test discovery::root`
Expected: FAIL — `cannot find function 'resolve_root' in this scope`.

- [ ] **Step 4: Implement `resolve_root`**

Prepend to `src-tauri/src/discovery/root.rs`, above the test module:

```rust
//! Resolving a user-picked directory to a project root.

use std::path::{Path, PathBuf};

/// Returns the first of `picked` and its ancestors that contains a `.icp`
/// directory, or `picked` unchanged if none does.
///
/// `picked` is **always** the first candidate, whatever it is. The bound
/// applies to the *ancestor* walk only: `home` and the filesystem root are
/// never examined as ancestors, because `~/.icp` and `/.icp` would be
/// config locations rather than projects — without that rule, one
/// home-level `.icp` would make every folder under `$HOME` resolve to
/// `$HOME`. Bounding ancestors only means a project stored directly at
/// `$HOME` is still found when picked exactly.
///
/// `home` is a parameter rather than an environment read so this function
/// is testable against fixture directories with no global state.
///
/// Returning `picked` unchanged on no match is deliberate: the caller then
/// runs `discover()` against it, which fails with a clear
/// `AppError::Io` naming the missing `.icp`, and that failure is what the
/// UI renders. Refusing the pick here would instead make an undeployed
/// project impossible to open, which this app deliberately supports.
pub fn resolve_root(picked: &Path, home: Option<&Path>) -> PathBuf {
    if has_icp(picked) {
        return picked.to_path_buf();
    }

    let mut current = picked;
    while let Some(parent) = current.parent() {
        // The filesystem root is its own parent's end: `parent()` of "/" is
        // None, but "/" itself must never be a candidate, and neither must
        // `home`.
        if parent == Path::new("") || parent.parent().is_none() {
            break;
        }
        if home.is_some_and(|home| parent == home) {
            break;
        }
        if has_icp(parent) {
            return parent.to_path_buf();
        }
        current = parent;
    }

    picked.to_path_buf()
}

fn has_icp(directory: &Path) -> bool {
    directory.join(".icp").is_dir()
}
```

- [ ] **Step 5: Wire the module and re-export**

In `src-tauri/src/discovery/mod.rs`, add `mod root;` beside the existing `mod icp_dir;` / `mod types;`, and add the re-export:

```rust
pub use root::resolve_root;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test discovery::root`
Expected: PASS, 7 tests.

Then run the whole suite: `cd src-tauri && cargo test`
Expected: PASS, 107 tests (100 baseline + 7).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/discovery/root.rs src-tauri/src/discovery/mod.rs src-tauri/tests/fixtures/root_walk
git commit -m "feat: resolve a picked directory to the nearest .icp project root"
```

---

### Task 2: Remembering the chosen root

**Files:**
- Create: `src-tauri/src/project/config.rs`
- Create: `src-tauri/src/project/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod project;` only)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `project::config::read_recorded_root(config_dir: &Path) -> Option<PathBuf>`
  - `project::config::write_recorded_root(config_dir: &Path, root: &Path) -> Result<(), String>`

**Behaviour, exactly:**

`read_recorded_root` returns `None` — never an error — for every one of: missing file, unreadable file, malformed JSON, a `root` that is absent or not a string, and a recorded path that is no longer an existing directory. A remembered project the user has since deleted is indistinguishable from a first run, deliberately: the alternative is an error banner on every launch after moving a directory.

`write_recorded_root` creates `config_dir` if needed and returns `Err(String)` carrying an operator-facing sentence on failure. That string becomes `ProjectSelection.persist_warning` in Task 4 — it is a warning, never a reason to fail a switch.

File format, at `<config_dir>/project.json`:

```json
{ "root": "/Users/you/projects/thing" }
```

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/project/config.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A per-test scratch directory under the system temp dir, named after
    /// the test so two tests can never collide, and cleared on entry so a
    /// previous run's leftovers cannot make a test pass.
    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("icydb-explorer-config-{name}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch dir should be creatable");
        path
    }

    #[test]
    fn a_written_root_reads_back() {
        let dir = scratch("roundtrip");
        let root = dir.join("some-project");
        fs::create_dir_all(&root).expect("root should be creatable");

        write_recorded_root(&dir, &root).expect("write should succeed");

        assert_eq!(read_recorded_root(&dir), Some(root));
    }

    #[test]
    fn writing_creates_the_config_directory_if_it_is_absent() {
        let dir = scratch("creates-dir");
        let nested = dir.join("not-yet-there");
        let root = dir.join("some-project");
        fs::create_dir_all(&root).expect("root should be creatable");

        write_recorded_root(&nested, &root).expect("write should create the directory");

        assert_eq!(read_recorded_root(&nested), Some(root));
    }

    #[test]
    fn a_missing_config_file_is_none_not_an_error() {
        let dir = scratch("missing");
        assert_eq!(read_recorded_root(&dir), None);
    }

    #[test]
    fn malformed_json_is_none_not_an_error() {
        let dir = scratch("malformed");
        fs::write(dir.join("project.json"), "{ this is not json").expect("write should succeed");
        assert_eq!(read_recorded_root(&dir), None);
    }

    #[test]
    fn json_without_a_root_key_is_none() {
        let dir = scratch("no-root-key");
        fs::write(dir.join("project.json"), r#"{"something": "else"}"#)
            .expect("write should succeed");
        assert_eq!(read_recorded_root(&dir), None);
    }

    /// The stale-path case: the user moved or deleted the project. This must
    /// read as a first run, not as an error on every launch.
    #[test]
    fn a_recorded_path_that_no_longer_exists_is_none() {
        let dir = scratch("stale");
        let gone = dir.join("deleted-project");
        fs::create_dir_all(&gone).expect("root should be creatable");
        write_recorded_root(&dir, &gone).expect("write should succeed");
        fs::remove_dir_all(&gone).expect("removal should succeed");

        assert_eq!(read_recorded_root(&dir), None);
    }

    #[test]
    fn a_recorded_path_that_is_a_file_not_a_directory_is_none() {
        let dir = scratch("not-a-dir");
        let file = dir.join("a-file");
        fs::write(&file, "contents").expect("write should succeed");
        write_recorded_root(&dir, &file).expect("write should succeed");

        assert_eq!(read_recorded_root(&dir), None);
    }

    #[test]
    fn a_write_failure_returns_an_explanatory_message() {
        let dir = scratch("unwritable");
        // A *file* where the config directory should be: `create_dir_all`
        // cannot succeed against it, so this exercises the error path
        // without needing permission games that behave differently as root.
        let blocked = dir.join("blocked");
        fs::write(&blocked, "not a directory").expect("write should succeed");

        let error = write_recorded_root(&blocked, &dir).expect_err("write should fail");
        assert!(
            error.contains("project.json") || error.contains(&blocked.display().to_string()),
            "the message should name what could not be written, got: {error}"
        );
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test project::config`
Expected: FAIL — the module isn't declared yet, so this is a compile error naming `read_recorded_root` / `write_recorded_root` as not found.

- [ ] **Step 3: Implement the module**

Prepend to `src-tauri/src/project/config.rs`, above the test module:

```rust
//! Remembering which project the user last chose.
//!
//! Every read failure is `None` and every write failure is a warning: which
//! project to open is a convenience, never something worth refusing to start
//! or refusing to switch over.

use std::fs;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "project.json";

/// The remembered project root, or `None` if there isn't a usable one.
///
/// `None` covers a missing file, an unreadable file, malformed JSON, a
/// missing or non-string `root`, and a recorded path that is no longer an
/// existing directory. All of them mean the same thing to the caller —
/// "start with no project" — and none is worth surfacing: a stale path is
/// what happens when the user moves a directory, and an error banner on
/// every launch afterwards would be worse than silently offering the picker.
pub fn read_recorded_root(config_dir: &Path) -> Option<PathBuf> {
    let contents = fs::read_to_string(config_dir.join(FILE_NAME)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let root = PathBuf::from(parsed.get("root")?.as_str()?);
    root.is_dir().then_some(root)
}

/// Records `root` as the project to open next launch.
///
/// The returned `Err` is an operator-facing sentence, surfaced as a warning
/// beside a switch that has already succeeded — see
/// `commands::select_project`. Failing to remember a choice must never fail
/// the choice itself.
pub fn write_recorded_root(config_dir: &Path, root: &Path) -> Result<(), String> {
    let path = config_dir.join(FILE_NAME);
    fs::create_dir_all(config_dir).map_err(|error| {
        format!(
            "Could not create {} to remember this project: {error}",
            config_dir.display()
        )
    })?;
    let contents = serde_json::json!({ "root": root.display().to_string() });
    fs::write(&path, contents.to_string())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}
```

- [ ] **Step 4: Declare the module**

Create `src-tauri/src/project/mod.rs`:

```rust
//! The currently-open project: which one it is, and remembering it.

pub mod config;
```

In `src-tauri/src/lib.rs`, add `pub mod project;` to the module list at the top, keeping it alphabetical (after `pub mod error;`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test project::config`
Expected: PASS, 8 tests.

Then: `cd src-tauri && cargo test`
Expected: PASS, 115 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/project src-tauri/src/lib.rs
git commit -m "feat: remember the chosen project root across launches"
```

---

### Task 3: Mutable, optional project state

**Files:**
- Modify: `src-tauri/src/project/mod.rs`
- Modify: `src-tauri/src/error.rs` (one new variant, three places)
- Modify: `src-tauri/src/commands.rs` (7 command signatures)
- Modify: `src-tauri/src/lib.rs` (manage `ProjectState`)

**Interfaces:**
- Consumes: `project::config::read_recorded_root` (Task 2).
- Produces:
  - `project::ProjectState::new(project: Option<Project>) -> ProjectState`
  - `project::ProjectState::snapshot(&self) -> Option<Project>` — async
  - `project::ProjectState::replace(&self, project: Project)` — async
  - `error::AppError::NoProjectSelected`
  - `commands::list_environments` now returns `Option<Project>`

**Why `Option`:** with the picker, "no project chosen yet" is a real state — first launch, or a remembered path that has since vanished. Representing it as an empty `Project` with a fabricated root would be the same class of lie that `IdentityRef.pem_path: Option<PathBuf>` was introduced to remove. `None` is the honest representation, and it is what drives the frontend's empty state.

**Why `tokio::sync::Mutex`:** `AgentPool` already uses it (`src-tauri/src/agent/mod.rs:23`), and `replace` is called from the async `select_project`. `snapshot` and `replace` are therefore `async fn`.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/project/mod.rs` (the implementation goes in the same file in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project(root: &str) -> Project {
        Project {
            root: PathBuf::from(root),
            environments: Vec::new(),
            error: None,
        }
    }

    #[tokio::test]
    async fn starts_empty_when_constructed_with_none() {
        let state = ProjectState::new(None);
        assert!(state.snapshot().await.is_none());
    }

    #[tokio::test]
    async fn snapshot_returns_what_was_managed() {
        let state = ProjectState::new(Some(project("/a")));
        assert_eq!(state.snapshot().await.unwrap().root, PathBuf::from("/a"));
    }

    #[tokio::test]
    async fn replace_swaps_the_project() {
        let state = ProjectState::new(Some(project("/a")));
        state.replace(project("/b")).await;
        assert_eq!(state.snapshot().await.unwrap().root, PathBuf::from("/b"));
    }

    /// The invariant that matters: `snapshot` clones and releases, so a
    /// caller holding a snapshot across an `.await` cannot block another
    /// caller. Holding a pool-wide lock across an await is a bug this
    /// project already shipped once (`AgentPool::get` across a 20-second
    /// `icp identity export`), so it is tested rather than merely commented.
    ///
    /// Deterministic, no timers: the second snapshot simply has to complete.
    /// If `snapshot` returned a guard instead of a clone, this deadlocks and
    /// the test hangs rather than failing — which is itself an unambiguous
    /// signal.
    #[tokio::test]
    async fn a_held_snapshot_does_not_block_another_snapshot() {
        let state = ProjectState::new(Some(project("/a")));

        let held = state.snapshot().await;
        tokio::task::yield_now().await;
        let second = state.snapshot().await;

        assert_eq!(held.unwrap().root, PathBuf::from("/a"));
        assert_eq!(second.unwrap().root, PathBuf::from("/a"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test project::tests`
Expected: FAIL — `cannot find type 'ProjectState' in this scope`.

- [ ] **Step 3: Implement `ProjectState`**

In `src-tauri/src/project/mod.rs`, between the `pub mod config;` line and the test module:

```rust
use tokio::sync::Mutex;

use crate::discovery::Project;

/// The project the app currently has open, or `None` if the user hasn't
/// chosen one yet.
///
/// `None` is a real state, not a placeholder: on first launch, and whenever
/// the remembered root has since been moved or deleted, there genuinely is
/// no project. The frontend renders it as the "choose a project" empty
/// state.
pub struct ProjectState(Mutex<Option<Project>>);

impl ProjectState {
    pub fn new(project: Option<Project>) -> Self {
        Self(Mutex::new(project))
    }

    /// A clone of the current project.
    ///
    /// Clones and releases the lock rather than handing out a guard, so no
    /// caller can hold this lock across an `.await`. Every command below
    /// does exactly that — snapshot, then make network calls — and a guard
    /// would let one slow query stall every other command in the app. That
    /// is not hypothetical: `AgentPool::get` shipped with a pool-wide lock
    /// held across a 20-second `icp identity export` subprocess. The clone
    /// is a handful of small `Vec`s and is not worth optimising away.
    pub async fn snapshot(&self) -> Option<Project> {
        self.0.lock().await.clone()
    }

    pub async fn replace(&self, project: Project) {
        *self.0.lock().await = Some(project);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test project::tests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the `NoProjectSelected` error variant**

Three edits in `src-tauri/src/error.rs`, matching the file's existing style exactly.

In the `AppError` enum, after `NoOrderableColumns { entity: String },`:

```rust
    /// No project is open: the app launched with nothing remembered, or the
    /// remembered root has since been moved or deleted. Every command that
    /// needs a project reports this rather than pretending an empty project
    /// exists.
    NoProjectSelected,
```

In `explanation()`, before the closing brace of the match:

```rust
            AppError::NoProjectSelected => {
                "No project is open. Choose a project directory — one containing an `.icp/` \
                 layout — to explore."
                    .to_string()
            }
```

In `kind()`, in the same relative position:

```rust
            AppError::NoProjectSelected => "noProjectSelected",
```

- [ ] **Step 6: Rewire the 7 commands**

In `src-tauri/src/commands.rs`, add to the imports (after `use crate::error::AppError;`):

```rust
use crate::project::ProjectState;
```

`list_environments` (currently at line 130) changes shape, because "no project" is now representable:

```rust
/// Returns the open project, or `None` if the user hasn't chosen one yet.
///
/// `None` and `Some(project)` are both ordinary outcomes: the frontend
/// renders the first as the "choose a project" empty state and the second
/// through its normal path. As before, a `Some` project may still carry a
/// `discover()` failure on its `error` field — see `Project`'s doc comment —
/// so a layout this app can't read stays distinguishable from a project
/// that simply has no environments yet.
#[tauri::command]
pub async fn list_environments(project: State<'_, ProjectState>) -> Option<Project> {
    project.snapshot().await
}
```

Note it becomes `async` (because `snapshot` is), and keeps returning a plain value rather than a `Result`.

The other **six** commands take a uniform, mechanical change. Their `project: State<'_, Project>` parameter becomes `project: State<'_, ProjectState>`, and one line goes in above the existing `let environment = find_environment(&project, &env)?;`:

```rust
    let project = project.snapshot().await.ok_or(AppError::NoProjectSelected)?;
```

`find_environment(&project, &env)?` then borrows the local owned `Project` and needs no further change; the borrow lives in the async fn's frame across the later `.await`s, which is fine — what must not cross an `.await` is the *lock guard*, and `snapshot` has already released it.

The six sites, by their current line numbers:

| Command | Signature line | `find_environment` line |
|---|---|---|
| `select_identity` | 148 | 154 |
| `canister_tree` | 173 | 179 |
| `list_tables` | 200 | 207 |
| `describe_table` | 215 | 223 |
| `fetch_rows` | 277 | 286 |
| `run_sql` | 325 | 333 |

- [ ] **Step 7: Manage `ProjectState` at startup**

Replace `discover_project()` and its call in `src-tauri/src/lib.rs`. The remembered-root read needs the config directory, which needs an `AppHandle`, so this moves into `.setup()`:

```rust
use tauri::Manager;

use agent::AgentPool;
use discovery::Project;
use project::config::read_recorded_root;
use project::ProjectState;

/// Loads the project the user last chose, or `None` if there isn't one to
/// load.
///
/// `None` is returned for a first launch and for a remembered root that has
/// since been moved or deleted (see `read_recorded_root`) — both mean the
/// app opens on the "choose a project" empty state.
///
/// A `discover()` failure against a root that *is* still there does not
/// become `None`: it becomes a `Project` carrying the error, so the
/// frontend can say what went wrong. Discarding it would make a `discover()`
/// regression indistinguishable from a project that merely has no
/// environments yet — a bug this app has already had once.
fn recorded_project(config_dir: &std::path::Path) -> Option<Project> {
    let root = read_recorded_root(config_dir)?;
    Some(
        discovery::discover(&root).unwrap_or_else(|error| Project {
            root,
            environments: Vec::new(),
            error: Some(error),
        }),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentPool::new())
        .setup(|app| {
            let project = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|dir| recorded_project(&dir));
            app.manage(ProjectState::new(project));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_environments,
            commands::select_project,
            commands::select_identity,
            commands::canister_tree,
            commands::list_tables,
            commands::describe_table,
            commands::fetch_rows,
            commands::run_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`commands::select_project` and `tauri_plugin_dialog` do not exist until Task 4 — this step will not compile on its own. Add the dependency and a stub now so the task ends green:

In `src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
tauri-plugin-dialog = "2.7.2"
```

And a stub at the end of `src-tauri/src/commands.rs`, replaced wholesale in Task 4:

```rust
/// Replaced in full by Task 4 — this exists only so `run()`'s handler list
/// compiles.
#[tauri::command]
pub async fn select_project(path: String) -> Result<(), AppError> {
    let _ = path;
    Err(AppError::NoProjectSelected)
}
```

- [ ] **Step 8: Run the full suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, 119 tests. There must be **zero** warnings about the removed `discover_project`; if the compiler reports dead code, delete what it names.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/project src-tauri/src/error.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: make the open project mutable, optional managed state"
```

---

### Task 4: `select_project` and pool invalidation

**Files:**
- Modify: `src-tauri/src/agent/mod.rs` (add `clear`)
- Modify: `src-tauri/src/commands.rs` (replace the Task 3 stub)
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `discovery::resolve_root` (Task 1), `project::config::{read_recorded_root, write_recorded_root}` (Task 2), `project::ProjectState::{snapshot, replace}` (Task 3).
- Produces:
  - `agent::AgentPool::clear(&self)` — async
  - `commands::ProjectSelection { project: Project, persist_warning: Option<String> }`, serialized camelCase
  - `commands::select_project(path, project, pool, app) -> Result<ProjectSelection, AppError>`

**Why the pool must be cleared** — the load-bearing correctness point of this whole feature. `AgentPool` is keyed `(Environment::name, IdentityRef::name)` (`agent/mod.rs`, `cache_key`). Two projects both having a `local` environment with a `default` identity is the **normal** case. Without invalidation, switching from project A to B and querying `local` reuses A's cached agent — pointed at **A's replica URL** — and renders B's canister ids against A's replica. That is wrong data shown confidently, the failure class this project has hit repeatedly.

- [ ] **Step 1: Write the failing test for `clear`**

In `src-tauri/src/agent/mod.rs`, inside the existing `#[cfg(test)] mod tests`, add:

```rust
    /// Switching projects must invalidate every cached agent: the cache key
    /// is `(environment name, identity name)`, and two different projects
    /// both having a `local` environment with a `default` identity is the
    /// normal case, not an edge case. A stale entry would serve the previous
    /// project's replica URL under the new project's environment name.
    #[tokio::test]
    async fn clear_empties_the_cache() {
        // `AgentBuilder::build` defaults the identity to anonymous and makes
        // no network call (`ic-agent-0.48`'s `build` is just
        // `Agent::new(self.config)`), so two throwaway agents cost nothing
        // and need no replica.
        fn agent() -> Agent {
            Agent::builder()
                .with_url("http://127.0.0.1:4943")
                .build()
                .expect("an agent with no identity should build")
        }

        let pool = AgentPool::new();
        {
            let mut agents = pool.agents.lock().await;
            agents.insert("project-a-local-default".to_string(), Arc::new(agent()));
            agents.insert("project-b-local-default".to_string(), Arc::new(agent()));
            assert_eq!(agents.len(), 2, "both entries should be cached");
        }

        pool.clear().await;

        assert!(
            pool.agents.lock().await.is_empty(),
            "clear() must remove every cached agent, not just the current environment's"
        );
    }
```

The key strings are arbitrary — `clear` doesn't parse them, and all this test needs is two distinct entries. Do not weaken the `is_empty()` assertion for any reason.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test agent::tests::clear_empties_the_cache`
Expected: FAIL — `no method named 'clear' found for struct 'AgentPool'`.

- [ ] **Step 3: Implement `clear`**

In `src-tauri/src/agent/mod.rs`, in `impl AgentPool`, after `get`:

```rust
    /// Drops every cached agent.
    ///
    /// Called when the open project changes. The cache key is
    /// `(environment name, identity name)` — which is *not* unique across
    /// projects, since two projects both having a `local` environment with a
    /// `default` identity is the normal case. Left uncleared, a switch would
    /// keep serving the previous project's agent, pointed at the previous
    /// project's replica URL, under the new project's environment name.
    ///
    /// Clearing rather than folding the project root into the key is
    /// deliberate: a longer key would be correct too, but would retain
    /// agents — and the private key material they hold — for projects the
    /// user has left. The cost is that switching back re-loads identities,
    /// which may re-prompt the OS keychain.
    pub async fn clear(&self) {
        self.agents.lock().await.clear();
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test agent::tests::clear_empties_the_cache`
Expected: PASS.

- [ ] **Step 5: Replace the `select_project` stub**

In `src-tauri/src/commands.rs`, delete the Task 3 stub and put this in its place. Add `use tauri::{AppHandle, Manager, State};` (the file currently imports only `State`), plus `use crate::discovery::resolve_root;` and `use crate::project::config::write_recorded_root;`.

```rust
/// The result of switching projects: the newly-open project, plus a warning
/// if the choice could not be remembered.
///
/// The wrapper exists for one reason. A config-write failure has nowhere to
/// go in a bare `Project`, and reusing `Project::error` for it would render
/// a *storage* problem in the same banner as a *discovery* problem — two
/// unrelated conditions with one explanation. Keeping `project` a plain
/// `Project` means the frontend adopts a switched project through the exact
/// code path it uses at launch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSelection {
    pub project: Project,
    /// `Some` when the project was adopted but will not be remembered next
    /// launch. Never a reason to fail the switch.
    pub persist_warning: Option<String>,
}

/// Opens the project at `path`, making it the one every other command sees.
///
/// In order: check the path is a directory, resolve it up to the nearest
/// `.icp/`, discover, clear the agent pool, swap the state, remember the
/// choice.
///
/// Two deliberate choices about failure. First, an unusable *path* is an
/// `Err` and changes nothing — the previously open project stays open and
/// the pool is untouched — because nothing was adopted. Second, a `discover()`
/// failure is **not** an `Err`: it becomes a `Project` carrying the error,
/// exactly as at launch, so a directory with no `.icp/` is adopted and the
/// UI explains why it's empty. Refusing it would make an undeployed project
/// impossible to open, which this app deliberately supports.
///
/// The root is remembered even when it holds no `.icp/`. The user asked for
/// that folder; silently reverting to a different project on next launch
/// would be the more surprising behaviour.
#[tauri::command]
pub async fn select_project(
    path: String,
    project: State<'_, ProjectState>,
    pool: State<'_, AgentPool>,
    app: AppHandle,
) -> Result<ProjectSelection, AppError> {
    let picked = std::path::PathBuf::from(&path);
    if !picked.is_dir() {
        return Err(AppError::Io(format!(
            "{path} is not a directory, so it cannot be opened as a project"
        )));
    }

    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let root = resolve_root(&picked, home.as_deref());

    let discovered = discovery::discover(&root).unwrap_or_else(|error| Project {
        root: root.clone(),
        environments: Vec::new(),
        error: Some(error),
    });

    // Order matters: clear before swapping. Every cached agent belongs to
    // the project being left, and its key may collide with the incoming
    // project's (see `AgentPool::clear`).
    pool.clear().await;
    project.replace(discovered.clone()).await;

    let persist_warning = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate the app config directory: {error}"))
        .and_then(|dir| write_recorded_root(&dir, &root))
        .err();

    Ok(ProjectSelection {
        project: discovered,
        persist_warning,
    })
}
```

Add `use crate::discovery::{self, Environment, IdentityRef, Project};` — the file currently imports the three types but not the module itself, and `discovery::discover` is called above.

**On testing the not-a-directory pre-flight.** The spec's testing table lists it, and it is deliberately *not* unit-tested here: it is a single `is_dir()` call inside a `#[tauri::command]`, and extracting it into a named function purely to assert `is_dir()` would be ceremony around a standard-library call. Its behaviour — the switch rejects and the previously open project survives — is asserted end-to-end by Task 6's "keeps the current project when a pick is rejected". If you find yourself wanting a unit test here anyway, that is fine, but do not extract a function whose only caller is the test.

- [ ] **Step 6: Grant the dialog permission**

Replace the `permissions` array in `src-tauri/capabilities/default.json`:

```json
  "permissions": [
    "core:default",
    "dialog:allow-open"
  ]
```

`dialog:allow-open` only — `dialog:default` would additionally grant `allow-save` and `allow-message`, which this app never uses.

- [ ] **Step 7: Run the full suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, 120 tests.

Then confirm the app builds with the plugin registered: `cd src-tauri && cargo build`
Expected: success, no warnings.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/agent/mod.rs src-tauri/src/commands.rs src-tauri/capabilities/default.json
git commit -m "feat: add select_project, clearing the agent pool on switch"
```

---

### Task 5: Frontend API layer and the picker button

**Files:**
- Modify: `src/api/types.ts`
- Modify: `src/api/commands.ts`
- Create: `src/components/ProjectSelector.tsx`
- Create: `src/components/ProjectSelector.test.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `commands::select_project` and `ProjectSelection` (Task 4), `list_environments` now returning `Option<Project>` (Task 3).
- Produces:
  - `types.ts`: `ProjectSelection = { project: Project; persistWarning: string | null }`
  - `commands.ts`: `listEnvironments(): Promise<Project | null>`, `selectProject(path: string): Promise<ProjectSelection>`
  - `ProjectSelector` props: `{ root: string | null; busy: boolean; onSelect: (path: string) => void }`

- [ ] **Step 1: Install the dialog plugin's JS side**

```bash
npm install @tauri-apps/plugin-dialog@^2.7.2
```

Verify it landed in `dependencies` (not `devDependencies`) in `package.json` — it ships in the app.

- [ ] **Step 2: Extend the types**

In `src/api/types.ts`, after the existing `Project` type:

```ts
/** The result of `selectProject` (see
 * `src-tauri/src/commands.rs::ProjectSelection`). `project` is a plain
 * `Project`, identical to what `listEnvironments` returns, so both paths
 * adopt a project through the same code. `persistWarning` is set when the
 * project was opened but the choice could not be remembered for next
 * launch — a note, never a failure. */
export type ProjectSelection = { project: Project; persistWarning: string | null };
```

Also amend `Project`'s existing doc comment to record that `listEnvironments` can now return `null`:

```ts
/** The discovered project. `error` carries a `discover()` failure (e.g. no
 * `.icp/` directory at all) — `null` both on success and on a merely
 * undeployed project (zero environments, no error is not a failure).
 * `listEnvironments` returns `null` for the project itself when the user
 * has not chosen one yet: a first launch, or a remembered root that has
 * since been moved or deleted. */
```

- [ ] **Step 3: Add the command wrappers**

In `src/api/commands.ts`, change `listEnvironments`'s return type and add `selectProject`. Import `ProjectSelection` alongside the existing type imports.

```ts
/** Returns the open project, or `null` if the user hasn't chosen one — a
 * first launch, or a remembered root that has since vanished. */
export async function listEnvironments(): Promise<Project | null> {
  try {
    return await invoke<Project | null>("list_environments");
  } catch (error) {
    throw toAppErrorDto(error);
  }
}

/** Opens the project at `path`, which becomes the project every other
 * command sees. Resolves the path up to the nearest `.icp/` and clears the
 * backend's agent cache — see
 * `src-tauri/src/commands.rs::select_project`.
 *
 * A directory with no `.icp/` anywhere above it still resolves: it comes
 * back as a `Project` whose `error` explains why it's empty, not as a
 * rejection. Only an unusable *path* rejects, and in that case the
 * previously open project stays open. */
export async function selectProject(path: string): Promise<ProjectSelection> {
  try {
    return await invoke<ProjectSelection>("select_project", { path });
  } catch (error) {
    throw toAppErrorDto(error);
  }
}
```

- [ ] **Step 4: Write the failing component tests**

Create `src/components/ProjectSelector.test.tsx`:

This repo has **no** `@testing-library/user-event` — every existing test drives the DOM with `fireEvent`, uses bare top-level `test(...)` (Vitest globals are on, so nothing is imported from `vitest`), and relies on `jest-dom` matchers. Follow that exactly; do not add a testing dependency.

`vi.hoisted` is required for the dialog mock: `vi.mock` and the `import` of the component under test are both hoisted above plain `const` declarations, so a bare `const open = vi.fn()` would still be `undefined` when the mock factory runs.

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { ProjectSelector } from "./ProjectSelector";

const open = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

beforeEach(() => {
  open.mockReset();
});

test("shows the root's basename, with the full path available", () => {
  render(<ProjectSelector root="/Users/me/projects/toko" busy={false} onSelect={vi.fn()} />);

  const button = screen.getByRole("button");
  expect(button).toHaveTextContent("toko");
  expect(button).toHaveAttribute("title", "/Users/me/projects/toko");
});

test("invites a choice when no project is open", () => {
  render(<ProjectSelector root={null} busy={false} onSelect={vi.fn()} />);

  expect(screen.getByRole("button")).toHaveTextContent(/choose a project/i);
});

test("passes the picked directory to onSelect", async () => {
  open.mockResolvedValue("/Users/me/projects/other");
  const onSelect = vi.fn();
  render(<ProjectSelector root={null} busy={false} onSelect={onSelect} />);

  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/Users/me/projects/other"));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
});

test("does nothing at all when the dialog is cancelled", async () => {
  open.mockResolvedValue(null);
  const onSelect = vi.fn();
  render(<ProjectSelector root="/Users/me/projects/toko" busy={false} onSelect={onSelect} />);

  fireEvent.click(screen.getByRole("button"));

  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(onSelect).not.toHaveBeenCalled();
});

test("cannot be clicked while a switch is in flight", () => {
  const onSelect = vi.fn();
  render(<ProjectSelector root={null} busy={true} onSelect={onSelect} />);

  const button = screen.getByRole("button");
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -- ProjectSelector`
Expected: FAIL — cannot resolve `./ProjectSelector`.

- [ ] **Step 6: Implement the component**

Create `src/components/ProjectSelector.tsx`:

```tsx
import { open } from "@tauri-apps/plugin-dialog";

type Props = {
  /** The open project's absolute root, or null if none is open. */
  root: string | null;
  /** True while a switch is in flight, so a second dialog can't be opened. */
  busy: boolean;
  onSelect: (path: string) => void;
};

/** The last path segment — what the user actually recognises. The full path
 * stays available as the button's title. */
function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Opens a native folder dialog and hands the chosen path to `onSelect`.
 *
 * The dialog lives here rather than in Rust so `select_project` stays a
 * plain "adopt this path" command with no dialog in its test path.
 *
 * Cancelling is a no-op by design: `open` resolves to `null` and nothing is
 * called, nothing changes, and no error is shown. A cancelled dialog is not
 * a failure. */
export function ProjectSelector({ root, busy, onSelect }: Props) {
  const choose = () => {
    void open({ directory: true, multiple: false }).then((picked) => {
      if (typeof picked === "string") {
        onSelect(picked);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={choose}
      disabled={busy}
      title={root ?? undefined}
      className="rounded border px-2 py-1 text-sm disabled:opacity-50"
    >
      {root ? `📁 ${basename(root)}` : "Choose a project…"}
    </button>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- ProjectSelector`
Expected: PASS, 5 tests.

Then the whole suite: `npm test`
Expected: PASS, 30 tests (25 baseline + 5).

- [ ] **Step 8: Commit**

```bash
git add src/api/types.ts src/api/commands.ts src/components/ProjectSelector.tsx src/components/ProjectSelector.test.tsx package.json package-lock.json
git commit -m "feat: add the project picker button and its command wrapper"
```

---

### Task 6: Wire the picker into the app

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `listEnvironments(): Promise<Project | null>`, `selectProject(path): Promise<ProjectSelection>`, `ProjectSelector` (Task 5).
- Produces: nothing downstream.

**What changes, precisely:**

1. Two new pieces of state: `root: string | null` and `projectBusy: boolean`, plus `persistWarning: string | null`.
2. `adoptProject(project: Project)` — the mount effect's body, extracted, so launch and switch share one definition of "what loading a project means".
3. The mount effect handles `null` (no project chosen).
4. `handleSelectProject(path)` calls `selectProject`, then `adoptProject`.
5. A `ProjectSelector` at the left of the header.
6. A no-project empty state.
7. A dismissible persist-warning note, visually distinct from `ErrorBanner`.

- [ ] **Step 1: Write the failing tests**

`src/App.test.tsx` already has `vi.mock("./api/commands")` (an automock, driven per-test via `vi.mocked(commands.X)`) and a `usableIdentity` const at the top. Extend that file — do not add a second `vi.mock` for the same module.

Two additions at the top. The dialog mock, beside the existing `vi.mock("./api/commands")`:

```tsx
const dialogOpen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
```

And an `Environment` builder, since the five new tests need one repeatedly. The existing tests inline theirs; leave those alone — this helper is for the new tests only.

```tsx
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
```

Add `Environment` to the existing `import type { ... } from "./api/types";` line.

Then the tests, appended to the end of the file:

```tsx
test("offers the picker and no panes when no project is open", async () => {
  vi.mocked(commands.listEnvironments).mockResolvedValue(null);

  render(<App />);

  expect(await screen.findByText(/choose a project to explore/i)).toBeInTheDocument();
  expect(screen.queryByText(/no environments were found/i)).not.toBeInTheDocument();
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
```

`entity(name)` is the existing helper at the top of the file — reuse it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- App`
Expected: FAIL — `selectProject` is not exported from the mocked module, and no "choose a project to explore" text exists.

- [ ] **Step 3: Extract `adoptProject` and handle `null`**

In `src/App.tsx`, add the new state beside the existing declarations:

```tsx
  // The open project's absolute root, or null when none is open — a first
  // launch, or a remembered root that has since been moved or deleted.
  const [root, setRoot] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  // Set when a project was opened but the choice couldn't be remembered.
  // Deliberately not an `AppErrorDto`: failing to remember a choice is not
  // the same kind of event as failing to read a project, and rendering it
  // in `ErrorBanner` would say it was.
  const [persistWarning, setPersistWarning] = useState<string | null>(null);
```

Then replace the mount effect with a shared adopter plus a thin effect:

```tsx
  // The single definition of "what opening a project means", shared by
  // launch and by every later switch. Two call sites deriving this
  // separately would drift — the same reason `resolve_identity_store` is one
  // function in `discovery` rather than duplicated per caller.
  const adoptProject = useCallback((project: Project) => {
    setRoot(project.root);
    setEnvironments(project.environments);
    setEnvironmentsError(project.error);
    setIdentityError(null);
    identityRequestRef.current = null;
    const first = project.environments[0] ?? null;
    setEnv(first?.name ?? null);
    setIdentity(first ? initialIdentityFor(first) : null);
    // Everything below the environment is derived from it, so a new project
    // invalidates all of it. The effects keyed on env/canister/entity clear
    // their own state, but `canister` and `entity` are selections, not
    // derived data, and would otherwise survive into a project where they
    // mean nothing.
    setCanister(null);
    setEntity(null);
    setSqlResult(null);
    setSqlError(undefined);
  }, []);

  // Load whatever project was remembered. `null` means none was — the
  // "choose a project" state, not a failure.
  useEffect(() => {
    listEnvironments()
      .then((project) => {
        if (project) adoptProject(project);
      })
      .catch((error: AppErrorDto) => setEnvironmentsError(error))
      .finally(() => setEnvironmentsLoaded(true));
  }, [adoptProject]);
```

`identityRequestRef` is declared below the current mount effect — move its `useRef` declaration above `adoptProject`, since `adoptProject` now references it. Its existing doc comment stays accurate: abandoning an in-flight identity selection is exactly as necessary on a project switch as on an environment switch.

- [ ] **Step 4: Add the switch handler**

```tsx
  // A rejected pick changes nothing: `select_project` only rejects on a path
  // it could not adopt at all, in which case the backend never swapped its
  // state, so the project on screen is still the one that's open.
  const handleSelectProject = useCallback(
    (path: string) => {
      setProjectBusy(true);
      setPersistWarning(null);
      selectProject(path)
        .then((selection) => {
          adoptProject(selection.project);
          setPersistWarning(selection.persistWarning);
        })
        .catch((error: AppErrorDto) => setEnvironmentsError(error))
        .finally(() => setProjectBusy(false));
    },
    [adoptProject],
  );
```

Import `selectProject` from `./api/commands`, `ProjectSelector` from `./components/ProjectSelector`, and the `Project` type from `./api/types`.

- [ ] **Step 5: Render the picker, the note, and the empty state**

In the header, as the first element after the `<h1>`:

```tsx
        <ProjectSelector root={root} busy={projectBusy} onSelect={handleSelectProject} />
```

After the `identityError` banner block, the persist note — amber like the other advisory states, deliberately not `ErrorBanner`:

```tsx
      {persistWarning && (
        <div className="p-2">
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            This project is open, but the choice won&apos;t be remembered next launch:{" "}
            {persistWarning}
          </p>
        </div>
      )}
```

Then the no-project state. It must come **before** the existing "No environments were found" block and that block must not also render, so guard it on `root !== null`:

```tsx
      {/* No project is open: a first launch, or a remembered root that has
          since been moved or deleted. Distinct from "this project has no
          environments" below — that one is about a project that exists. */}
      {environmentsLoaded && root === null && !environmentsError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-gray-600">Choose a project to explore.</p>
          <p className="text-xs text-gray-500">
            Pick a directory containing an <code>.icp/</code> layout — or any directory inside
            one.
          </p>
          <ProjectSelector root={null} busy={projectBusy} onSelect={handleSelectProject} />
        </div>
      )}
```

Change the existing no-environments guard from
`{environmentsLoaded && environments.length === 0 && !environmentsError && (`
to
`{environmentsLoaded && root !== null && environments.length === 0 && !environmentsError && (`

and the two panes below (`<div className="flex flex-1 overflow-hidden">`) to render only when a project is open, so the empty state isn't sitting above three blank columns:

```tsx
      {root !== null && (
        <div className="flex flex-1 overflow-hidden">
```

with the matching `)}` added after that div's closing tag.

Note the picker appears twice — in the header and in the empty state. That is intentional: the header is where it lives permanently, and the empty state needs a primary call to action rather than pointing at a small button in a corner. Both render the same component with the same handler, so there is one behaviour, not two.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- App`
Expected: PASS, including the 6 new tests.

Then: `npm test`
Expected: PASS, 36 tests.

And typecheck: `npm run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat: pick and switch projects from the app"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-31-project-picker-design.md` (one correction)

**Interfaces:** none.

- [ ] **Step 1: Update the README**

Read `README.md` first. It currently tells the reader to launch the app from a project directory. Replace that with the picker, and fold in what this task changed:

- The app opens the project you last chose, and offers a folder picker on first run. You no longer need to `cd` anywhere before launching.
- Picking any directory inside a project works — it walks up to the nearest `.icp/`.
- The choice is remembered in `<app config dir>/project.json`. On macOS that is exactly `~/Library/Application Support/dev.rem.icydb-explorer/project.json` (the identifier is `dev.rem.icydb-explorer`, `src-tauri/tauri.conf.json:5`, and `app_config_dir()` resolves to `config_dir()/<identifier>`).
- Switching projects clears cached agents, so the first query after a switch re-loads the identity and may re-prompt the keychain.

Do not add or restate any claim that the app enforces read-only access as a security boundary; the existing README section on the query-only guarantee stays exactly as it is.

- [ ] **Step 2: Correct the spec's error table**

In `docs/superpowers/specs/2026-07-31-project-picker-design.md`, the "Error handling" table lists "No `.icp/` anywhere up the tree" and "`discover()` failed reading `.icp/`" as separate rows with different results. They are one path in the code — `discover()` returns `Err` when `.icp` is not a directory, and both land in the `Project { error: Some(..) }` fallback. Merge the two rows into one:

```markdown
| No `.icp/` anywhere up the tree, or `discover()` failed reading one | `Ok(Project { error: Some(..) })` — adopted, with the failure rendered explicitly. These are one path: `discover()` returns `Err` when `<root>/.icp` is not a directory, and both cases use the same fallback `lib.rs` already uses at launch. |
```

Add a line under it recording why: `The spec originally separated these; implementation found them to be the same code path, and one path rendering one explanation is the better behaviour.`

- [ ] **Step 3: Verify both suites are still green**

Run: `cd src-tauri && cargo test` — expected PASS, 120 tests.
Run: `npm test` — expected PASS, 36 tests.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-31-project-picker-design.md
git commit -m "docs: document the project picker"
```

---

## Manual verification (after Task 7)

The suites cannot prove the native dialog opens or that the choice survives a relaunch. Run this by hand:

```bash
npm run tauri dev
```

1. Launch from a directory that is **not** a project (e.g. `~`). Expect the "Choose a project to explore" state, not blank panes.
2. Pick `~/projects/icydb_explorer/src`. Expect the header to show `icydb_explorer` — the upward walk found the root from a subdirectory.
3. Quit and relaunch. Expect it to open on `icydb_explorer` with no picking.
4. Pick a directory with no `.icp/` anywhere (e.g. `~/Documents`). Expect an explicit error explaining there is no `.icp` layout, and the header showing that folder.
5. Pick `~/projects/toko`. Expect discovery to succeed; a query is expected to fail with `NoSqlSurface`, since toko has not enabled the SQL surface. That failure is correct, not a regression.
6. Switch back and forth between two projects and run a query in each. Confirm the second project's rows come from the second project's replica — this is what `AgentPool::clear` exists for.
