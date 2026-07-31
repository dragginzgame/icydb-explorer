pub mod agent;
pub mod commands;
pub mod discovery;
pub mod error;
pub mod project;
pub mod sql;
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
