# No key file here, on purpose

This directory is where icp-cli keeps a `pem`-kind identity's private key, and
`identity_list.json` next door references `keys/demo-local.pem`. That file is
**deliberately absent**, and this repository commits no `.pem` anywhere.

Two throwaway fixture keys used to live in this tree. They were removed from the
project's entire git history rather than published to a public repository, and
the tests that need a real, parseable secp256k1 key now generate one into a
temporary directory at run time — see `src-tauri/src/test_support.rs`.

The discovery tests that read this fixture only parse `identity_list.json` and
build the path it names; they never open the key, so the missing file changes
nothing for them. The recorded `principal` in `identity_list.json` is an opaque
fixture value and no longer corresponds to any key.

Please do not "fix" this fixture by adding a `.pem`.
