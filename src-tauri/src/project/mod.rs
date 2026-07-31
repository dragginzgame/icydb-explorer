//! The currently-open project: which one it is, and remembering it.

pub mod config;

use std::sync::Mutex;

use crate::discovery::Project;

/// The project the app currently has open, or `None` if the user hasn't
/// chosen one yet.
///
/// `None` is a real state, not a placeholder: on first launch, and whenever
/// the remembered root has since been moved or deleted, there genuinely is
/// no project. The frontend renders it as the "choose a project" empty
/// state.
///
/// Deliberately a **`std::sync::Mutex`**, not `tokio`'s, even though
/// `AgentPool` next door uses tokio's. Two reasons, and the first is the
/// important one:
///
/// 1. It makes the never-hold-a-lock-across-`.await` rule a *compile-time*
///    guarantee instead of a convention. `std::sync::MutexGuard` is `!Send`,
///    so holding one across an `.await` in a spawned future does not compile.
///    The rule this project already broke once — `AgentPool::get` held a
///    pool-wide lock across a 20-second `icp identity export` subprocess —
///    can no longer be broken here by accident.
/// 2. It keeps `snapshot`/`replace` synchronous, which keeps
///    `list_environments` a synchronous command. Tauri's macro rejects an
///    `async` command that takes a lifetime-bearing parameter (`State<'_, T>`)
///    and does not return `Result`
///    (`tauri-macros-2.6.3/src/command/wrapper.rs:176`, upstream issue #2533),
///    so an async `snapshot` would force `list_environments` to return a
///    `Result` that can never be `Err` purely to satisfy a macro.
///
/// Nothing needs to hold this lock across an await: every holder either
/// clones out of it (`snapshot`) or writes into it (`replace`), both of which
/// complete without suspending.
pub struct ProjectState(Mutex<Option<Project>>);

impl ProjectState {
    pub fn new(project: Option<Project>) -> Self {
        Self(Mutex::new(project))
    }

    /// A clone of the current project.
    ///
    /// Clones and releases the lock rather than handing out a guard, so no
    /// caller can hold this lock while it makes network calls. Every command
    /// does exactly that — snapshot, then query a canister — and a guard
    /// would let one slow query stall every other command in the app. The
    /// clone is a handful of small `Vec`s and is not worth optimising away.
    ///
    /// Lock poisoning is recovered from rather than propagated, as cheap
    /// insurance against a currently-unreachable case rather than a live
    /// risk: the only operations ever performed under this lock are
    /// `Option<Project>::clone` and a plain assignment, and the only panic
    /// either could raise is an allocation failure, which aborts rather than
    /// unwinds in a default build — so poisoning cannot actually occur today.
    /// If `Project`'s `Clone` impl ever grows a panicking case, though,
    /// refusing to serve the open project for the rest of the session would
    /// be a far worse outcome than recovering the (structurally intact)
    /// `Option<Project>` and continuing.
    pub fn snapshot(&self) -> Option<Project> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Swaps in a newly-opened project. See `snapshot` on poison recovery.
    pub fn replace(&self, project: Project) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(project);
    }
}

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

    #[test]
    fn starts_empty_when_constructed_with_none() {
        let state = ProjectState::new(None);
        assert!(state.snapshot().is_none());
    }

    #[test]
    fn snapshot_returns_what_was_managed() {
        let state = ProjectState::new(Some(project("/a")));
        assert_eq!(state.snapshot().unwrap().root, PathBuf::from("/a"));
    }

    #[test]
    fn replace_swaps_the_project() {
        let state = ProjectState::new(Some(project("/a")));
        state.replace(project("/b"));
        assert_eq!(state.snapshot().unwrap().root, PathBuf::from("/b"));
    }

    /// The invariant that matters: a snapshot is an owned value, so it can be
    /// held across an `.await` — and taking another one meanwhile cannot
    /// deadlock, because `snapshot` never hands out a guard.
    ///
    /// Be clear about what actually pins that at *compile* time, because it
    /// is not the `.await` above: `#[tokio::test]` expands to
    /// `Runtime::block_on`, and `block_on` imposes no `Send` bound on its
    /// future, so holding a value across this test's `.await` proves nothing
    /// about `Send`-ness on its own — a `!Send` guard would happily ride
    /// along here. The `requires_send` assertion below is what actually pins
    /// it: `std::sync::MutexGuard` is `!Send`, so a guard-returning
    /// `snapshot` fails *that* check to compile, regardless of how the
    /// assertions afterward are shaped. (`ProjectState`'s own doc comment,
    /// about a guard not surviving a *spawned* future, is a separate and
    /// still-accurate claim — Tauri's async command futures do require
    /// `Send + 'static`; this comment is only about what this specific test
    /// proves.) The runtime assertions below are secondary — they confirm
    /// both snapshots see the same project.
    ///
    /// This is the rule `AgentPool::get` broke once, holding a pool-wide lock
    /// across a 20-second `icp identity export` subprocess.
    #[tokio::test]
    async fn a_snapshot_is_owned_and_does_not_block_another_snapshot() {
        let state = ProjectState::new(Some(project("/a")));

        let held = state.snapshot();
        // A guard would fail this: `std::sync::MutexGuard` is `!Send`. This is
        // the actual compile-time pin on `snapshot` returning an owned value —
        // it does not depend on the shape of the assertions below.
        fn requires_send<T: Send>(_: &T) {}
        requires_send(&held);
        tokio::task::yield_now().await;
        let second = state.snapshot();

        assert_eq!(held.unwrap().root, PathBuf::from("/a"));
        assert_eq!(second.unwrap().root, PathBuf::from("/a"));
    }
}
