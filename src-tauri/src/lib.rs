pub mod agent;
pub mod commands;
pub mod discovery;
pub mod error;
pub mod sql;
pub mod topology;
pub mod view;

use agent::AgentPool;
use discovery::Project;

/// Discovers the `.icp/` project layout rooted at the current working
/// directory. A project that hasn't been deployed yet (no `.icp/` at all)
/// is not a reason to refuse to start the app — it just means
/// `list_environments` comes back empty and every other command reports a
/// clear "no such environment" error until the project is deployed. So a
/// `discover` failure here falls back to an empty `Project` rather than
/// panicking or propagating.
fn discover_project() -> Project {
    let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    discovery::discover(&root).unwrap_or(Project {
        root,
        environments: Vec::new(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentPool::new())
        .manage(discover_project())
        .invoke_handler(tauri::generate_handler![
            commands::list_environments,
            commands::canister_tree,
            commands::list_tables,
            commands::describe_table,
            commands::fetch_rows,
            commands::run_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
