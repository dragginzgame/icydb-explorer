# icydb Explorer

A read-only Tauri desktop app for browsing [icydb](https://github.com/dragginzgame/icydb)
databases living inside Internet Computer canisters: pick a canister, see its
tables, inspect their schemas, page through rows, and run read-only SQL
against them.

The Rust backend is the only part of this app that speaks Candid or touches
the IC. It talks to a canister's `icydb_query` endpoint over `ic-agent`,
decodes the response with the real `icydb` crate, and hands the frontend
plain JSON DTOs — the frontend never imports, mirrors, or hand-decodes an
icydb type. That boundary (`src-tauri/src/view/`) is also where an icydb
version bump gets absorbed; see [Updating the icydb version](#updating-the-icydb-version)
below.

```
React/Vite/Tailwind  ──tauri invoke──▶  Rust backend  ──ic-agent──▶  canister.icydb_query
   (plain JSON DTOs)                    (icydb =0.202.1)
```

## What this app does and does not do

- **Supports:** `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` — browsing tables,
  schemas, indexes, storage/memory stats, and paged rows, plus a free-form SQL
  console for the same four statement kinds.
- **Does not support:** `INSERT`/`UPDATE`/`DELETE`, any DDL, or any other
  write. The app never calls `icydb_ddl` or `icydb_update`, and its console
  never even attempts them — see [Read-only, and where that guarantee
  actually lives](#read-only-and-where-that-guarantee-actually-lives).

## Prerequisites

- Rust **1.96.0** (pinned in `rust-toolchain.toml`; installing via `rustup`
  in this project's directory will pick it up automatically).
- Node.js and npm (any version compatible with the `package.json` deps).
- The **`icp` CLI**. This app is developed and tested against `icp`'s local
  replica; a `dfx start` replica has not been made to work here — see item 5
  below for what was actually observed, and why that's a note rather than a
  hard rule about every dfx release.
- A target canister with icydb's SQL surface enabled — see the next section.
  This repo ships a working example (`fixture/`) if you just want to see the
  app run.

## Enabling icydb's SQL surface on a canister

These are the operational facts this project paid to learn by hitting them —
none of them are written down in icydb's own docs or README. If you're
enabling icydb's SQL surface on a canister of your own, expect to hit at
least a few of these.

1. **The target canister must opt into the SQL surface explicitly.** icydb's
   `sql` feature is not in its default features. A canister needs
   `features = ["sql"]` on its `icydb` dependency, plus an `icydb.toml` at
   the canister crate's root. Use `fixture/icydb.toml` as the worked
   example:

   ```toml
   [canisters.fixture.sql]
   readonly = true
   ddl = false
   fixtures = true
   update = false

   [canisters.fixture.sql.introspection]
   local = true
   ic = false
   ```

2. **The canister crate itself also needs its own `[features] default =
   ["sql"]`.** icydb-build's generated actor glue (`icydb_query` and
   friends) is gated behind `#[cfg(feature = "sql")]` evaluated in the
   *consuming* crate — and Cargo does not forward a dependency's own feature
   flags to the crate that depends on it. Enabling `sql` on the `icydb`
   dependency alone is not enough: without the canister crate defaulting
   that feature on itself, the canister compiles cleanly and simply has no
   `icydb_query` method at all. (See `fixture/Cargo.toml`'s `[features]`
   section for the exact shape.)

3. **Schema declarations must live in their own crate**, referenced from the
   canister crate in **both** `[dependencies]` and `[build-dependencies]`,
   with `use <schema_crate> as _;` at the top of `build.rs`. icydb's
   `#[entity]`/`#[canister]`/`#[store]` macros register themselves into a
   process-global schema registry via `#[ctor]` hooks, and those hooks only
   run in a process that actually links the compiled code containing them —
   a build script is compiled and run *before* its own crate's `lib.rs`, so
   if the schema lives only in the canister crate, `build.rs` never sees it
   registered and codegen fails with `PathNotFound`. This repo's
   `fixture-schema` crate plus `fixture/build.rs`'s `use fixture_schema as
   _;` is the reference shape — see `fixture-schema/src/lib.rs`'s module doc
   for the full explanation.

4. **Set `ICYDB_BUILD_TARGET=local` when building the fixture** (or any
   canister) locally, or rebuilds silently lose introspection regardless of
   what `icydb.toml` says. `icydb.toml`'s `introspection.local`/`.ic` flags
   select a *build-time* policy keyed off this env var; when it's unset,
   icydb resolves to an "unknown" build target and disables introspection
   unconditionally — not falling back to either configured value. Without
   it, `SHOW`/`DESCRIBE`/`EXPLAIN` start failing: this app reports it as
   `AppError::IntrospectionDisabled` (`src-tauri/src/error.rs`), and the
   underlying rejection is icydb's own diagnostic code 183,
   `RUNTIME_BOUNDARY_SQL_INTROSPECTION_DISABLED`
   (`icydb-diagnostic-code-0.202.1/src/registry.rs`) — even though
   `icydb.toml` says `local = true`.

5. **This app is developed and tested against `icp`'s local replica, and a
   `dfx start` replica has not been made to work.** `ic-agent = "0.48"`
   (pinned in `src-tauri/Cargo.toml`) always POSTs queries to
   `/api/v3/canister/<id>/query`.

   **Corrected 2026-07-30 (icydb author review, Step 4d):** an earlier
   version of this note stated categorically that `dfx`'s replica cannot
   work because it lacks that endpoint. That generalised too far from a
   single observation: the IC HTTP interface spec admits both v2 and v3
   query routes, and there is no authoritative basis here for rejecting
   *every* dfx replica. What was actually observed, on this machine, on
   2026-07-29, against `dfx 0.30.0-beta.2`: every `icydb_query` call against
   a `dfx start` replica returned a bare HTTP 404 on that endpoint, while
   `icp`'s network-launcher replica served it normally. That is a
   single-machine, single-version data point, not a verified rule about
   every dfx release. `icp`'s replica is what this app and its integration
   tests are actually verified against; treat any given `dfx start` replica
   as untested rather than assumed-incompatible, and report back if you get
   one working.

6. **`LIMIT` requires an explicit `ORDER BY`.** icydb's query planner rejects
   any `LIMIT`/`OFFSET` window that has no `ORDER BY` at all
   (`PolicyPlanError::UnorderedPagination`, diagnostic code 5), for every
   entity — ordering by *any* column (not necessarily unique, not
   necessarily the primary key) satisfies it. This is why `fetch_rows`
   (`src-tauri/src/commands.rs`) runs a `DESCRIBE` first to learn the
   entity's primary key and orders by it (via the pure `sql::rows_sql`), and
   why the SQL console does not auto-append a bare `LIMIT` to a `SELECT`
   that has no `ORDER BY` of its own — doing so would manufacture a
   guaranteed rejection. Scalar paging in this app is therefore
   **`LIMIT`/`OFFSET`, not cursors**: icydb's SQL subset marks
   `pagination.scalar_cursor` rejected and `pagination.scalar_limit_offset`
   accepted, and a scalar `SELECT`'s `Projection` payload carries no cursor
   field at all.

   **Corrected 2026-07-30 (icydb author review, Step 4c):** when that
   `DESCRIBE` itself fails because introspection is disabled (see item 8
   below), `fetch_rows` now returns a clear error
   (`AppError::RowPagingRequiresIntrospection`) rather than falling back to
   an unordered, unbounded `SELECT` the way an earlier version of this app
   did. That fallback was a real defect: the generated-SQL lane `fetch_rows`
   runs on is trusted/admin and intentionally bypasses public-read
   admission, so an unbounded read there was exactly the wrong place to
   relax anything, regardless of whether pagination was achievable. **Row
   browsing is therefore *unavailable* on a canister with introspection
   disabled — not merely schema-blind** — until you type an explicit
   `ORDER BY ... LIMIT ...` yourself in the SQL console, which needs no
   `DESCRIBE` and so is unaffected by introspection being off.

7. **Endpoints are controller-gated.** `icydb_query` requires the calling
   identity to be a controller of the target canister. The identity this
   app uses is whatever `.icp/`'s default identity resolves to (see
   `src-tauri/src/discovery/`); if it isn't a controller of the canister
   you're pointing at, every query fails with a `NotController` error naming
   the identity used.

8. **`introspection.ic = false` is icydb's default.** `SHOW`/`DESCRIBE`/
   `EXPLAIN` are enabled by default on local builds and *disabled* by
   default on IC (mainnet) builds. A canister deployed to mainnet with no
   explicit `icydb.toml` override will report `IntrospectionDisabled` for
   schema-browsing statements — and, per item 6 above, this app's automatic
   row browsing is unavailable too, since it depends on `DESCRIBE` to build
   an `ORDER BY`. A hand-written, explicitly ordered `SELECT` in the SQL
   console still works, since it needs no `DESCRIBE`. The canister owner has
   to opt in explicitly for mainnet schema browsing (and this app's row
   browsing) to be available at all.

9. **`icydb` is pinned exactly, in exactly one place.** The workspace root
   `Cargo.toml`'s `[workspace.dependencies]` declares
   `icydb = { version = "=0.202.1", features = ["sql-explain"] }`; every
   crate in this workspace (`src-tauri`, `fixture`, `fixture-schema`)
   depends on it via `icydb = { workspace = true }`, so there is exactly one
   version string to bump, not one per crate that could silently drift out
   of sync. This matters because `SqlQueryResult`/`OutputValue` shapes are
   version-coupled and icydb moves fast. `src-tauri/src/view/` is the one
   module that translates icydb's types into this app's stable frontend
   DTOs — it is the only module that should need to change on a version
   bump, which is also why the frontend
   never sees an icydb type directly.

## Running the fixture end to end

This repo ships a minimal fixture canister (`fixture/`, schema in
`fixture-schema/`) with the SQL surface enabled, so you can see the whole
pipeline work without needing a canister of your own.

```bash
# 1. Build the fixture wasm. ICYDB_BUILD_TARGET=local is required — see
#    item 4 above.
ICYDB_BUILD_TARGET=local cargo build -p icydb-explorer-fixture \
  --target wasm32-unknown-unknown --release

# 2. Start icp's local replica (not dfx).
icp network start --background

# 3. Build (packages the prebuilt wasm per icp.yaml), create, and install
#    the canister.
icp build fixture
icp canister create fixture
icp canister install fixture

# 4. icydb_query is controller-gated (item 7 above) — make sure the identity
#    you'll query with is a controller. `icp canister create` typically adds
#    your default identity automatically; add another explicitly if needed:
icp canister settings update fixture --add-controller <principal> --force

# 5. Seed some rows so there's something to browse.
icp canister call fixture icydb_fixtures_load '()'

# 6. Point the app/tests at the running replica and canister id, then launch.
npm run tauri dev
```

`icp canister list` / the `.icp/cache/mappings/*.ids.json` file under this
project's own `.icp/` directory will show you the deployed canister id. The
app discovers its own `.icp/` project layout on launch (environments,
replica URL, default identity) — run it from a directory that has one.

## Running the app

```bash
npm run tauri dev
```

Watch its output for anything resembling "command not found" — that's what
a mis-cased `invoke` argument or a stale/removed command name on the Rust
side produces, and it means the frontend and backend command surfaces have
drifted apart.

You can also run the frontend alone, without Tauri, with `npm run dev`. Every
pane will show an error in that mode (`invoke` has nothing to talk to
outside the Tauri runtime), but that's still a meaningful check: the layout
should render, and the error should show up as a full, readable explanation
in the UI rather than a blank pane, a silent failure, or a crash.

## Identities

This app reads identities straight out of `icp`'s own identity store — never
`dfx`'s — via `icp identity list`/`icp identity export`, and its selector
lists every identity that store declares, not just the default.

**Selection is session-only.** On launch, the app starts from whatever `icp
identity default` currently resolves to. Choosing a different identity from
the selector changes which identity this app's own queries use for the rest
of that running session; it does not touch `icp`'s own configured default.
Restart the app and it starts from `icp identity default` again.

`icp` identities come in three storage kinds (`icp identity new --storage
<kind>`), and this app's support differs by kind:

| Storage kind | Works here? |
|---|---|
| `plaintext` | Yes — the pem is read straight off disk. |
| `keyring` | Yes — exported non-interactively via `icp identity export` and never written to disk; see `src-tauri/src/agent/export.rs`. |
| `password` | **No.** `icp identity export` prompts interactively for the password, which this app has no way to supply. The export attempt times out after 20s with an explanatory error rather than hanging indefinitely — use a `plaintext` or `keyring` identity instead. |

The selector also disables (with the reason shown inline) any identity this
app otherwise cannot use — most notably `anonymous`, since `icydb_query` is
controller-gated and the anonymous identity is never a controller of
anything.

Three key algorithms are supported: `secp256k1`, `ed25519`, and
`prime256v1` (the three `icp identity import --assert-key-type` accepts). An
identity using any other algorithm reports a clear "unsupported algorithm"
error naming it, rather than failing silently.

## Read-only, and where that guarantee actually lives

**Corrected 2026-07-30, following a review by the icydb author.** An earlier
version of this section, and of the design spec, said the target canister's
own `icydb.toml` (`readonly = true`) *is* the security boundary. That was
wrong, and wrong in the dangerous direction: `icydb-config`'s `emit.rs`
wires `readonly`, `ddl`, `fixtures`, and `update` as **four independent
switches** (`with_sql_readonly_enabled`, `with_sql_ddl_enabled`,
`with_sql_fixtures_enabled`, `with_sql_update_policy`). Setting
`readonly = true` only controls whether `icydb_query` is generated — it does
**not** disable `icydb_ddl`, `icydb_update`, or fixtures. A canister with
`readonly = true` and `ddl` left unset still has `icydb_ddl` generated. A
reader who followed the old text, set `readonly = true`, and left the rest
default would have believed they were protected when they weren't.

The real guarantee — and it is a stronger one — is what this app already
does: **it calls only `icydb_query`, a query method whose dispatcher rejects
any mutation statement, and query calls cannot persist canister state.**
That's a property of IC query calls themselves, not a courtesy this app is
choosing to extend. This codebase has exactly two network call sites, both
`agent.query` (`src-tauri/src/sql/transport.rs`'s call to `icydb_query`, and
`src-tauri/src/topology/mod.rs`'s call to `canic_canister_children`) —
neither is, or could silently become, an update call. Confirmed by three
independent reviews of this codebase, including the one that raised this
finding.

The SQL console's client-side statement classifier (accepting only
`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` before anything reaches the network) is a
**UX affordance, not part of that guarantee** — it exists so a user who types
`DELETE FROM ...` gets an immediate, specific explanation instead of a
confusing round-trip failure. Removing it would not make this app able to
write anything; it would just turn a clear local error into a confusing
network one.

**Defence in depth, not the boundary itself.** The app's own query-only
behavior is what actually protects a canister it points at, but it's still
worth configuring the canister so a *different*, less careful caller can't
do damage either — that configuration is a second, independent layer, not
a substitute for the first. For any canister this app is meant to browse,
we recommend:

```toml
[canisters.<name>.sql]
readonly = true
ddl = false
update = false
fixtures = false   # true only for a development fixture, never in production
```

Setting these narrows what any *other* caller of the same canister can do —
it does not change what this app can do, since this app was already
query-only regardless of how the canister is configured.

## Testing

```bash
# Rust unit tests (97 as of this writing) — no replica needed.
cargo test -p icydb-explorer

# Rust integration tests against a live replica — requires the fixture
# deployed per "Running the fixture end to end" above.
ICYDB_EXPLORER_TEST_URL="http://127.0.0.1:4943" \
ICYDB_EXPLORER_TEST_CANISTER="<fixture-canister-id>" \
cargo test -p icydb-explorer --test integration -- --ignored --test-threads=1

# Frontend tests, build, and typecheck.
npm test
npm run build
npx tsc --noEmit
```

The integration suite includes one deliberately negative test,
`run_query_against_a_toko_canister_reports_no_sql_surface`, that asserts
`AppError::NoSqlSurface` (naming the canister and mentioning both
`features = ["sql"]` and `icydb.toml`) against a canister that never enabled
icydb's SQL surface — the single error most new users of this app will hit
first. It needs its own replica/canister:

```bash
ICYDB_EXPLORER_TOKO_URL="http://127.0.0.1:8000" \
ICYDB_EXPLORER_TOKO_CANISTER="<a-toko-canister-id>" \
cargo test -p icydb-explorer --test integration \
  run_query_against_a_toko_canister_reports_no_sql_surface -- --ignored
```

## Updating the icydb version

`src-tauri/src/view/` is the module boundary that translates icydb's
`SqlQueryResult`/`OutputValue` shapes into this app's stable, version-agnostic
frontend DTOs. On an icydb version bump, that's the module to update —
everything upstream of it (`sql`, `agent`, `topology`, `discovery`) and
everything downstream (the entire frontend) should be unaffected, which is
the entire reason that boundary exists.

## Known limitations

- **Controller-gated only.** This app is useful only against canisters
  where its configured identity is a controller (item 7 above) — there is
  no support for browsing a canister you don't control.
- **Mainnet schema browsing — and this app's automatic row browsing — are
  off by default.** `SHOW`/`DESCRIBE`/`EXPLAIN` require a canister to opt
  into `introspection.ic = true` explicitly (item 8 above), and so does the
  table view's automatic paging, since it needs a `DESCRIBE` to build an
  `ORDER BY`. A hand-written, explicitly ordered `SELECT ... ORDER BY ...
  LIMIT ...` typed into the SQL console still works either way, since it
  needs no `DESCRIBE`.
- **No cross-shard query fan-out.** Sharded entities are browsed one leaf
  canister at a time via the canister tree; this app never invents
  cross-canister query semantics.
- Writes, DDL, query history, and result export are all out of scope by
  design, not by omission — see [What this app does and does not
  do](#what-this-app-does-and-does-not-do).
