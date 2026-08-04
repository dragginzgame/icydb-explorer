pub mod agent;
pub mod commands;
pub mod diagnostics;
pub mod discovery;
pub mod error;
pub mod project;
pub mod sql;

#[cfg(test)]
mod test_support;
pub mod topology;
pub mod view;

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
    Some(discovery::discover(&root).unwrap_or_else(|error| Project {
        root,
        environments: Vec::new(),
        error: Some(error),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::count_rows,
            commands::sql_capabilities,
            commands::preferred_identity_for,
            commands::write_export,
            commands::describe_table,
            commands::fetch_rows,
            commands::explain_rows,
            commands::run_sql,
            commands::run_sql_many,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A per-test scratch config directory under the system temp dir, named
    /// after the test so two tests can never collide, and cleared on entry
    /// so a previous run's leftovers cannot make a test pass. Mirrors
    /// `project::config::tests::scratch`.
    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("icydb-explorer-lib-{name}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch dir should be creatable");
        path
    }

    #[test]
    fn no_recorded_root_is_none() {
        let config_dir = scratch("no-recorded-root");
        assert!(recorded_project(&config_dir).is_none());
    }

    /// The case that pins the finding: a recorded root that still exists but
    /// has no `.icp/` layout must not be discarded down to `None` — it must
    /// come back as a `Project` carrying `discover()`'s error, so the
    /// frontend can say what's wrong rather than rendering "no environments
    /// yet" for what is actually an unreadable project.
    #[test]
    fn a_recorded_root_with_no_icp_layout_keeps_the_discover_error() {
        let config_dir = scratch("no-icp-layout");
        let root = config_dir.join("some-project");
        fs::create_dir_all(&root).expect("root should be creatable");
        project::config::write_recorded_root(&config_dir, &root).expect("write should succeed");

        let project = recorded_project(&config_dir).expect("root exists, so this is Some");
        assert!(
            project.error.is_some(),
            "a project with no .icp/ layout should carry discover()'s error"
        );
        assert!(project.environments.is_empty());
    }

    #[test]
    fn a_recorded_root_that_no_longer_exists_is_none() {
        let config_dir = scratch("stale-root");
        let root = config_dir.join("deleted-project");
        fs::create_dir_all(&root).expect("root should be creatable");
        project::config::write_recorded_root(&config_dir, &root).expect("write should succeed");
        fs::remove_dir_all(&root).expect("removal should succeed");

        assert!(recorded_project(&config_dir).is_none());
    }
}
