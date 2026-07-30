//! Obtains a PEM for an identity that has no file on disk by shelling out to
//! `icp identity export`.
//!
//! This is the only module in the app that handles private key material, and it
//! is written to that standard: the exported bytes are returned to the caller and
//! never written to disk, logged, or placed in an `AppError`. Failures report the
//! child's exit status and stderr only — never stdout.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::error::AppError;

/// How long to wait for `icp identity export` before giving up.
///
/// A password-protected identity makes the command prompt interactively, and an
/// interactive prompt may read `/dev/tty` directly rather than stdin — so closing
/// stdin does not guarantee the child exits. Without this bound the app would hang
/// with no feedback.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(20);

/// Builds the `icp identity export <name>` invocation, with stdin closed so an
/// interactive prompt cannot consume the app's stdin.
#[must_use]
pub fn export_command(name: &str) -> Command {
    let mut command = Command::new("icp");
    command
        .arg("identity")
        .arg("export")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Turns a finished export into pem bytes or a diagnostic.
///
/// `stdout` is deliberately never included in the error text: it holds the key.
pub fn parse_export_result(
    status: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
    name: &str,
) -> Result<Vec<u8>, AppError> {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    match status {
        Some(0) if stdout.is_empty() => Err(AppError::Agent(format!(
            "`icp identity export {name}` succeeded but produced no PEM output"
        ))),
        Some(0) => Ok(stdout.to_vec()),
        Some(code) => Err(AppError::Agent(format!(
            "`icp identity export {name}` failed with exit status {code}: {detail}"
        ))),
        None => Err(AppError::Agent(format!(
            "`icp identity export {name}` was terminated before it produced a PEM: {detail}"
        ))),
    }
}

/// Runs `icp identity export <name>` and returns the PEM bytes.
pub async fn export_pem(name: &str) -> Result<Vec<u8>, AppError> {
    let child = export_command(name).output();
    let output = match tokio::time::timeout(EXPORT_TIMEOUT, child).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::Agent(
                "`icp` was not found on PATH; identity export requires the icp CLI".to_string(),
            ))
        }
        Ok(Err(e)) => {
            return Err(AppError::Agent(format!(
                "could not run `icp identity export {name}`: {e}"
            )))
        }
        Err(_) => {
            return Err(AppError::Agent(format!(
                "`icp identity export {name}` timed out after {}s. This usually means the \
                 identity is password-protected and icp is waiting for input this app cannot \
                 supply; use a keyring or plaintext identity instead",
                EXPORT_TIMEOUT.as_secs()
            )))
        }
    };

    parse_export_result(
        output.status.code(),
        &output.stdout,
        &output.stderr,
        name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_documented_invocation() {
        let command = export_command("default");
        let std_command = command.as_std();
        assert_eq!(std_command.get_program(), "icp");
        let args: Vec<_> = std_command.get_args().collect();
        assert_eq!(args, ["identity", "export", "default"]);
    }

    #[test]
    fn success_returns_the_pem_bytes() {
        let pem = b"-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n";
        let bytes = parse_export_result(Some(0), pem, b"", "default").expect("should succeed");
        assert_eq!(bytes, pem);
    }

    #[test]
    fn nonzero_exit_reports_status_and_stderr_but_never_stdout() {
        // `Vec<u8>` (the `Ok` type here) implements `Debug`, so clippy's
        // `err_expect` lint wants `expect_err` over the brief's literal
        // `.err().expect(..)` — same assertion, matching the convention
        // `identity.rs` documents for the opposite case (a non-`Debug` `Ok`
        // type, where `expect_err` isn't available).
        let error = parse_export_result(
            Some(1),
            b"-----BEGIN EC PRIVATE KEY-----\nSECRET\n",
            b"identity \"nope\" does not exist",
            "nope",
        )
        .expect_err("should fail");
        let text = error.explanation();
        assert!(text.contains("nope"), "should name the identity: {text}");
        assert!(text.contains("does not exist"), "should carry stderr: {text}");
        assert!(!text.contains("SECRET"), "must never leak stdout: {text}");
        assert!(!text.contains("BEGIN EC PRIVATE KEY"), "must never leak stdout: {text}");
    }

    #[test]
    fn empty_stdout_on_success_is_an_error() {
        let error = parse_export_result(Some(0), b"", b"", "default")
            .expect_err("empty output should fail");
        assert!(error.explanation().contains("default"));
    }

    #[test]
    fn a_signal_death_has_no_exit_code_and_is_reported() {
        let error = parse_export_result(None, b"", b"", "default")
            .expect_err("no exit status should fail");
        assert!(error.explanation().contains("default"));
    }
}
