# icp identity support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the explorer sign queries with the user's `icp` CLI identity — including keyring-backed identities it currently cannot load — and let the user pick which identity from within the app.

**Architecture:** A new `agent/export.rs` shells out to `icp identity export <name>` to obtain a pem for identities with no file on disk, splitting command construction and result parsing into pure, testable functions. `discovery` learns to enumerate every identity rather than only the default, and `IdentityRef` gains a `kind` with an optional `pem_path`. `AgentPool` re-keys by `(environment, identity)` so switching identity yields a different agent. A header dropdown drives session-only selection.

**Tech Stack:** Rust (Tauri 2, `ic-agent` 0.48, `tokio`), React 19 + Vite + Tailwind 4, `cargo test` + Vitest.

## Global Constraints

- `icydb` is pinned exactly `=0.202.1` with `features = ["sql-explain"]`, declared **once** in the workspace manifest and inherited via `{ workspace = true }`. Never reintroduce a second declaration.
- Rust toolchain **1.96.0**.
- The app is **read-only**. It must never call `icydb_ddl` or `icydb_update`, and must only use `ic-agent` query calls. There are currently exactly two network call sites, both `agent.query` — keep it that way.
- **No icydb type outside `src-tauri/src/view/` and `src-tauri/src/sql/transport.rs`.** This is the architecture's central bet; the frontend must never import, mirror, or hand-decode one.
- **User-facing copy must not claim the app enforces read-only access as a security boundary.** The canister's `readonly = true` is the guarantee; the app's statement classifier is a UX affordance.
- Exhaustive matches on `OutputValue` and `SqlQueryResult` — no `_ =>` arms.
- **Private key material never reaches disk, a log, a panic message, or an `AppError`.** Failures report exit status and stderr, never stdout.
- **One approved dependency change:** `tokio`'s features grow from `["sync"]` to `["sync", "process", "time"]`. No new crates. Justification: the export subprocess needs a timeout, and `std::process` has none. See Task 2.
- Test fixtures must be **captured from the real thing's shape**, never authored to match the code's assumptions. The prior phase's Critical finding came from exactly that mistake.

---

## File Structure

### Backend (`src-tauri/src/`)

| File | Responsibility | Change |
|---|---|---|
| `agent/export.rs` | Build the `icp identity export` command, run it, parse the result | **new** |
| `agent/identity.rs` | Dispatch on identity kind, then algorithm; load from bytes | modify |
| `agent/mod.rs` | `AgentPool` keyed by `(environment, identity)` | modify |
| `discovery/types.rs` | `IdentityRef` gains `kind`, `pem_path` becomes optional; `Environment` gains `identities` | modify |
| `discovery/icp_dir.rs` | Enumerate all identities, not only the default | modify |
| `commands.rs` | Thread the selected identity; add `select_identity` | modify |

### Frontend (`src/`)

| File | Responsibility | Change |
|---|---|---|
| `components/IdentitySelector.tsx` | Header dropdown; disabled rows with reasons | **new** |
| `api/types.ts` | `IdentityRef` mirror gains `kind`, optional `pemPath`; `Environment` gains `identities` | modify |
| `api/commands.ts` | `selectIdentity` wrapper; identity arg on existing wrappers | modify |
| `App.tsx` | Session identity state, threading, refetch on change | modify |

---

## Task 1: Resolve the Keychain unknown before building anything

**Files:**
- Create: `docs/superpowers/notes/2026-07-30-icp-export-spike.md`

**Interfaces:**
- Consumes: nothing
- Produces: a documented answer that Tasks 2–8 depend on

**Why this is Task 1.** The spec records one unknown that can invalidate the entire approach: whether `icp identity export` can read a Keychain-backed key from a **non-interactive subprocess**. If macOS refuses, exporting is unworkable and the fallback is delegating calls to `icp canister call` — a different design. Building the UI first and discovering this last would waste six tasks.

- [ ] **Step 1: Determine whether a non-interactive export succeeds**

Run the export as a subprocess with stdin closed, exactly as the app will. From the repo root:

```bash
icp identity export default < /dev/null > /tmp/icp-export-probe.out 2> /tmp/icp-export-probe.err; echo "exit=$?"
```

**Do not print the contents of `/tmp/icp-export-probe.out` — it is a private key.** Inspect only its shape:

```bash
echo "bytes: $(wc -c < /tmp/icp-export-probe.out)"
head -1 /tmp/icp-export-probe.out
tail -1 /tmp/icp-export-probe.out
cat /tmp/icp-export-probe.err
```

Then delete it immediately: `rm -f /tmp/icp-export-probe.out /tmp/icp-export-probe.err`

Record: exit status, whether a Keychain dialog appeared, byte count, and the first and last lines (PEM armour headers are not secret; the base64 body is).

**If this command is blocked by a safety classifier in your environment, stop and report that.** Do not attempt to work around it. Extracting a private key is exactly the kind of action such a block exists for, and the honest outcome is to hand the question back rather than route around the guard.

- [ ] **Step 2: Determine the PEM's key type**

The armour header distinguishes key types without exposing the key. Record whether it is `-----BEGIN EC PRIVATE KEY-----` (sec1, typical secp256k1/prime256v1) or `-----BEGIN PRIVATE KEY-----` (pkcs8). `Secp256k1Identity::from_pem` accepts both, but knowing which one arrives tells Task 4 what it is actually parsing.

- [ ] **Step 3: Write the spike note**

Create `docs/superpowers/notes/2026-07-30-icp-export-spike.md` recording: the exact command, exit status, whether a Keychain prompt appeared and whether it was answerable, the PEM armour type, and a plain verdict — **approach viable** or **approach blocked**.

If blocked, stop here and report. The remaining tasks assume viability.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-07-30-icp-export-spike.md
git commit -m "docs: record icp identity export spike findings"
```

---

## Task 2: `agent/export.rs` — obtain a pem from icp

**Files:**
- Create: `src-tauri/src/agent/export.rs`
- Modify: `src-tauri/src/agent/mod.rs` (add `mod export;`), `src-tauri/Cargo.toml` (tokio features)
- Test: inline `#[cfg(test)]` in `export.rs`

**Interfaces:**
- Consumes: `AppError` from `crate::error`
- Produces:
  - `pub fn export_command(name: &str) -> tokio::process::Command`
  - `pub fn parse_export_result(status: Option<i32>, stdout: &[u8], stderr: &[u8], name: &str) -> Result<Vec<u8>, AppError>`
  - `pub async fn export_pem(name: &str) -> Result<Vec<u8>, AppError>`

- [ ] **Step 1: Widen tokio's features**

In `src-tauri/Cargo.toml`, change the tokio line to:

```toml
tokio = { version = "1", features = ["sync", "process", "time"] }
```

`std::process` offers no timeout. A password-protected identity makes `icp identity export` prompt, and an interactive prompt may read `/dev/tty` directly rather than stdin — so closing stdin is **not** sufficient to guarantee the child exits. Without a timeout the app would hang with no UI feedback. `process` and `time` are features of a crate already in the dependency set; no new crate is added.

- [ ] **Step 2: Write the failing tests**

```rust
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
        let error = parse_export_result(
            Some(1),
            b"-----BEGIN EC PRIVATE KEY-----\nSECRET\n",
            b"identity \"nope\" does not exist",
            "nope",
        )
        .err()
        .expect("should fail");
        let text = error.explanation();
        assert!(text.contains("nope"), "should name the identity: {text}");
        assert!(text.contains("does not exist"), "should carry stderr: {text}");
        assert!(!text.contains("SECRET"), "must never leak stdout: {text}");
        assert!(!text.contains("BEGIN EC PRIVATE KEY"), "must never leak stdout: {text}");
    }

    #[test]
    fn empty_stdout_on_success_is_an_error() {
        let error = parse_export_result(Some(0), b"", b"", "default")
            .err()
            .expect("empty output should fail");
        assert!(error.explanation().contains("default"));
    }

    #[test]
    fn a_signal_death_has_no_exit_code_and_is_reported() {
        let error = parse_export_result(None, b"", b"", "default")
            .err()
            .expect("no exit status should fail");
        assert!(error.explanation().contains("default"));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test agent::export`
Expected: FAIL — `export_command` and `parse_export_result` not found.

- [ ] **Step 4: Implement `export_command` and `parse_export_result`**

```rust
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test agent::export`
Expected: PASS, 5 tests.

- [ ] **Step 6: Implement `export_pem`**

```rust
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
```

- [ ] **Step 7: Wire the module and verify the suite**

Add `mod export;` to `src-tauri/src/agent/mod.rs` and re-export `export_pem`.

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/agent/export.rs src-tauri/src/agent/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: export identity pems via the icp CLI"
```

---

## Task 3: `discovery` — enumerate every identity

**Files:**
- Modify: `src-tauri/src/discovery/types.rs`, `src-tauri/src/discovery/icp_dir.rs`
- Create: `src-tauri/tests/fixtures/identity_stores/mixed_kinds/identity_list.json`, `.../identity_defaults.json`
- Test: inline `#[cfg(test)]` in `icp_dir.rs`

**Interfaces:**
- Consumes: `AppError`
- Produces:
  - `pub struct IdentityRef { pub name: String, pub algorithm: String, pub kind: String, pub pem_path: Option<PathBuf>, pub unusable_reason: Option<String> }`
  - `IdentityRef::new(name: String, algorithm: String, kind: String, pem_path: Option<PathBuf>) -> Self` — the **only** place the usability rule is expressed
  - `IdentityRef::is_usable(&self) -> bool`
  - `Environment` gains `pub identities: Vec<IdentityRef>`

`unusable_reason` is a **serialised field**, computed once in `new`, not a method.
The frontend renders it verbatim rather than re-deriving the rule, so the rule
exists in exactly one place in the codebase.

**Two type changes that make an existing lie honest.** `pem_path: PathBuf` asserts every identity has a file — which is exactly what made keyring unrepresentable. It becomes `Option<PathBuf>`. And `kind` must be carried, because it decides how the key is obtained and why an identity is unusable.

- [ ] **Step 1: Create the mixed-kinds fixture**

`src-tauri/tests/fixtures/identity_stores/mixed_kinds/identity_defaults.json`:

```json
{
  "v": 1,
  "default": "keyring-one"
}
```

`src-tauri/tests/fixtures/identity_stores/mixed_kinds/identity_list.json` — shapes copied from the two real stores (this machine's keyring default and toko's plaintext pem), plus an invented-but-plausible unknown kind so the defensive path is exercised:

```json
{
  "v": 1,
  "identities": {
    "keyring-one": {
      "kind": "keyring",
      "principal": "4773j-66d63-ojsup-pra54-4uto5-kxmpd-lizbp-nk6et-uvn4p-chybm-nae",
      "algorithm": "secp256k1"
    },
    "pem-one": {
      "kind": "pem",
      "format": "plaintext",
      "algorithm": "secp256k1",
      "principal": "j524y-jtmzv-omb6g-wh6rn-mxhkh-dzg5v-ct2r5-2s742-rvyxm-jgqmi-xqe"
    },
    "future-kind": {
      "kind": "delegation",
      "algorithm": "secp256k1",
      "principal": "aaaaa-aa"
    },
    "anonymous": {
      "kind": "anonymous"
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

```rust
#[test]
fn enumerates_every_identity_with_its_kind() {
    let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
    let identities = read_all_identities(store).expect("should read the store");
    let mut names: Vec<&str> = identities.iter().map(|i| i.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["anonymous", "future-kind", "keyring-one", "pem-one"]);
}

#[test]
fn a_keyring_identity_has_a_kind_and_no_pem_path() {
    let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
    let identities = read_all_identities(store).unwrap();
    let keyring = identities.iter().find(|i| i.name == "keyring-one").unwrap();
    assert_eq!(keyring.kind, "keyring");
    assert_eq!(keyring.algorithm, "secp256k1");
    assert!(keyring.pem_path.is_none(), "keyring identities have no file");
    assert!(keyring.is_usable());
}

#[test]
fn a_pem_identity_keeps_its_path() {
    let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
    let identities = read_all_identities(store).unwrap();
    let pem = identities.iter().find(|i| i.name == "pem-one").unwrap();
    assert_eq!(pem.kind, "pem");
    assert!(pem.pem_path.as_ref().unwrap().ends_with("keys/pem-one.pem"));
    assert!(pem.is_usable());
}

#[test]
fn anonymous_is_unusable_because_endpoints_are_controller_gated() {
    let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
    let identities = read_all_identities(store).unwrap();
    let anonymous = identities.iter().find(|i| i.name == "anonymous").unwrap();
    assert!(!anonymous.is_usable());
    let reason = anonymous.unusable_reason.as_ref().expect("should give a reason");
    assert!(reason.contains("controller-gated"), "got: {reason}");
}

#[test]
fn an_unrecognised_kind_is_unusable_and_names_itself() {
    let store = Path::new("tests/fixtures/identity_stores/mixed_kinds");
    let identities = read_all_identities(store).unwrap();
    let future = identities.iter().find(|i| i.name == "future-kind").unwrap();
    assert!(!future.is_usable());
    let reason = future.unusable_reason.as_ref().expect("should give a reason");
    assert!(reason.contains("delegation"), "should name the kind: {reason}");
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test discovery`
Expected: FAIL — `read_all_identities` not found.

- [ ] **Step 4: Update the types**

In `discovery/types.rs`, replace `IdentityRef` with:

```rust
/// One identity from an icp identity store.
///
/// `pem_path` is `None` for kinds whose key is not a file — a `keyring`
/// identity's key lives in the OS keychain, which is why the previous
/// non-optional `PathBuf` made keyring identities unrepresentable.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    pub name: String,
    pub algorithm: String,
    pub kind: String,
    pub pem_path: Option<PathBuf>,
    /// Why this app cannot use this identity, or `None` if it can.
    ///
    /// A serialised field rather than a method, computed once in
    /// [`IdentityRef::new`], so the frontend renders this text instead of
    /// re-implementing the rule in TypeScript. The rule lives in exactly one
    /// place in the codebase.
    pub unusable_reason: Option<String>,
}

impl IdentityRef {
    /// Builds an `IdentityRef`, deriving `unusable_reason` from the kind.
    ///
    /// icp's storage kinds are `plaintext`, `keyring`, and `password`
    /// (`icp identity new --storage`). `plaintext` surfaces here as kind
    /// `pem`. `password` has not been observed in a real store, so any
    /// unrecognised kind is reported as unusable by name rather than
    /// assumed loadable — a wrong guess would fail confusingly at query
    /// time instead of clearly at selection time.
    #[must_use]
    pub fn new(
        name: String,
        algorithm: String,
        kind: String,
        pem_path: Option<PathBuf>,
    ) -> Self {
        let unusable_reason = match kind.as_str() {
            "pem" if pem_path.is_none() => {
                Some("pem identity with no key file recorded".to_string())
            }
            "pem" | "keyring" => None,
            "anonymous" => Some(
                "the anonymous identity cannot be used: icydb's SQL endpoints are \
                 controller-gated"
                    .to_string(),
            ),
            other => Some(format!(
                "identity kind \"{other}\" is not supported by this app: it cannot be \
                 exported as a PEM"
            )),
        };

        Self { name, algorithm, kind, pem_path, unusable_reason }
    }

    /// Whether this app can obtain a signing key for this identity.
    #[must_use]
    pub fn is_usable(&self) -> bool {
        self.unusable_reason.is_none()
    }
}
```

Add to `Environment`, after `identity`:

```rust
    /// Every identity the resolved store declares, usable or not. The UI lists
    /// all of them so an unsupported identity reads as unsupported rather than
    /// missing.
    pub identities: Vec<IdentityRef>,
```

- [ ] **Step 5: Implement `read_all_identities`**

In `discovery/icp_dir.rs`, add a function that reads `identity_list.json` from the given store directory and returns every entry as an `IdentityRef`:

- `name` is the map key.
- `kind` is the entry's `kind` string; an entry with no `kind` is an error (`AppError::Parse`) naming the identity.
- `algorithm` is the entry's `algorithm` string, defaulting to `"secp256k1"` when absent — `anonymous` entries have no algorithm and must not fail the whole read.
- `pem_path` is `Some(<store>/keys/<name>.pem)` when `kind == "pem"`, otherwise `None`.
- Build every `IdentityRef` through `IdentityRef::new(..)` — never a struct literal — so
  `unusable_reason` cannot be forgotten or computed twice.

Refactor the existing default-identity read to build its `IdentityRef` through the same per-entry conversion, so the two paths cannot disagree about `kind` or `pem_path`. Then populate `Environment.identities` wherever `Environment.identity` is currently set, from the same resolved store.

No `unwrap`/`expect` on any IO or JSON path.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test discovery`
Expected: PASS — the 5 new tests plus every pre-existing discovery test.

Pre-existing tests referencing `pem_path` will need `Some(...)`; adapt the expression, never the assertion's strength.

- [ ] **Step 7: Verify the whole suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/discovery src-tauri/tests/fixtures/identity_stores/mixed_kinds
git commit -m "feat: enumerate every icp identity with its kind"
```

---

## Task 4: `agent/identity.rs` — dispatch on kind, and support prime256v1

**Files:**
- Modify: `src-tauri/src/agent/identity.rs`
- Test: inline `#[cfg(test)]` in `identity.rs`

**Interfaces:**
- Consumes: `IdentityRef` (Task 3), `export_pem` (Task 2), `AppError`
- Produces: `pub async fn load_identity(identity: &IdentityRef) -> Result<Box<dyn ic_agent::Identity>, AppError>`

Note `load_identity` becomes **async**, because a keyring identity requires the export subprocess. Callers in Task 5 change accordingly.

**A bonus correction.** `icp identity import --assert-key-type` lists `secp256k1`, `prime256v1`, `ed25519`. The current loader handles only the first and last, so a legitimate `prime256v1` identity fails as "unsupported". ic-agent provides `Prime256v1Identity::from_pem`; add it.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn pem_identity(algorithm: &str, file: &str) -> IdentityRef {
        IdentityRef::new(
            "demo-local".into(),
            algorithm.into(),
            "pem".into(),
            Some(PathBuf::from("tests/fixtures").join(file)),
        )
    }

    #[tokio::test]
    async fn loads_a_secp256k1_pem_from_disk() {
        let identity = load_identity(&pem_identity("secp256k1", "secp256k1.pem"))
            .await
            .expect("secp256k1 pem should load");
        assert!(identity.sender().is_ok());
    }

    #[tokio::test]
    async fn unknown_algorithm_is_an_error_naming_it() {
        let error = load_identity(&pem_identity("rsa9000", "secp256k1.pem"))
            .await
            .err()
            .expect("should fail");
        assert!(error.explanation().contains("rsa9000"));
    }

    #[tokio::test]
    async fn a_pem_kind_with_no_path_is_an_error_not_a_panic() {
        let identity =
            IdentityRef::new("broken".into(), "secp256k1".into(), "pem".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("broken"));
    }

    #[tokio::test]
    async fn anonymous_is_refused_before_any_subprocess_runs() {
        let identity =
            IdentityRef::new("anonymous".into(), "secp256k1".into(), "anonymous".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("controller-gated"));
    }

    #[tokio::test]
    async fn an_unrecognised_kind_is_refused_naming_the_kind() {
        let identity =
            IdentityRef::new("future".into(), "secp256k1".into(), "delegation".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("delegation"));
    }
}
```

- [ ] **Step 2: Add the async test runtime as a dev-dependency feature**

`tokio` already gains `process` and `time` in Task 2. `#[tokio::test]` additionally needs `macros` and `rt`. Add a dev-dependencies entry in `src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt", "rt-multi-thread"] }
```

If a `[dev-dependencies]` section already exists with tokio, merge the features rather than duplicating the key.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test agent::identity`
Expected: FAIL — `load_identity` is not async and the `kind` field does not exist on the constructed literals.

- [ ] **Step 4: Implement kind dispatch**

Rewrite `identity.rs` so `load_identity` dispatches on `kind` first, obtains pem bytes, then dispatches on algorithm:

```rust
use ic_agent::identity::{BasicIdentity, Prime256v1Identity, Secp256k1Identity};
use ic_agent::Identity;

use crate::agent::export::export_pem;
use crate::discovery::IdentityRef;
use crate::error::AppError;

/// Loads an `ic_agent::Identity` for `identity`.
///
/// Dispatches on kind to obtain PEM bytes — read from disk for a `pem`
/// identity, exported via the icp CLI for a `keyring` one — then on algorithm
/// to choose a loader. Unusable kinds are refused before any subprocess runs.
pub async fn load_identity(identity: &IdentityRef) -> Result<Box<dyn Identity>, AppError> {
    if let Some(reason) = identity.unusable_reason.as_ref() {
        return Err(AppError::Agent(format!(
            "identity \"{}\" cannot be used: {reason}",
            identity.name
        )));
    }

    let pem = match identity.kind.as_str() {
        "pem" => {
            let path = identity.pem_path.as_ref().ok_or_else(|| {
                AppError::Agent(format!(
                    "identity \"{}\" is a pem identity with no key file recorded",
                    identity.name
                ))
            })?;
            std::fs::read(path).map_err(|e| {
                AppError::Agent(format!(
                    "could not read the pem for identity \"{}\": {e}",
                    identity.name
                ))
            })?
        }
        "keyring" => export_pem(&identity.name).await?,
        other => {
            return Err(AppError::Agent(format!(
                "identity \"{}\" has kind \"{other}\", which this app cannot load",
                identity.name
            )))
        }
    };

    identity_from_pem(&pem, &identity.algorithm, &identity.name)
}

/// Chooses a loader by algorithm and parses `pem`.
///
/// `prime256v1` is included because `icp identity import --assert-key-type`
/// accepts it alongside `secp256k1` and `ed25519`.
fn identity_from_pem(
    pem: &[u8],
    algorithm: &str,
    name: &str,
) -> Result<Box<dyn Identity>, AppError> {
    match algorithm {
        "secp256k1" => Secp256k1Identity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load secp256k1 pem for \"{name}\": {e}"))),
        "prime256v1" => Prime256v1Identity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load prime256v1 pem for \"{name}\": {e}"))),
        "ed25519" => BasicIdentity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load ed25519 pem for \"{name}\": {e}"))),
        other => Err(AppError::Agent(format!(
            "unsupported identity algorithm \"{other}\" for \"{name}\": expected \
             \"secp256k1\", \"prime256v1\", or \"ed25519\""
        ))),
    }
}
```

Note the error messages must never include `pem` — only the identity name and the parse error.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test agent::identity`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify the whole suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS. `AgentPool::get` will not compile until Task 5 awaits `load_identity`; if it breaks here, make the minimal `.await` change now and note it.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/agent/identity.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: load keyring identities and support prime256v1"
```

---

## Task 5: `AgentPool` keyed by `(environment, identity)`

**Files:**
- Modify: `src-tauri/src/agent/mod.rs`
- Test: inline `#[cfg(test)]` in `agent/mod.rs`

**Interfaces:**
- Consumes: `Environment`, `IdentityRef` (Task 3); `load_identity` (Task 4)
- Produces: `pub async fn get(&self, env: &Environment, identity: &IdentityRef) -> Result<Arc<ic_agent::Agent>, AppError>`

**Why this is its own task.** The pool is keyed by environment name alone. Once identity is selectable, that key silently returns the first identity's agent for every later selection — the UI would show one identity while queries used another. That is a wrong-data-shown-confidently failure, the class this project has hit repeatedly, so it gets its own test.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn the_cache_key_distinguishes_identities_within_one_environment() {
    assert_ne!(
        cache_key("local", "alice"),
        cache_key("local", "bob"),
        "two identities in one environment must not share an agent"
    );
    assert_ne!(
        cache_key("local", "alice"),
        cache_key("staging", "alice"),
        "one identity in two environments must not share an agent"
    );
    assert_eq!(cache_key("local", "alice"), cache_key("local", "alice"));
}

#[test]
fn the_cache_key_cannot_be_confused_by_a_separator_in_a_name() {
    assert_ne!(
        cache_key("local:alice", "bob"),
        cache_key("local", "alice:bob"),
        "a name containing the separator must not collide with another pair"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test agent::tests::the_cache_key`
Expected: FAIL — `cache_key` not found.

- [ ] **Step 3: Implement the key and re-key the pool**

```rust
/// Builds the pool's cache key.
///
/// Length-prefixed rather than joined with a separator, so an environment or
/// identity name containing the separator cannot collide with a different pair.
fn cache_key(env: &str, identity: &str) -> String {
    format!("{}:{env}:{}:{identity}", env.len(), identity.len())
}
```

Change the pool's map to `Mutex<HashMap<String, Arc<Agent>>>` keyed by `cache_key(...)`, and change `get` to take `identity: &IdentityRef`, `await` `load_identity(identity)`, and pass the result to `.with_boxed_identity(...)`.

Replace `identity_for(env)` with the caller supplying the identity — the "no usable identity" message moves to `commands.rs` in Task 6, where the selection is known. Delete `identity_for` and its test if it no longer has a caller; do not leave it dead.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test agent`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS. `commands.rs` will not compile until Task 6; make the minimal signature changes needed to keep the build green and note them.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/agent/mod.rs
git commit -m "feat: key the agent pool by environment and identity"
```

---

## Task 6: `commands.rs` — thread the selected identity

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` in `commands.rs`

**Interfaces:**
- Consumes: everything from Tasks 3–5
- Produces the frontend contract:
  - `select_identity(env: String, identity: String) -> ()` — exports eagerly, returns the failure if any
  - `canister_tree(env, identity)`, `list_tables(env, canister, identity)`, `describe_table(env, canister, entity, identity)`, `fetch_rows(env, canister, entity, offset, identity)`, `run_sql(env, canister, sql, identity)`
  - `list_environments()` unchanged
  - `pub fn find_identity(env: &Environment, name: &str) -> Result<&IdentityRef, AppError>`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn find_identity_reports_a_missing_name_rather_than_panicking() {
    let env = Environment {
        name: "local".into(),
        replica_url: "http://127.0.0.1:4943".into(),
        canisters: Vec::new(),
        identity: None,
        identities: vec![IdentityRef::new(
            "alice".into(),
            "secp256k1".into(),
            "keyring".into(),
            None,
        )],
        artifacts: Vec::new(),
    };

    assert_eq!(find_identity(&env, "alice").unwrap().name, "alice");

    let error = find_identity(&env, "nope").err().expect("should fail");
    let text = error.explanation();
    assert!(text.contains("nope"), "should name the identity: {text}");
    assert!(text.contains("local"), "should name the environment: {text}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `find_identity` not found.

- [ ] **Step 3: Implement `find_identity` and thread the parameter**

```rust
/// Finds the identity named `name` in `env`, or a clear error rather than a
/// panic if the store changed since the frontend last listed environments.
pub fn find_identity<'a>(env: &'a Environment, name: &str) -> Result<&'a IdentityRef, AppError> {
    env.identities
        .iter()
        .find(|identity| identity.name == name)
        .ok_or_else(|| {
            AppError::Agent(format!(
                "environment \"{}\" has no identity named \"{name}\"; the icp identity store \
                 may have changed since this window opened",
                env.name
            ))
        })
}
```

Add `identity: String` as the final parameter of `canister_tree`, `list_tables`, `describe_table`, `fetch_rows`, and `run_sql`, resolve it with `find_identity`, and pass it to `pool.get(environment, identity)`. `run_query`'s existing `identity: &str` argument becomes `identity.name.as_str()`.

Add the eager-export command:

```rust
/// Loads the named identity now, so a failure surfaces when the user selects
/// it rather than on their first query.
#[tauri::command]
pub async fn select_identity(
    env: String,
    identity: String,
    project: State<'_, Project>,
    pool: State<'_, AgentPool>,
) -> Result<(), AppError> {
    let environment = find_environment(&project, &env)?;
    let identity_ref = find_identity(environment, &identity)?;
    pool.get(environment, identity_ref).await?;
    Ok(())
}
```

Register `select_identity` in `lib.rs`'s `invoke_handler`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test commands`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add select_identity and thread identity through commands"
```

---

## Task 7: Frontend — the identity selector

**Files:**
- Create: `src/components/IdentitySelector.tsx`, `src/components/IdentitySelector.test.tsx`
- Modify: `src/api/types.ts`, `src/api/commands.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: the Task 6 command surface
- Produces: `<IdentitySelector identities={IdentityRef[]} selected={string | null} onSelect={(name: string) => void} />`

- [ ] **Step 1: Update the TypeScript mirrors**

In `src/api/types.ts`, replace the `IdentityRef` type and extend `Environment`:

```ts
export type IdentityRef = {
  name: string;
  algorithm: string;
  kind: string;
  pemPath: string | null;
  /// Why this app cannot use this identity, or null if it can. Computed by
  /// `IdentityRef::new` in `src-tauri/src/discovery/types.rs` and rendered
  /// verbatim here — the rule is not re-implemented in TypeScript.
  unusableReason: string | null;
};

export type Environment = {
  name: string;
  replicaUrl: string;
  canisters: NamedCanister[];
  identity: IdentityRef | null;
  identities: IdentityRef[];
  artifacts: CanisterArtifact[];
};
```

- [ ] **Step 2: Write the failing tests**

```tsx
import { render, screen } from "@testing-library/react";
import { IdentitySelector } from "./IdentitySelector";
import type { IdentityRef } from "../api/types";

const keyring: IdentityRef = { name: "default", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null };
const anonymous: IdentityRef = { name: "anonymous", algorithm: "secp256k1", kind: "anonymous", pemPath: null, unusableReason: "the anonymous identity cannot be used: icydb's SQL endpoints are controller-gated" };
const future: IdentityRef = { name: "delegated", algorithm: "secp256k1", kind: "delegation", pemPath: null, unusableReason: "identity kind \"delegation\" is not supported by this app: it cannot be exported as a PEM" };

test("lists every identity, usable or not", () => {
  render(<IdentitySelector identities={[keyring, anonymous, future]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /default/ })).toBeDefined();
  expect(screen.getByRole("option", { name: /anonymous/ })).toBeDefined();
  expect(screen.getByRole("option", { name: /delegated/ })).toBeDefined();
});

test("disables identities the app cannot load", () => {
  render(<IdentitySelector identities={[keyring, anonymous]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /default/ })).not.toHaveAttribute("disabled");
  expect(screen.getByRole("option", { name: /anonymous/ })).toHaveAttribute("disabled");
});

test("gives the reason an identity is unusable", () => {
  render(<IdentitySelector identities={[keyring, future]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /delegation/ })).toBeDefined();
});

test("renders nothing rather than an empty control when there are no identities", () => {
  const { container } = render(<IdentitySelector identities={[]} selected={null} onSelect={() => {}} />);
  expect(container.querySelector("select")).toBeNull();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./IdentitySelector`.

- [ ] **Step 4: Implement `IdentitySelector.tsx`**

A `<select>` with one `<option>` per identity. Each option's label is `name (kind)`,
and when `unusableReason` is non-null the label appends ` — <reason>` and the option
carries `disabled`. Render `null` when `identities` is empty.

Read `unusableReason` straight off the DTO — do **not** re-derive it from `kind` in
TypeScript. The backend computes it once in `IdentityRef::new` and serialises it, so
the rule lives in exactly one place.

`IdentityRef` carries no principal, so don't display one — and don't invent it.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test`
Expected: PASS, 4 new tests.

- [ ] **Step 6: Wire `commands.ts`**

Add the final `identity` argument to `canisterTree`, `listTables`, `describeTable`, `fetchRows`, and `runSql`, and add:

```ts
export async function selectIdentity(env: string, identity: string): Promise<void> {
  return invokeCommand("select_identity", { env, identity });
}
```

Match the existing wrapper's error-normalisation helper rather than introducing a second one.

- [ ] **Step 7: Wire `App.tsx`**

- Hold `identity: string | null` in session state, initialised from the selected environment's `identity?.name ?? null` when environments load, falling back to the first usable entry in `identities` if the configured default is unusable.
- Render `<IdentitySelector>` in the header above the canister tree.
- On selection: call `selectIdentity(env, name)` first. On success set the state and let the existing effects refetch; on failure show the error and leave the previous selection in place — a failed switch must not leave the UI claiming an identity the backend rejected.
- Add `identity` to the dependency arrays of the three cascading fetch effects, and include it in the `selectionRef` snapshot so `loadMore` and `handleRunSql` are guarded against an identity change mid-flight exactly as they are against a canister change.
- Every command call passes the current identity; if `identity` is null, the effects early-return as they already do for a null environment.

- [ ] **Step 8: Verify everything**

```bash
npm test && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test)
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/api src/components/IdentitySelector.tsx src/components/IdentitySelector.test.tsx src/App.tsx
git commit -m "feat: add an identity selector to the explorer UI"
```

---

## Task 8: Live verification and documentation

**Files:**
- Modify: `src-tauri/tests/integration.rs`, `README.md`

**Interfaces:**
- Consumes: the complete feature

- [ ] **Step 1: Add the live export test**

An `#[ignore]`-gated test that exports this machine's configured default identity and asserts the resulting principal matches the `principal` recorded for it in `identity_list.json`. This proves the whole chain — enumerate, export, parse, load — without ever printing key material.

```rust
/// Live: exports the configured default identity and checks the principal it
/// produces against the one recorded in the store. Requires a real icp
/// identity store and the `icp` binary.
///
/// Run with: cargo test --test integration -- --ignored
#[tokio::test]
#[ignore = "requires a real icp identity store and the icp CLI"]
async fn the_default_identity_loads_and_matches_its_recorded_principal() {
    let store = user_level_identity_store().expect("a user-level icp store should exist");
    let identities = read_all_identities(&store).expect("store should read");
    let defaults = read_default_identity_name(&store).expect("a default should be configured");
    let identity = identities
        .iter()
        .find(|i| i.name == defaults)
        .expect("the default should be present in the store");
    if !identity.is_usable() {
        eprintln!("default identity \"{}\" is kind \"{}\" — skipping", identity.name, identity.kind);
        return;
    }

    let loaded = load_identity(identity).await.expect("default identity should load");
    let recorded = recorded_principal(&store, &identity.name).expect("store records a principal");
    assert_eq!(
        loaded.sender().expect("sender").to_text(),
        recorded,
        "the exported key must produce the principal the store recorded"
    );
}
```

Expose whatever helpers this needs (`user_level_identity_store`, `read_default_identity_name`, `recorded_principal`) as `pub` from `discovery`, adding `recorded_principal` if the store's principal is not already captured. Do **not** add `principal` to `IdentityRef` solely for this test unless the UI needs it — a test-only reader is preferable to widening a serialised type.

- [ ] **Step 2: Run the live test**

```bash
cd src-tauri && cargo test --test integration -- --ignored the_default_identity_loads
```

Expected: PASS, and the principal matches `4773j-66d63-ojsup-pra54-4uto5-kxmpd-lizbp-nk6et-uvn4p-chybm-nae`.

If a Keychain dialog appears, note it — Task 1's spike should have predicted it, and a discrepancy between the spike and this run is worth reporting.

- [ ] **Step 3: Verify end to end against the fixture canister**

```bash
icp start --background
icp canister create fixture && icp canister install fixture
npm run tauri dev
```

Confirm the identity selector lists `default` and `anonymous`, that `anonymous` is disabled with its reason, and that selecting `default` then browsing a table returns rows — the path that has never worked before this feature.

**Be honest about what you can observe.** If you cannot see the window, say so and report what you verified instead. An accurate "launched cleanly; could not inspect the selector" is worth more than a confident claim.

- [ ] **Step 4: Update `README.md`**

- Replace any statement that the app requires a pem-based identity: keyring-backed identities now work via `icp identity export`.
- Document that identity selection is session-only and starts from `icp identity default`.
- Note that password-protected identities (`icp identity new --storage password`) are **not** supported: icp prompts for a password the app cannot supply, and the export times out with an explanatory error.
- Record the three storage kinds (`plaintext`, `keyring`, `password`) so a reader knows which of their identities will work.
- Note that `prime256v1` is now supported alongside `secp256k1` and `ed25519`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/integration.rs README.md src-tauri/src/discovery
git commit -m "test: verify the default identity loads live; document identity support"
```

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to a task: the Keychain unknown → Task 1; `agent/export.rs` with its three safety properties → Task 2; identity enumeration and the two type changes → Task 3; kind dispatch → Task 4; pool re-keying → Task 5; command threading and `select_identity` → Task 6; the selector, session-only state, and disabled-with-reason → Task 7; live verification and README → Task 8. The spec's error-handling table is distributed across Tasks 2, 4, and 6, each with a test asserting the message content.

**The second spec unknown is resolved in the plan, not deferred.** icp's storage kinds are exactly `plaintext`, `keyring`, `password` (`icp identity new --storage`). Rather than guess how `password` appears in `identity_list.json`, Task 3 treats every unrecognised kind as unusable-by-name — so an unobserved kind produces a clear error at selection time instead of a confusing one at query time.

**One bonus correction folded in.** `prime256v1` is a legitimate icp key type (`icp identity import --assert-key-type`) that the current loader rejects. Task 4 adds it; it is two lines and prevents a real identity failing as "unsupported".

**Deliberate ordering.** Task 1 is a spike, not TDD, because it answers a question that can invalidate Tasks 2–8. Tasks 4 and 5 each note that a downstream file may not compile until the next task lands; that is expected and each task keeps the build green with a minimal signature change rather than leaving it broken.

**Type consistency.** `IdentityRef` is `{ name, algorithm, kind, pem_path: Option<PathBuf> }` in Task 3 and used with that exact shape in Tasks 4, 6, and 7. `load_identity` is async from Task 4 onward and awaited in Task 5. `pool.get` takes `(&Environment, &IdentityRef)` from Task 5 and is called that way in Task 6. The TS `IdentityRef` in Task 7 mirrors the Rust field names under the existing camelCase rename (`pemPath`).

**No duplicated rule.** An earlier draft implemented `unusableReason` in both Rust and
TypeScript with Rust authoritative. That was changed before execution: the reason is
computed once in `IdentityRef::new`, carried as a serialised field, and rendered
verbatim by the selector. One rule, one place.
