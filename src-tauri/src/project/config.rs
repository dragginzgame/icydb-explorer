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
    // `.display()` is lossy for non-UTF-8 paths (rare, platform-dependent);
    // a faithful round-trip would need a different on-disk encoding (e.g.
    // base64 or a byte array) for `root`, which this file's JSON shape is
    // deliberately kept simple to avoid — see this module's finding notes.
    let contents = serde_json::json!({ "root": root.display().to_string() });
    fs::write(&path, contents.to_string())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

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

    /// A file that exists but can't be read as a string — as opposed to the
    /// missing-file case above, which fails with `NotFound`. A *directory*
    /// at the config file's path makes `fs::read_to_string` fail with an
    /// `EISDIR`-style I/O error instead, exercising the other branch of
    /// `.ok()?` so a future `.expect(...)` mistake there would be caught.
    #[test]
    fn an_unreadable_file_is_none_not_an_error() {
        let dir = scratch("unreadable");
        fs::create_dir_all(dir.join("project.json")).expect("directory should be creatable");
        assert_eq!(read_recorded_root(&dir), None);
    }

    /// The other half of "absent or not a string": a `root` that parses as
    /// valid JSON but isn't a string. A number is the value most likely to
    /// survive a lossy-stringification bug (e.g. `.to_string()` on the
    /// `serde_json::Value` instead of `.as_str()`), so it's the most
    /// valuable case to pin.
    #[test]
    fn a_non_string_root_is_none() {
        let dir = scratch("non-string-root");
        fs::write(dir.join("project.json"), r#"{"root": 123}"#).expect("write should succeed");
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
