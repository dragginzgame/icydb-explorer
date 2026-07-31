//! Resolving a user-picked directory to a project root.

use std::path::{Path, PathBuf};

/// Returns the first of `picked` and its ancestors that contains a `.icp`
/// directory, or `picked` unchanged if none does.
///
/// `picked` is **always** the first candidate, whatever it is. The bound
/// applies to the *ancestor* walk only: when a home directory is supplied,
/// it and the filesystem root are never examined as ancestors, because
/// `~/.icp` and `/.icp` would be config locations rather than projects —
/// without that rule, one home-level `.icp` would make every folder under
/// `$HOME` resolve to `$HOME`. Bounding ancestors only means a project
/// stored directly at `$HOME` is still found when picked exactly.
///
/// The home bound only applies where a home directory is discoverable in the
/// first place. The caller (`commands::select_project`) currently determines
/// it by reading `HOME`, which is normally unset on Windows — there, `home`
/// is `None` and this function walks all the way to the filesystem root, so
/// a `.icp` at, say, `C:\Users\me` would be adopted for every folder beneath
/// it. See that caller and `discovery::icp_dir` for why this isn't worth
/// fixing by reading `%USERPROFILE%` instead: the identity store lookup has
/// the same `HOME`-only assumption, so Windows is unsupported in practice
/// regardless.
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
        // `home`. `parent.parent().is_none()` already covers an empty path
        // (`Path::new("").parent()` is `None` too), so no separate check for
        // it is needed.
        if parent.parent().is_none() {
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
        assert_eq!(resolve_root(&fixture("project"), None), fixture("project"));
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
        assert_eq!(
            resolve_root(&fixture("bare/sub"), None),
            fixture("bare/sub")
        );
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

    /// With no `home` to stop at, the ancestor walk must still terminate.
    ///
    /// Candid about what this does and does not prove: nothing along a
    /// nonexistent path holds a `.icp`, so this cannot show that `/` is
    /// *excluded* as an ancestor — demonstrating that would require creating
    /// `/.icp`, which no test may do. What it does prove is termination: an
    /// unbounded `while let Some(parent)` walk over an absolute path either
    /// returns or hangs, and a hang fails this test by timeout rather than
    /// passing quietly.
    #[test]
    fn the_ancestor_walk_terminates_when_home_is_none() {
        let picked = Path::new("/icydb-explorer-nonexistent/a/b");
        assert_eq!(resolve_root(picked, None), picked.to_path_buf());
    }

    /// The filesystem root as the *picked* directory. Unlike the ancestor
    /// case above this is fully observable: `/` is its own last candidate,
    /// there is no `/.icp` on any sane system, so it must come back
    /// unchanged rather than the function walking off the end of the path.
    #[test]
    fn picking_the_filesystem_root_returns_it_unchanged() {
        assert_eq!(resolve_root(Path::new("/"), None), PathBuf::from("/"));
    }
}
