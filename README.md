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
- The **`icp` CLI**, not `dfx`. This matters and is not interchangeable —
  see item 5 below.
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

5. **Use `icp`'s local replica, not `dfx`'s.** `ic-agent = "0.48"` (pinned in
   `src-tauri/Cargo.toml`) always POSTs queries to
   `/api/v3/canister/<id>/query`. `dfx`'s bundled replica (as of the version
   available while building this) does not implement that endpoint at all —
   it 404s — while `icp`'s network-launcher replica does. This is a real,
   confirmed tooling-version mismatch, not a preference: pointing this app
   (or its integration tests) at a `dfx start` replica will make every query
   call fail with a bare HTTP 404, regardless of whether the canister itself
   is fine.

6. **`LIMIT` requires an explicit `ORDER BY`.** icydb's query planner rejects
   any `LIMIT`/`OFFSET` window that has no `ORDER BY` at all
   (`PolicyPlanError::UnorderedPagination`, diagnostic code 5), for every
   entity — ordering by *any* column (not necessarily unique, not
   necessarily the primary key) satisfies it. This is why `fetch_rows`
   (`src-tauri/src/commands.rs`) always runs a `DESCRIBE` first to learn the
   entity's primary key and orders by it, and why the SQL console does not
   auto-append a bare `LIMIT` to a `SELECT` that has no `ORDER BY` of its
   own — doing so would manufacture a guaranteed rejection. Scalar paging in
   this app is therefore **`LIMIT`/`OFFSET`, not cursors**: icydb's SQL
   subset marks `pagination.scalar_cursor` rejected and
   `pagination.scalar_limit_offset` accepted, and a scalar `SELECT`'s
   `Projection` payload carries no cursor field at all.

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
   schema-browsing statements even though plain `SELECT` still works; the
   canister owner has to opt in explicitly for mainnet schema browsing to be
   available at all.

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

## Read-only, and where that guarantee actually lives

This app only ever issues query calls to `icydb_query`, and its SQL console
classifies input client-side, accepting only `SELECT`/`SHOW`/`DESCRIBE`/
`EXPLAIN` before it ever reaches the network. **That classifier is a UX
affordance, not a security boundary** — it exists so a user who types `DELETE
FROM ...` gets an immediate, specific explanation instead of a confusing
round-trip failure, not to protect anything. The actual guarantee is the
target canister's own `icydb.toml` (`readonly = true`), which means
`icydb_update` and `icydb_ddl` are never generated as endpoints in the first
place — there is nothing for this app, or any other caller, to invoke even
if it tried. If a canister is *not* configured `readonly = true`, this app's
own restraint is the only thing keeping it read-only, and that is a property
of this app's code, not of the canister you're pointing it at.

## Testing

```bash
# Rust unit tests (55 as of this writing) — no replica needed.
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
- **Mainnet schema browsing is off by default.** `SHOW`/`DESCRIBE`/`EXPLAIN`
  require a canister to opt into `introspection.ic = true` explicitly (item
  8 above); plain `SELECT` still works either way.
- **No cross-shard query fan-out.** Sharded entities are browsed one leaf
  canister at a time via the canister tree; this app never invents
  cross-canister query semantics.
- Writes, DDL, query history, and result export are all out of scope by
  design, not by omission — see [What this app does and does not
  do](#what-this-app-does-and-does-not-do).
