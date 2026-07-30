# Spike: can `icp identity export` read a Keychain-backed key non-interactively?

Date: 2026-07-30
Machine identity under test: `default` (confirmed `kind: "keyring"`, `algorithm: "secp256k1"` in
`~/Library/Application Support/org.dfinity.icp-cli/identity/identity_list.json`).

## Command run

```bash
icp identity export default < /dev/null > /tmp/icp-export-probe.out 2> /tmp/icp-export-probe.err; echo "exit=$?"
```

Run twice (second run timed with `/usr/bin/time -p`) from the repo root, on branch `feat/icp-identity`.

## Observations

- **Exit status:** `0` on both runs.
- **stderr:** empty on both runs.
- **Wall-clock time (second run):** `real 0.02s`. This is far too fast for a human to have
  answered a modal Keychain-access dialog, so no *interactive* prompt was waited on. I have no
  screen/display access from this tool, so I cannot visually confirm whether any dialog rendered
  and was auto-dismissed — but the timing rules out a blocking prompt requiring user input, which
  is the scenario that matters for a non-interactive subprocess with stdin closed.
- **Byte count:** 237 bytes, identical on both runs.
- **First line:** `-----BEGIN PRIVATE KEY-----`
- **Last line:** `-----END PRIVATE KEY-----`
- Both temp files (and the second pair) were deleted immediately after inspecting only the byte
  count and armour lines (`rm -f`). The base64 body was never displayed or logged.

## Key type (Step 2)

The armour is `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----`, i.e. **PKCS8**, not the
`EC PRIVATE KEY` (SEC1) form — despite the identity's declared algorithm being secp256k1. Task 4
should expect a PKCS8-wrapped secp256k1 key when parsing the export output.
`Secp256k1Identity::from_pem` accepts both forms per the `ic-agent` docs, so this doesn't block
Task 4, but the code path that gets exercised is the PKCS8 one, not SEC1.

## What surprised me

The export succeeded silently and near-instantly with no visible friction at all — no password
prompt, no `stderr` warning, no non-zero exit. This is a stronger result than "works but needs a
one-time approval": it suggests the `icp` binary already holds standing Keychain access to this
item (most likely granted via an earlier interactive `Always Allow` click during normal CLI use on
this machine, before this spike). I cannot verify from this spike whether:

- a *fresh* Keychain item (no prior interactive grant) would prompt the first time `icp` touches
  it, and if so, whether that prompt would block a non-interactive subprocess indefinitely (a
  correctness risk for the Tauri app's first run on a new machine), or
- the grant is scoped to the `icp` binary's code-signature (in which case a Tauri app shelling out
  to the same `icp` binary would inherit the same standing access) versus scoped to the calling
  process/session in some other way.

This is an inferred caveat, not a directly observed failure — flagging it for whoever picks up
Task 6 (agent-pool re-keying) as a residual risk on first-run/fresh-keychain-item machines, not as
a blocker for this verdict.

## Verdict

**Approach viable.**

A non-interactive subprocess (`stdin` closed, no TTY) successfully exported the Keychain-backed
`default` identity's private key via `icp identity export default`, twice, in ~20ms, with exit
status 0 and empty stderr. macOS did not refuse or block the read in this environment. This
confirms the assumption Tasks 2–8 depend on: shelling out to `icp identity export <name>` is a
workable way for the app to obtain a PEM for a keyring-kind identity. The PEM returned is PKCS8
(`BEGIN PRIVATE KEY`), which `Secp256k1Identity::from_pem` supports.

Residual, unverified risk (see above): behavior on a *first* access to a fresh Keychain item, where
macOS may show an interactive access-request dialog. That scenario was not exercised here because
this identity already had standing access. Tasks 2/3 (subprocess wrapper) should treat a hang or a
non-zero exit with an ACL-denial-shaped stderr as a distinct, user-actionable failure mode rather
than assuming every keyring identity behaves as smoothly as this one did.
