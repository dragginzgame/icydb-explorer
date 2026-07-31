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
    /// Lock poisoning is recovered from rather than propagated. Poisoning
    /// means some other caller panicked while holding this lock, which here
    /// could only happen mid-clone; the stored `Option<Project>` is still
    /// structurally intact, and refusing to serve the open project for the
    /// rest of the session would be a far worse outcome than continuing.
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
    /// Be clear about what this test is. Its real force is at *compile* time:
    /// if `snapshot` returned a `std::sync::MutexGuard`, this function would
    /// not compile, because a guard is `!Send` and cannot be held across an
    /// await in this future. The runtime assertions below are secondary — they
    /// confirm both snapshots see the same project. A guard-returning
    /// implementation additionally self-deadlocks at the second call, but the
    /// compiler stops it before that ever runs.
    ///
    /// This is the rule `AgentPool::get` broke once, holding a pool-wide lock
    /// across a 20-second `icp identity export` subprocess.
    #[tokio::test]
    async fn a_snapshot_is_owned_and_does_not_block_another_snapshot() {
        let state = ProjectState::new(Some(project("/a")));

        let held = state.snapshot();
        tokio::task::yield_now().await;
        let second = state.snapshot();

        assert_eq!(held.unwrap().root, PathBuf::from("/a"));
        assert_eq!(second.unwrap().root, PathBuf::from("/a"));
    }
}
