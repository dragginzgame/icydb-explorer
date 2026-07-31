//! Test-only helpers shared across modules.
//!
//! Exists for one reason: **this repository commits no private key material,
//! not even a throwaway test key.** The tests that exercise the pem-loading
//! path need a real, parseable secp256k1 key, so they generate one into a
//! temporary directory at run time instead of reading a committed `.pem`.
//!
//! Two committed fixture keys were removed from this repository's entire
//! history for exactly this reason. Re-adding one — however disposable — would
//! put private key material back into a public repository and trip secret
//! scanning again, so please do not "simplify" this away by committing a pem.

use std::path::PathBuf;
use std::process::Command;

/// Generates a fresh secp256k1 private key and returns the path to it.
///
/// The key is written under the system temp directory, keyed by `name` so two
/// tests never collide, and the directory is cleared on entry so a previous
/// run's leftovers cannot make a test pass spuriously. Nothing is cleaned up
/// afterwards: these are ephemeral, valueless keys in a temp directory, and
/// leaving them lets a failing test be inspected.
///
/// Shells out to `openssl` rather than taking a key-generation crate as a
/// dependency. `openssl ecparam -genkey` emits SEC1 (`BEGIN EC PRIVATE KEY`),
/// which is the format `ic_agent::identity::Secp256k1Identity::from_pem`
/// accepts. `openssl` ships on macOS and on every mainstream CI image; if it
/// is genuinely missing this panics with a message saying so, rather than
/// skipping and reporting a false pass.
pub fn generated_secp256k1_pem(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("icydb-explorer-testkey-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp key directory should be creatable");
    let path = dir.join("secp256k1.pem");

    let output = Command::new("openssl")
        .args(["ecparam", "-name", "secp256k1", "-genkey", "-noout", "-out"])
        .arg(&path)
        .output()
        .expect(
            "`openssl` is required to generate a throwaway test key; this repository \
             deliberately commits no .pem files",
        );

    assert!(
        output.status.success(),
        "openssl failed to generate a test key: status {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );

    path
}
