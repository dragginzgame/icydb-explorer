# icp identity support — Design

**Date:** 2026-07-30
**Status:** Approved
**Follows:** `2026-07-29-icydb-explorer-design.md`

## Purpose

Let the explorer sign queries with the user's `icp` CLI identity, including
**keyring**-kind identities it currently cannot load, and let the user choose which
identity to use from within the app.

## The gap this closes

The explorer's identity loader reads a pem file from disk. That works for
project-local identities like toko's (`kind: "pem"`, `format: "plaintext"`), but the
user-level `icp` store on this machine holds:

```json
{
  "v": 1,
  "identities": {
    "default": {
      "kind": "keyring",
      "principal": "4773j-66d63-ojsup-pra54-4uto5-kxmpd-lizbp-nk6et-uvn4p-chybm-nae",
      "algorithm": "secp256k1"
    },
    "anonymous": { "kind": "anonymous" }
  }
}
```

There is **no pem file** — the key lives in the macOS Keychain. So
`read_identity_from_store` correctly returns `Ok(None)` for any non-pem kind, and
`identity_for` then fails with a clear controller-gated error. Discovery and the
canister tree work; live queries do not.

## Verified facts

Established by inspection, not inference:

| Fact | Evidence |
|---|---|
| `icp identity export <NAME>` prints the identity's PEM to stdout | `icp identity export --help` |
| It accepts `--password-file`, `--encrypt`, `--encryption-password-file` | same |
| It prompts interactively for identities created with `--storage password` | `--password-file` help text: "Read the password from a file instead of prompting (only required for identities created or imported with `--storage password`)" |
| `identity_list.json` carries name, kind, algorithm, and principal for every identity | read directly from the user-level store |
| Observed kinds so far: `keyring`, `pem`, `anonymous` | this machine's store, plus toko's |
| icp also supports Internet Identity delegations | `icp identity delegation`, `icp identity reauth` subcommands exist |
| Keychain services `icp-cli` and `internet_computer_identities` exist | `security find-generic-password -s …` |

**Not verified, deliberately.** Running `icp identity export` was blocked by a safety
classifier because it extracts a private key to stdout. That block was not worked
around. The design therefore rests on the documented `--help` contract, and the plan
must verify the runtime behaviour — see "Unknowns the plan must resolve".

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| How to obtain a key | Shell out to `icp identity export <name>` | Documented, covers keyring and pem uniformly, and delegates Keychain interaction to the tool that owns it |
| Identity selection | Selector in the app, listing all identities | The user asked for it; enumeration needs no subprocess since `identity_list.json` has everything |
| Persistence | Session only, initialised to icp's configured default | No new on-disk config, and the app's notion of "current identity" cannot drift from `icp identity default` |
| Unusable kinds | Shown, disabled, with the reason inline | Silently omitting things is the failure mode this project was bitten by twice |
| When to export | Eagerly on selection | Immediate feedback, and any Keychain prompt happens at the moment the user acted |
| Rejected: direct Keychain access | — | Undocumented service/account naming, macOS-only, duplicates icp's own logic |
| Rejected: delegate every call to `icp canister call` | — | Better security posture, but replaces the ic-agent transport and pays a process spawn per query. Reconsider only if export proves unworkable. |

## What does not change

The `view/` icydb boundary, the read-only guarantee (query calls only), the ic-agent
transport, and the DTO contract. This adds one capability and the UI to drive it.
Four backend files and two frontend files change; nothing is redesigned.

## Architecture

### `discovery` — list identities, not just the default

`discovery` already parses `identity_list.json` and extracts only the default entry.
It gains a function returning **all** entries.

Two type changes, both making an existing lie honest:

- `IdentityRef.pem_path` becomes `Option<PathBuf>`. A keyring identity has no file;
  today's type asserts one always exists, which is precisely what made keyring
  unrepresentable.
- `IdentityRef` gains `kind: String`, so downstream code can decide how to obtain the
  key and why an identity is unusable.

`Environment.identity` keeps its current meaning — the configured default — and gains
a sibling `identities: Vec<IdentityRef>` listing everything available.

### `agent/export.rs` — obtaining the key

One new module, three responsibilities, split so two of them are pure:

- `export_command(name: &str) -> Command` — builds the invocation. Pure, table-tested.
- `parse_export_result(status, stdout, stderr) -> Result<Vec<u8>, AppError>` — pure,
  tested against captured fixtures including failure shapes.
- `export_pem(name: &str) -> Result<Vec<u8>, AppError>` — runs the command and calls
  the parser.

Three safety properties, each load-bearing:

1. **stdin is closed (`Stdio::null()`) and a timeout applies.** `icp identity export`
   prompts interactively for password-protected identities. A subprocess inheriting
   stdin would hang the app indefinitely with no UI feedback. Closed stdin plus a
   timeout converts that into a fast, explicit failure.
2. **The pem never reaches disk, a log, or an error message.** Failures surface exit
   status and stderr — never stdout. This is the only code in the app handling private
   key material and should read like it knows that.
3. **Exported once per identity per session and held in memory.** Re-exporting per
   query would trigger a Keychain prompt on every click.

### `agent/identity.rs` — dispatch on kind, then algorithm

`load_identity` currently dispatches on algorithm alone. It gains an outer dispatch on
kind:

- `pem` → read `pem_path` as today
- `keyring` → `export_pem(name)`, then the same algorithm dispatch on the bytes
- `anonymous` → `AppError::Agent` explaining endpoints are controller-gated
- anything else → `AppError::Agent` naming the unsupported kind

The algorithm dispatch (`secp256k1` → `Secp256k1Identity`, `ed25519` →
`BasicIdentity`) is unchanged and shared by both loading paths, operating on bytes
rather than a path.

### `AgentPool` — the one real ripple

The pool is keyed by environment name. Switching identity must yield a **different**
agent, so the key becomes `(environment, identity)`.

This is the change most likely to cause a silent bug if missed: the app would keep
using the first identity selected for the rest of the session while the UI showed
another. That is a wrong-data-shown-confidently failure — the class this project has
hit repeatedly — so it warrants a test asserting two identities produce two agents.

### Frontend

- `IdentitySelector.tsx` — a dropdown in the header, above the canister tree, since
  identity applies across every pane. Each row shows name, truncated monospace
  principal, and kind. Unusable kinds are disabled with the reason inline
  (`anonymous` — "endpoints are controller-gated"; delegation — "not exportable as a
  pem").
- `App.tsx` — holds the selected identity in session state, initialised to the
  configured default, threads it through every command, and refetches on change.
- A new command `select_identity(env, identity)` exports eagerly and returns success
  or the failure, so the UI reports immediately rather than at first query.

Every command already taking `env` also takes the selected identity, because the agent
is now per-(environment, identity).

## Error handling

| Condition | Explanation must convey |
|---|---|
| `icp` not on PATH | The binary name, and that identity support requires it |
| Export exited non-zero | Identity name, exit status, stderr verbatim |
| Export timed out | That the identity likely needs a password the app cannot supply, and to use a pem or keyring identity instead |
| Pem parsed, algorithm unsupported | Existing message, unchanged |
| Kind unusable | Which kind, and why it cannot be used |
| Selected identity absent from the store | Which name, and that the store may have changed since launch |

All follow the established pattern: `AppError` variants with purpose-written
`explanation()` text, surfaced through `ErrorBanner`. No new user-facing copy may
claim the app enforces read-only access as a security boundary.

## Testing

| Scope | Approach |
|---|---|
| `export_command` | Table-test argument construction |
| `parse_export_result` | Fixtures for success, non-zero exit, empty stdout, stderr-only |
| Kind dispatch in `load_identity` | One case per kind, including both unusable kinds |
| Identity enumeration | Fixture stores: keyring-default, pem-default, mixed, malformed |
| `AgentPool` keying | Two identities in one environment yield two distinct agents |
| Live export | One `#[ignore]`-gated test exporting this machine's `default` and asserting the resulting principal equals the `principal` field in `identity_list.json` — a strong end-to-end assertion that never prints key material |
| Frontend | Selector rendering, disabled rows with reasons, refetch on change |

Fixture stores must be **captured from the real store's shape**, not authored to match
the code's assumptions. The prior phase's Critical finding came from exactly that
mistake.

## Unknowns the plan must resolve

Both are stop-and-report if reality differs, not work-around-quietly:

1. **Does `icp identity export` prompt for macOS Keychain access, and is that prompt
   answerable from a subprocess with closed stdin?** If macOS blocks a non-interactive
   subprocess from reading the Keychain item, the export approach does not work and the
   rejected `icp canister call` delegation becomes the fallback. Determine this before
   building the UI.
2. **How does icp represent password-protected identities in `identity_list.json`?**
   The disabled-reason logic depends on it, and only `keyring`, `pem`, and `anonymous`
   have been observed. Read icp's own config model rather than guessing.

## Out of scope

Internet Identity delegations, persisting the selection across launches, mutating
`icp identity default`, direct Keychain access, and password-protected identities
beyond failing clearly.

## Known risks

- **The private key exists in the app's process memory** for the session. That is
  inherent to using ic-agent with a real key; the `icp canister call` delegation
  approach is the alternative that avoids it, and is recorded above as the fallback.
- **Dependency on the `icp` binary.** The app already assumes an icp-managed project
  layout for discovery, so this does not add a new class of coupling, but it does make
  a working `icp` install required for live queries rather than merely for deployment.
- **Keychain prompt frequency** depends on macOS policy and is not fully predictable;
  caching per session is the mitigation.
