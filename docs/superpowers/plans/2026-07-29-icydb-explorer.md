# icydb_explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri 2 desktop app that browses read-only icydb databases inside Internet Computer canisters — canister tree, table list, schema panel, paginated row grid, and a read-only SQL console.

**Architecture:** The Rust backend is the only component that speaks Candid or touches the IC; it decodes canister responses using the real `icydb` crate and hands the frontend plain JSON DTOs. A single pure module (`view`) translates `SqlQueryResult` into those DTOs, so icydb version churn touches one file. The React frontend never imports an icydb type.

**Tech Stack:** Rust (Tauri 2, `ic-agent` 0.48, `candid` 0.10, `icydb` =0.202.1), React 19 + Vite + Tailwind 4, `cargo test` + Vitest.

## Global Constraints

- `icydb` and `icydb-build` are pinned exactly: `icydb = { version = "=0.202.1", features = ["sql-explain"] }`. Never relax to a caret range — `SqlQueryResult` is version-coupled.
- Rust toolchain: **1.96.0**, pinned in `rust-toolchain.toml`. icydb's own manifest and README both claim 1.88.0, but its dependency `icydb-config@0.202.1` declares `rust-version = "1.96.0"`, so 1.96.0 is the real floor for the tree. Verified: the backend builds clean on 1.96.0 and fails to resolve on 1.88.0.
- The app is **read-only**. It must never call `icydb_ddl` or `icydb_update`, and must only use `ic-agent`'s query calls, never update calls.
- **`LIMIT` requires an explicit `ORDER BY`.** icydb's planner rejects an unordered
  paginated read with `PolicyPlanError::UnorderedPagination` ("Pagination requires an
  explicit ordering"). Confirmed against a live replica: `SELECT * FROM demo_row LIMIT 10`
  is rejected. Any SQL this app constructs with a `LIMIT` must carry an `ORDER BY`, and
  the app must never append a `LIMIT` to a statement that lacks one.
- The frontend must never import, mirror, or hand-decode an icydb type. All icydb→JSON translation happens in `src-tauri/src/view/`.
- icydb's catalog description structs have **private fields with accessors** (`entity_name()`, `store_path()`, `storage()`, `columns()`, `indexes()`, `relations()`, `schema_version()`). Read them via accessors.
- Identities come from icp's own store (`.icp/cli-home/identity/`), **not** dfx's. Read the algorithm from `identity_list.json`; do not assume.
- User-facing copy must not claim the app enforces read-only access as a security boundary. The canister's `readonly = true` is the boundary; the app's statement classifier is a UX affordance.

---

## File Structure

### Backend (`src-tauri/src/`)

| File | Responsibility |
|---|---|
| `main.rs` | Tauri builder, command registration, managed state |
| `error.rs` | `AppError` enum + serialization to the frontend |
| `discovery/mod.rs` | Public API: `discover(project_root) -> Project` |
| `discovery/icp_dir.rs` | Parse `.icp/` — environments, ids, port descriptors, identity |
| `discovery/types.rs` | `Project`, `Environment`, `IdentityRef`, `CanisterArtifact` |
| `agent/mod.rs` | Build + cache one `Agent` per environment |
| `agent/identity.rs` | Load pem by algorithm into a boxed `Identity` |
| `topology/mod.rs` | Walk `canic_canister_children` into a tree |
| `topology/types.rs` | `CanisterInfo`, `CanicPage`, `CanicError`, `TreeNode` |
| `sql/mod.rs` | `query(agent, canister, sql) -> SqlQueryResult` |
| `sql/classify.rs` | Read-only statement classifier |
| `sql/limit.rs` | Default-LIMIT appending |
| `view/mod.rs` | `SqlQueryResult` → `ResultDto` |
| `view/value.rs` | `OutputValue` → `ValueDto` |
| `view/schema.rs` | Catalog descriptions → `SchemaDto` |
| `view/dto.rs` | All DTO type definitions (serde `Serialize`) |
| `commands.rs` | Tauri command handlers |

### Fixture canister (`fixture/` + `fixture-schema/`)

**Two crates, not one.** icydb's `#[canister]`/`#[entity]` macros register into a
process-global registry via a `#[ctor]` hook that fires only in a process which
links the compiled entity code. A build script is a separate binary compiled
*before* its own crate's `lib.rs`, so entities declared in the canister crate are
invisible to its `build.rs` and codegen fails with `PathNotFound`. Declarations
must therefore live in a separate crate that the canister depends on **twice** —
as a normal dependency and a build-dependency.

This is exactly how the real consumer is arranged: `dragginz/toko` keeps schema in
a `design` crate, lists it in both dependency sections, and opens its canister
`build.rs` with `use design as _;` to force the link.

| File | Responsibility |
|---|---|
| `fixture-schema/Cargo.toml` | Schema crate (plain rlib), depends only on `icydb` |
| `fixture-schema/src/lib.rs` | `#[canister]`, `#[store]`, and entity declarations |
| `fixture/Cargo.toml` | Canister crate; `fixture-schema` in **both** `[dependencies]` and `[build-dependencies]` |
| `fixture/icydb.toml` | Read-only SQL surface config |
| `fixture/build.rs` | `use fixture_schema as _;` then `build_configured_canister!` |
| `fixture/src/lib.rs` | Re-exports the schema, `icydb::start!()`, seed wiring |
| `fixture/src/seed.rs` | Seed rows covering `OutputValue` variants |

### Frontend (`src/`)

| File | Responsibility |
|---|---|
| `main.tsx`, `App.tsx` | Root + layout shell |
| `api/commands.ts` | Typed wrappers over `invoke` |
| `api/types.ts` | TypeScript mirrors of the backend DTOs |
| `components/CanisterTree.tsx` | Fleet/role tree navigation |
| `components/TableList.tsx` | Entity list for selected canister |
| `components/SchemaPanel.tsx` | Columns, indexes, constraints |
| `components/RowGrid.tsx` | Type-aware row grid + "Load more" |
| `components/ValueCell.tsx` | Renders one `ValueDto` by `kind` |
| `components/SqlConsole.tsx` | Statement input + rejection messaging |
| `components/ErrorBanner.tsx` | Purpose-written error explanations |

---

## Task 1: Scaffold Tauri app and pin dependencies

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`
- Create: `rust-toolchain.toml`, `.gitignore`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a buildable Tauri app; `src-tauri/` crate named `icydb-explorer` that later tasks add modules to

- [ ] **Step 1: Scaffold the app**

```bash
npm create tauri-app@latest -- --yes --template react-ts --manager npm --identifier dev.rem.icydb-explorer icydb-explorer-tmp
```

Move the generated contents into the repo root (the repo already contains `docs/`, so do not nest):

```bash
rsync -a --exclude node_modules icydb-explorer-tmp/ . && rm -rf icydb-explorer-tmp
```

- [ ] **Step 2: Pin the Rust toolchain**

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.96.0"
components = ["rustfmt", "clippy"]
```

- [ ] **Step 3: Add backend dependencies**

In `src-tauri/Cargo.toml`, set the `[dependencies]` section to:

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
candid = "0.10"
ic-agent = "0.48"
icydb = { version = "=0.202.1", features = ["sql-explain"] }
tokio = { version = "1", features = ["sync"] }
thiserror = "2"
```

- [ ] **Step 4: Verify the backend compiles with icydb linked**

Run: `cd src-tauri && cargo build`
Expected: SUCCESS. This is the load-bearing check that `icydb` compiles for the host target — `icydb-cli` does the same, so it must work. If it fails on a wasm-only dependency, stop and report rather than working around it.

- [ ] **Step 5: Add Tailwind**

```bash
npm install -D tailwindcss @tailwindcss/vite
```

In `vite.config.ts`, add the plugin:

```ts
import tailwindcss from "@tailwindcss/vite";
// inside defineConfig({ plugins: [...] })
// plugins: [react(), tailwindcss()],
```

Create `src/index.css` containing exactly:

```css
@import "tailwindcss";
```

And import it at the top of `src/main.tsx`:

```ts
import "./index.css";
```

- [ ] **Step 6: Verify the app builds**

Run: `npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 app with pinned icydb and Tailwind"
```

---

## Task 2: Fixture canister with the SQL surface enabled

**Files:**
- Create: `fixture-schema/Cargo.toml`, `fixture-schema/src/lib.rs`
- Create: `fixture/Cargo.toml`, `fixture/icydb.toml`, `fixture/build.rs`, `fixture/src/lib.rs`, `fixture/src/seed.rs`
- Modify: `Cargo.toml` (workspace root — create if absent)

See the File Structure section for why the schema must be its own crate.

**Interfaces:**
- Consumes: nothing
- Produces: a `.wasm` exposing `icydb_query : (text) -> (variant { Ok : SqlQueryResult; Err : Error }) query`, with entities `demo_row` and `demo_child`. Task 10's integration tests target this.

**Why this exists:** icydb's `sql` feature is not in default features, and `dragginz/toko` does not currently enable it — its built candid exposes only `icydb_metrics`. Rather than block on changing toko, this repo owns a canister it controls.

- [ ] **Step 1: Create the workspace root `Cargo.toml`**

```toml
[workspace]
members = ["src-tauri", "fixture", "fixture-schema"]
resolver = "2"

[workspace.dependencies]
icydb = { version = "=0.202.1", features = ["sql-explain"] }
icydb-build = "=0.202.1"
```

- [ ] **Step 2: Create `fixture/Cargo.toml`**

```toml
[package]
name = "icydb-explorer-fixture"
version = "0.1.0"
edition = "2021"
rust-version = "1.96.0"

[lib]
crate-type = ["cdylib"]

[dependencies]
candid = "0.10"
ic-cdk = "0.20"
icydb = { workspace = true }
fixture-schema = { path = "../fixture-schema" }
serde = { version = "1", features = ["derive"] }

[build-dependencies]
icydb = { workspace = true }
fixture-schema = { path = "../fixture-schema" }
```

`ic-cdk` must be `0.20`, not `0.17`: icydb 0.202.1 depends transitively on
`ic-cdk ^0.20.1`, and Cargo's `links` uniqueness rule rejects two versions of it.

`fixture-schema` appears in **both** dependency sections — that is the whole point
of the split, not a redundancy to tidy away.

`icydb` — not `icydb-build` — belongs in `[build-dependencies]`: the `icydb::build`
facade is the advertised downstream build-script API, and `icydb-build` is an
implementation crate behind it.

- [ ] **Step 3: Create `fixture/icydb.toml`**

These are the defaults `icydb config init` generates, which already match a read-only explorer:

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

- [ ] **Step 4: Create `fixture/build.rs`**

```rust
use fixture_schema as _;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    icydb::build::build_configured_canister!((), "fixture_schema::Canister", "fixture");

    Ok(())
}
```

Three details, each of which breaks the build if wrong:

- `use fixture_schema as _;` forces the build script to link the schema crate so its
  `#[ctor]` registration hooks run. Without it the crate may be elided and codegen
  fails with `PathNotFound`. toko's canister `build.rs` opens with the same line.
- The canister path is `"fixture_schema::Canister"` — the crate's Cargo name with
  hyphens turned to underscores, because that is what `module_path!()` yields.
- The macro call needs a trailing semicolon.

The macro takes `($canister_ty, $canister_path, $canister_name)` and expands to a
`?` call, so `main` must return `Result`. `()` is the correct type argument from a
build script, which cannot name its own crate's types. `$canister_name` must equal
the `icydb.toml` key (`fixture`) — a mismatch silently falls back to SQL-disabled
defaults, which is the failure Step 6 exists to catch.

Do not use `icydb_build::build_with_options!`: it bypasses `icydb.toml` entirely and
the SQL surface config would be ignored.

- [ ] **Step 5: Declare entities covering the interesting value types**

Create `fixture-schema/src/lib.rs` for the declarations, and keep
`fixture/src/lib.rs` thin — it re-exports the schema, calls `icydb::start!()`, and
wires the seed module. The exact macro syntax must be copied from icydb's own tests — read `~/.cargo/registry/src/*/icydb-0.202.1/tests/` for a working entity declaration and mirror it. The entity set to declare:

- `demo_row`: primary key `id` (Ulid); fields `name` (Text), `count` (Nat64), `balance` (Decimal), `owner` (Principal), `created` (Timestamp), `payload` (Blob), `active` (Bool), `note` (optional Text, to exercise `Null`), `tags` (List of Text)
- `demo_child`: primary key `id` (Ulid); field `parent` (Ulid), plus a named index on `parent`

The value coverage matters: Task 6's `view` tests assert every `OutputValue` variant renders, and this canister is how the integration test proves it end to end.

- [ ] **Step 6: Verify the SQL surface is actually generated**

```bash
cargo build -p icydb-explorer-fixture --target wasm32-unknown-unknown --release
candid-extractor target/wasm32-unknown-unknown/release/icydb_explorer_fixture.wasm > fixture/fixture.did
grep icydb_query fixture/fixture.did
```

Expected: a line containing `icydb_query`. If absent, the `sql` feature or `icydb.toml` is not wired — fix that before proceeding, because every later task depends on this endpoint existing.

- [ ] **Step 7: Commit**

```bash
git add fixture Cargo.toml fixture/fixture.did
git commit -m "feat: add fixture canister exposing read-only icydb SQL surface"
```

---

## Task 3: Error type with purpose-written explanations

**Files:**
- Create: `src-tauri/src/error.rs`
- Test: `src-tauri/src/error.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub enum AppError { Io(String), Parse(String), Agent(String), NoSqlSurface { canister: String }, IntrospectionDisabled, NotController { identity: String }, ReplicaUnreachable { url: String }, IcyDb { code: String, message: String }, Rejected(String) }`
  - `impl AppError { pub fn explanation(&self) -> String }`
  - `impl serde::Serialize for AppError` producing `{ "kind": "...", "explanation": "..." }`

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_sql_surface_explains_the_required_config() {
        let error = AppError::NoSqlSurface { canister: "user_hub".into() };
        let text = error.explanation();
        assert!(text.contains("user_hub"));
        assert!(text.contains(r#"features = ["sql"]"#));
        assert!(text.contains("icydb.toml"));
    }

    #[test]
    fn introspection_disabled_explains_the_ic_flag() {
        let text = AppError::IntrospectionDisabled.explanation();
        assert!(text.contains("introspection"));
        assert!(text.contains("ic = false"));
    }

    #[test]
    fn not_controller_names_the_identity_used() {
        let text = AppError::NotController { identity: "demo-local".into() }.explanation();
        assert!(text.contains("demo-local"));
        assert!(text.contains("controller"));
    }

    #[test]
    fn replica_unreachable_names_the_url_tried() {
        let text = AppError::ReplicaUnreachable { url: "http://127.0.0.1:8000".into() }.explanation();
        assert!(text.contains("http://127.0.0.1:8000"));
    }

    #[test]
    fn serializes_with_kind_and_explanation() {
        let json = serde_json::to_value(AppError::IntrospectionDisabled).unwrap();
        assert_eq!(json["kind"], "introspectionDisabled");
        assert!(json["explanation"].as_str().unwrap().contains("introspection"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test error`
Expected: FAIL — `AppError` not found.

- [ ] **Step 3: Implement `error.rs`**

Define the enum with `thiserror::Error`, then `explanation()` returning the operator-facing text. Required content per variant:

- `NoSqlSurface { canister }` — state that `canister` has no `icydb_query` method, that the SQL surface is not enabled, and that enabling it means adding `features = ["sql"]` to the canister's icydb dependency plus an `icydb.toml`. This mirrors the recovery hint icydb-cli emits for the same condition.
- `IntrospectionDisabled` — state that `SHOW`/`DESCRIBE`/`EXPLAIN` are unavailable because the canister was built with `introspection` `ic = false`, and that this is a build-time configuration choice owned by the canister, not a failure of the explorer.
- `NotController { identity }` — state which identity was used and that icydb's SQL endpoints are controller-gated.
- `ReplicaUnreachable { url }` — state the URL that was tried.
- `IcyDb { code, message }` — surface both verbatim.

Implement `Serialize` manually as a two-field map: `kind` (lowerCamelCase variant name) and `explanation`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test error`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "feat: add AppError with operator-facing explanations"
```

---

## Task 4: Discovery — parse `.icp/`

**Files:**
- Create: `src-tauri/src/discovery/mod.rs`, `src-tauri/src/discovery/types.rs`, `src-tauri/src/discovery/icp_dir.rs`
- Create: `src-tauri/tests/fixtures/icp_project/` (fixture tree)
- Test: `src-tauri/src/discovery/icp_dir.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: `AppError` (Task 3)
- Produces:
  - `pub struct Project { pub root: PathBuf, pub environments: Vec<Environment> }`
  - `pub struct Environment { pub name: String, pub replica_url: String, pub root_canister_id: Option<String>, pub identity: Option<IdentityRef>, pub artifacts: Vec<CanisterArtifact> }`
  - `pub struct IdentityRef { pub name: String, pub algorithm: String, pub pem_path: PathBuf }`
  - `pub struct CanisterArtifact { pub role: String, pub did_path: PathBuf }`
  - `pub fn discover(project_root: &Path) -> Result<Project, AppError>`

- [ ] **Step 1: Build the fixture tree**

Create these files under `src-tauri/tests/fixtures/icp_project/.icp/`:

`cache/mappings/demo.ids.json`:
```json
{ "root": "igqk7-g3777-77774-qaaba-cai" }
```

`cli-home/port-descriptors/8000.json`:
```json
{
  "v": "1",
  "network": "local",
  "gateway": { "fixed": true, "port": 8000, "host": "localhost", "ip": "127.0.0.1" }
}
```

`cli-home/identity/identity_defaults.json`:
```json
{ "v": 1, "default": "demo-local" }
```

`cli-home/identity/identity_list.json`:
```json
{
  "v": 1,
  "identities": {
    "demo-local": {
      "kind": "pem",
      "format": "plaintext",
      "algorithm": "secp256k1",
      "principal": "j524y-jtmzv-omb6g-wh6rn-mxhkh-dzg5v-ct2r5-2s742-rvyxm-jgqmi-xqe"
    },
    "anonymous": { "kind": "anonymous" }
  }
}
```

`cli-home/identity/keys/demo-local.pem`: any placeholder text (this task never parses key bytes).

`local/canisters/user_hub/user_hub.did`: empty file.
`local/canisters/root/root.did`: empty file.

- [ ] **Step 2: Write the failing test**

Add to `src-tauri/src/discovery/icp_dir.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> Project {
        discover(Path::new("tests/fixtures/icp_project")).expect("discovery should succeed")
    }

    #[test]
    fn finds_the_local_environment() {
        let project = fixture();
        let names: Vec<&str> = project.environments.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["local"]);
    }

    #[test]
    fn builds_replica_url_from_gateway() {
        let env = &fixture().environments[0];
        assert_eq!(env.replica_url, "http://127.0.0.1:8000");
    }

    #[test]
    fn reads_root_canister_id_from_ids_mapping() {
        let env = &fixture().environments[0];
        assert_eq!(env.root_canister_id.as_deref(), Some("igqk7-g3777-77774-qaaba-cai"));
    }

    #[test]
    fn resolves_default_identity_with_algorithm_and_pem_path() {
        let env = &fixture().environments[0];
        let identity = env.identity.as_ref().expect("identity should resolve");
        assert_eq!(identity.name, "demo-local");
        assert_eq!(identity.algorithm, "secp256k1");
        assert!(identity.pem_path.ends_with("keys/demo-local.pem"));
    }

    #[test]
    fn lists_canister_artifacts_by_role() {
        let env = &fixture().environments[0];
        let mut roles: Vec<&str> = env.artifacts.iter().map(|a| a.role.as_str()).collect();
        roles.sort_unstable();
        assert_eq!(roles, vec!["root", "user_hub"]);
    }

    #[test]
    fn missing_icp_directory_is_an_error_not_a_panic() {
        assert!(discover(Path::new("tests/fixtures/does_not_exist")).is_err());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test discovery`
Expected: FAIL — `discover` not found / module unresolved.

- [ ] **Step 4: Implement `types.rs`**

```rust
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
pub struct Project {
    pub root: PathBuf,
    pub environments: Vec<Environment>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Environment {
    pub name: String,
    pub replica_url: String,
    pub root_canister_id: Option<String>,
    pub identity: Option<IdentityRef>,
    pub artifacts: Vec<CanisterArtifact>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IdentityRef {
    pub name: String,
    pub algorithm: String,
    pub pem_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
pub struct CanisterArtifact {
    pub role: String,
    pub did_path: PathBuf,
}
```

- [ ] **Step 5: Implement `icp_dir.rs`**

Implement `discover` to, in order:

1. Error if `<root>/.icp` is not a directory.
2. For each `.icp/cli-home/port-descriptors/*.json`, read `network` as the environment name and build `replica_url` as `format!("http://{}:{}", gateway.ip, gateway.port)`.
3. Read `.icp/cache/mappings/*.ids.json`; take the `root` key as `root_canister_id`. Multiple mapping files: use the first whose stem matches the project directory name, else the first found.
4. Read `identity_defaults.json` → `default`, look it up in `identity_list.json` → `algorithm`, and set `pem_path` to `.icp/cli-home/identity/keys/<name>.pem`. If the entry's `kind` is not `pem`, leave `identity` as `None`.
5. List `.icp/<env>/canisters/*/` directories; each becomes a `CanisterArtifact` with `role` = directory name and `did_path` = `<dir>/<role>.did`.

Every filesystem read that can fail must map into `AppError` (Task 3) — no `unwrap` on IO or JSON. Map IO failures to `AppError::Io` and JSON failures to `AppError::Parse`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test discovery`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/discovery src-tauri/tests/fixtures
git commit -m "feat: discover environments, ids, and identity from .icp"
```

---

## Task 5: Statement classifier and default LIMIT

**Files:**
- Create: `src-tauri/src/sql/classify.rs`, `src-tauri/src/sql/limit.rs`, `src-tauri/src/sql/mod.rs`
- Test: inline `#[cfg(test)]` in both files

**Interfaces:**
- Consumes: `AppError` (Task 3)
- Produces:
  - `#[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum Statement { Select, Show, Describe, Explain }` — `Copy` and `PartialEq`/`Debug` are required by the tests below, which compare variants with `assert_eq!` and pass them by value in loops
  - `pub fn classify(sql: &str) -> Result<Statement, AppError>` — `Err(AppError::Rejected(_))` for anything else
  - `pub struct LimitedSql { pub sql: String, pub limit_appended: bool }`
  - `pub fn apply_default_limit(sql: &str, statement: Statement, default: u32) -> LimitedSql`

**Note on framing:** this classifier is a UX affordance, not a security control. The canister's `readonly = true` is the actual boundary. Rejection messages must not imply the app is protecting the database.

- [ ] **Step 1: Write the failing classifier test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_read_statements() {
        for (sql, expected) in [
            ("SELECT * FROM demo_row", Statement::Select),
            ("  select id from demo_row  ", Statement::Select),
            ("SHOW ENTITIES", Statement::Show),
            ("DESCRIBE demo_row", Statement::Describe),
            ("EXPLAIN SELECT * FROM demo_row", Statement::Explain),
        ] {
            assert_eq!(classify(sql).unwrap(), expected, "sql: {sql}");
        }
    }

    #[test]
    fn rejects_writes_and_ddl_by_naming_the_verb() {
        for sql in ["INSERT INTO demo_row VALUES (1)", "UPDATE demo_row SET a = 1",
                    "DELETE FROM demo_row", "CREATE INDEX i ON demo_row (a)",
                    "DROP INDEX i", "ALTER TABLE demo_row ADD COLUMN a text"] {
            let error = classify(sql).expect_err("should reject");
            let text = error.explanation();
            let verb = sql.split_whitespace().next().unwrap();
            assert!(text.contains(verb), "explanation should name {verb}: {text}");
            assert!(text.contains("read-only"), "explanation should say read-only: {text}");
        }
    }

    #[test]
    fn rejects_empty_input() {
        assert!(classify("   ").is_err());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test sql::classify`
Expected: FAIL — `classify` not found.

- [ ] **Step 3: Implement `classify.rs`**

Match on the first whitespace-delimited token, uppercased. `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` map to their variants; everything else returns `AppError::Rejected` with a message naming the verb and stating the explorer is read-only.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test sql::classify`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing LIMIT test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_limit_when_select_has_none() {
        let result = apply_default_limit("SELECT * FROM demo_row", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 100");
        assert!(result.limit_appended);
    }

    #[test]
    fn leaves_existing_limit_untouched() {
        let result = apply_default_limit("SELECT * FROM demo_row LIMIT 5", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 5");
        assert!(!result.limit_appended);
    }

    #[test]
    fn detects_limit_case_insensitively() {
        let result = apply_default_limit("select * from demo_row limit 5", Statement::Select, 100);
        assert!(!result.limit_appended);
    }

    #[test]
    fn never_touches_non_select_statements() {
        for statement in [Statement::Show, Statement::Describe, Statement::Explain] {
            let result = apply_default_limit("SHOW ENTITIES", statement, 100);
            assert_eq!(result.sql, "SHOW ENTITIES");
            assert!(!result.limit_appended);
        }
    }

    #[test]
    fn trailing_semicolon_still_gets_a_limit() {
        let result = apply_default_limit("SELECT * FROM demo_row;", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 100");
        assert!(result.limit_appended);
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd src-tauri && cargo test sql::limit`
Expected: FAIL — `apply_default_limit` not found.

- [ ] **Step 7: Implement `limit.rs`**

Only act on `Statement::Select`. Strip a trailing `;` and surrounding whitespace, then
check for a `LIMIT` keyword case-insensitively as a whole word; if absent, append
` LIMIT <default>` and set `limit_appended = true`.

**But only when the statement already has an `ORDER BY`.** icydb rejects an unordered
`LIMIT` with `UnorderedPagination`, so appending one to a bare
`SELECT * FROM demo_row` would manufacture a statement guaranteed to fail — the
app's own convenience feature producing an error. Detect `ORDER BY` the same
whole-word, case-insensitive way; if it is absent, return the statement untouched
with `limit_appended = false` and let icydb apply its own bounds.

Injecting an `ORDER BY` instead was considered and rejected: it needs the entity's
primary key (an extra round trip) and correct placement relative to `WHERE`/`GROUP BY`
in arbitrary user SQL, which means parsing. Not worth it for a console where the user
can type four more words — and `AppError` explains the rule when icydb rejects it.

- [ ] **Step 8: Run to verify it passes**

Run: `cd src-tauri && cargo test sql::limit`
Expected: PASS, 5 tests.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/sql
git commit -m "feat: add read-only statement classifier and default LIMIT"
```

---

## Task 6: View layer — `SqlQueryResult` to DTOs

**Files:**
- Create: `src-tauri/src/view/dto.rs`, `src-tauri/src/view/value.rs`, `src-tauri/src/view/schema.rs`, `src-tauri/src/view/mod.rs`
- Test: inline `#[cfg(test)]` in `value.rs` and `mod.rs`

**Interfaces:**
- Consumes: `icydb::db::sql::SqlQueryResult`, `icydb_core::value::OutputValue` (re-exported through `icydb`)
- Produces:
  - Every DTO struct and enum below derives `Clone, Debug, Serialize` plus
    `#[serde(rename_all = "camelCase")]`. The `Debug` derive is required by the tests
    (`panic!("{other:?}")`), and the camelCase rename is what makes `row_count`
    arrive in the frontend as `rowCount` — Task 11's TypeScript types depend on it.
  - `pub struct ValueDto { pub kind: String, pub display: String }`
  - `pub fn value_to_dto(value: &OutputValue) -> ValueDto`
  - `pub struct RowsDto { pub entity: String, pub columns: Vec<String>, pub rows: Vec<Vec<ValueDto>>, pub row_count: u32, pub next_cursor: Option<String> }`
  - `pub struct ColumnDto { pub name: String, pub type_name: String, pub primary_key: bool, pub optional: bool }`
  - `pub struct SchemaDto { pub entity: String, pub columns: Vec<ColumnDto>, pub indexes: Vec<String> }`
  - `pub struct EntityDto { pub name: String, pub store_path: String, pub storage: String, pub columns: u32, pub indexes: u32, pub relations: u32, pub schema_version: u32 }`
  - `pub struct StoreDto { pub store_path: String, pub storage: String }`
  - `pub struct MemoryDto { pub tag: String, pub memory_id: u8, pub store_path: String }`
  - `pub enum ResultDto { Rows(RowsDto), Schema(SchemaDto), Entities { entities: Vec<EntityDto> }, Count { entity: String, row_count: u32 }, Explain { entity: String, explain: String }, Indexes { entity: String, indexes: Vec<String> }, Stores { stores: Vec<StoreDto> }, Memory { memory: Vec<MemoryDto> } }` — `Serialize` as internally tagged with `"type"`

    **The three collection variants must be struct variants, not newtype variants.**
    An internally-tagged enum cannot inject its tag into a JSON array, so
    `Entities(Vec<EntityDto>)` panics at serialize time. `Rows(RowsDto)` and
    `Schema(SchemaDto)` are fine as newtype variants because their payloads
    serialize as maps, which the tag can be added to.
  - `pub fn result_to_dto(result: SqlQueryResult) -> Result<ResultDto, AppError>`

    Fallible on purpose. `SqlQueryResult::Ddl` is a DDL-mutation report, and this
    app never sends DDL — but the value is decoded from a canister response, i.e.
    data crossing a process boundary this program does not control. So its arrival
    is a protocol anomaly to report, not an invariant to assert: map it to
    `AppError::Parse` naming the unexpected variant. Never `unreachable!()` or
    `panic!()` here — a desktop app must surface that as an error, not die. Callers
    already return `Result<_, AppError>`, so this costs them a `?`.

**This is the load-bearing module.** It is the only place icydb shapes are translated. When icydb bumps, this is what changes.

- [ ] **Step 1: Write the failing value-mapping test**

Every `OutputValue` variant must map. Write one assertion per variant so a new icydb release that adds a variant fails loudly here:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use icydb::value::OutputValue;

    #[test]
    fn maps_scalar_variants_to_kind_and_display() {
        assert_eq!(value_to_dto(&OutputValue::Bool(true)).kind, "bool");
        assert_eq!(value_to_dto(&OutputValue::Bool(true)).display, "true");
        assert_eq!(value_to_dto(&OutputValue::Text("hi".into())).kind, "text");
        assert_eq!(value_to_dto(&OutputValue::Text("hi".into())).display, "hi");
        assert_eq!(value_to_dto(&OutputValue::Int64(-7)).kind, "int");
        assert_eq!(value_to_dto(&OutputValue::Int64(-7)).display, "-7");
        assert_eq!(value_to_dto(&OutputValue::Nat64(7)).kind, "nat");
        assert_eq!(value_to_dto(&OutputValue::Nat64(7)).display, "7");
    }

    #[test]
    fn null_and_unit_get_distinct_kinds_and_empty_display() {
        let null = value_to_dto(&OutputValue::Null);
        assert_eq!(null.kind, "null");
        assert_eq!(null.display, "");
        assert_eq!(value_to_dto(&OutputValue::Unit).kind, "unit");
    }

    #[test]
    fn blob_reports_byte_length_rather_than_raw_bytes() {
        let dto = value_to_dto(&OutputValue::Blob(vec![0u8; 40]));
        assert_eq!(dto.kind, "blob");
        assert!(dto.display.contains("40"));
    }

    #[test]
    fn list_and_map_render_their_children() {
        let list = OutputValue::List(vec![OutputValue::Nat64(1), OutputValue::Nat64(2)]);
        let dto = value_to_dto(&list);
        assert_eq!(dto.kind, "list");
        assert!(dto.display.contains('1') && dto.display.contains('2'));

        let map = OutputValue::Map(vec![(OutputValue::Text("k".into()), OutputValue::Nat64(9))]);
        let dto = value_to_dto(&map);
        assert_eq!(dto.kind, "map");
        assert!(dto.display.contains('k') && dto.display.contains('9'));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test view::value`
Expected: FAIL — `value_to_dto` not found.

`OutputValue` lives at `icydb::value::OutputValue` (`icydb-0.202.1/src/lib.rs:99-101`),
**not** under `icydb::db::response` — that module exports
`render_output_value_text` but not the value type itself.

- [ ] **Step 3: Implement `value.rs`**

Exhaustively match `OutputValue` — no `_ =>` arm, so the compiler flags new variants on an icydb bump. Kind strings, one per variant: `account`, `blob`, `bool`, `date`, `decimal`, `duration`, `enum`, `float32`, `float64`, `int`, `int128`, `intbig`, `list`, `map`, `null`, `principal`, `subaccount`, `text`, `timestamp`, `nat`, `nat128`, `natbig`, `ulid`, `unit`.

For `display`, prefer icydb's own renderer where it exists — `icydb::db::response::render_output_value_text` — so the app agrees with `icydb-cli`'s output. Override only where the grid needs different behaviour: `Null` renders as the empty string (the frontend styles it), and `Blob` renders as a byte count rather than raw bytes.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test view::value`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing result-mapping test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_maps_to_count_dto() {
        let result = SqlQueryResult::Count { entity: "demo_row".into(), row_count: 3 };
        match result_to_dto(result).unwrap() {
            ResultDto::Count { entity, row_count } => {
                assert_eq!(entity, "demo_row");
                assert_eq!(row_count, 3);
            }
            other => panic!("expected Count, got {other:?}"),
        }
    }

    #[test]
    fn show_indexes_maps_to_indexes_dto() {
        let result = SqlQueryResult::ShowIndexes {
            entity: "demo_row".into(),
            indexes: vec!["by_parent".into()],
        };
        match result_to_dto(result).unwrap() {
            ResultDto::Indexes { entity, indexes } => {
                assert_eq!(entity, "demo_row");
                assert_eq!(indexes, vec!["by_parent".to_string()]);
            }
            other => panic!("expected Indexes, got {other:?}"),
        }
    }

    #[test]
    fn serializes_with_a_type_tag() {
        let dto = ResultDto::Count { entity: "demo_row".into(), row_count: 1 };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "count");
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd src-tauri && cargo test view::`
Expected: FAIL — `result_to_dto` not found.

- [ ] **Step 7: Implement `dto.rs`, `schema.rs`, and `mod.rs`**

Derive `Clone, Debug, Serialize` on every DTO. Each struct DTO carries
`#[serde(rename_all = "camelCase")]` so field names reach the frontend as
`rowCount`, `nextCursor`, `typeName`, `primaryKey`, `storePath`, `schemaVersion`.

`ResultDto` needs **three** serde attributes, not two:

```rust
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
```

`rename_all` on an enum renames only the *variant* names. Fields inside struct
variants — `row_count` on `Count`, for instance — are untouched by it, so without
`rename_all_fields` they reach the frontend as `row_count` and Task 11's types
silently fail to match.

Match `SqlQueryResult` exhaustively, with no `_ =>` arm.

`schema.rs` reads icydb's catalog and describe structs **through their accessors**,
because every field on them is private. The verified sets:

- `EntityFieldDescription`: `name()`, `slot() -> Option<u16>`, `kind()`, `nullable()`, `primary_key()`, `queryable()`, `origin()`
- `EntitySchemaDescription`: `entity_path()`, `entity_name()`, `primary_key()`, `primary_key_fields()`, `fields()`, `indexes()`, `relations()`
- `EntityIndexDescription`: `name()`, `unique()`, `fields()`, `origin()`
- `EntityCatalogDescription`: `entity_name()`, `entity_path()`, `store_path()`, `storage()`, `columns()`, `indexes()`, `relations()`, `schema_version()`
- `StoreCatalogDescription`: `store_path()`, `storage()`
- `MemoryCatalogDescription`: `tag()`, `memory_id() -> u8`, `store_path()`

`ColumnDto` maps from `EntityFieldDescription` as: `name` ← `name()`,
`type_name` ← `kind()`, `primary_key` ← `primary_key()`, `optional` ← `nullable()`.

`RowProjectionOutput`, by contrast, has **public** fields (`entity`, `columns`,
`rows`, `row_count`) and no `next_cursor` — only `SqlGroupedRowsOutput` carries a
cursor, so `RowsDto.next_cursor` is `None` for a `Projection`.

The `Explain` variant is behind icydb's `sql-explain` feature, which the Global Constraints enable, so match it unconditionally.

- [ ] **Step 8: Run to verify it passes**

Run: `cd src-tauri && cargo test view`
Expected: PASS, 7 tests.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/view
git commit -m "feat: add view layer translating SqlQueryResult to frontend DTOs"
```

---

## Task 7: Agent construction and identity loading

**Files:**
- Create: `src-tauri/src/agent/mod.rs`, `src-tauri/src/agent/identity.rs`
- Test: inline `#[cfg(test)]` in `identity.rs`

**Interfaces:**
- Consumes: `Environment`, `IdentityRef` (Task 4); `AppError` (Task 3)
- Produces:
  - `pub fn load_identity(identity: &IdentityRef) -> Result<Box<dyn ic_agent::Identity>, AppError>`
  - `pub struct AgentPool { /* private */ }`
  - `impl AgentPool { pub fn new() -> Self; pub async fn get(&self, env: &Environment) -> Result<Arc<ic_agent::Agent>, AppError> }`

- [ ] **Step 1: Write the failing identity test**

Generate a real secp256k1 pem as a test fixture so the loader is exercised against genuine key material:

```bash
openssl ecparam -name secp256k1 -genkey -noout -out src-tauri/tests/fixtures/secp256k1.pem
```

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reference(algorithm: &str, file: &str) -> IdentityRef {
        IdentityRef {
            name: "demo-local".into(),
            algorithm: algorithm.into(),
            pem_path: PathBuf::from("tests/fixtures").join(file),
        }
    }

    #[test]
    fn loads_a_secp256k1_pem() {
        let identity = load_identity(&reference("secp256k1", "secp256k1.pem"))
            .expect("secp256k1 pem should load");
        assert!(identity.sender().is_ok());
    }

    #[test]
    fn unknown_algorithm_is_an_error() {
        // `.err().expect(..)` rather than `.expect_err(..)`: the latter is bounded
        // `T: Debug`, and `Box<dyn Identity>` has no `Debug` impl — ic-agent's
        // `Identity` trait is only `Send + Sync`.
        let error = load_identity(&reference("rsa9000", "secp256k1.pem"))
            .err()
            .expect("should fail");
        assert!(error.explanation().contains("rsa9000"));
    }

    #[test]
    fn missing_pem_file_is_an_error() {
        assert!(load_identity(&reference("secp256k1", "absent.pem")).is_err());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test agent::identity`
Expected: FAIL — `load_identity` not found.

- [ ] **Step 3: Implement `identity.rs`**

Match on `algorithm`: `"secp256k1"` → `ic_agent::identity::Secp256k1Identity::from_pem_file`, `"ed25519"` → `ic_agent::identity::BasicIdentity::from_pem_file`. Any other value returns `AppError::Agent` with a message naming the unsupported algorithm. Map pem read/parse failures to `AppError::Agent`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test agent::identity`
Expected: PASS, 3 tests.

- [ ] **Step 5: Implement `AgentPool` in `mod.rs`**

Hold a `tokio::sync::Mutex<HashMap<String, Arc<Agent>>>` keyed by environment name. On a miss:

```rust
let agent = Agent::builder()
    .with_url(&env.replica_url)
    .with_boxed_identity(load_identity(identity)?)
    .build()
    .map_err(|e| AppError::Agent(e.to_string()))?;
```

**Use `with_boxed_identity`, not `with_identity`.** `with_identity` is bounded
`I: 'static + Identity`, and ic-agent has no `impl Identity for Box<dyn Identity>` —
so passing the boxed identity to it does not compile. ic-agent provides
`with_boxed_identity(Box<dyn Identity>)` for exactly this case (there is also
`with_arc_identity` if an `Arc` is more convenient).

Verified ic-agent 0.48.1 API surface, so no need to re-check:

- `ic_agent::Identity` is the trait; `sender() -> Result<Principal, String>`
- `ic_agent::identity::Secp256k1Identity::from_pem_file<P: AsRef<Path>>(p) -> Result<Self, PemError>`
- `ic_agent::identity::BasicIdentity::from_pem_file` — this is the ed25519 loader
- `ic_agent::identity::Prime256v1Identity::from_pem_file` also exists, if a p256 pem
  ever turns up; not required by this task
- `from_pem_file` needs ic-agent's `pem` feature, which is **on by default**
- `Agent::builder().with_url(impl Into<String>)…build() -> Result<Agent, AgentError>`
- `agent.fetch_root_key() -> Result<(), AgentError>`, async

Then, for any non-mainnet replica URL, call `agent.fetch_root_key().await` and map failure to `AppError::ReplicaUnreachable { url: env.replica_url.clone() }` — an unreachable local replica is the single most likely failure in daily use, and it must not surface as a generic agent error. Treat a URL whose host is not `ic0.app`/`icp-api.io` as local.

- [ ] **Step 6: Verify it compiles and the suite passes**

Run: `cd src-tauri && cargo test`
Expected: PASS, all prior tests plus 3 new.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/agent src-tauri/tests/fixtures/secp256k1.pem
git commit -m "feat: add agent pool and pem identity loading"
```

---

## Task 8: SQL transport — call `icydb_query` and decode

**Files:**
- Create: `src-tauri/src/sql/transport.rs`
- Modify: `src-tauri/src/sql/mod.rs` (export `transport`)
- Test: inline `#[cfg(test)]` in `transport.rs`

**Interfaces:**
- Consumes: `AgentPool` (Task 7), `AppError` (Task 3), `classify`/`apply_default_limit` (Task 5)
- Produces:
  - `pub async fn run_query(agent: &Agent, canister: Principal, sql: &str, identity: &str) -> Result<SqlQueryResult, AppError>`

    `identity` is the human-readable identity name from
    `IdentityRef.name` — the string the user would actually change. It exists
    solely so `AppError::NotController` can name it: ic-agent exposes only
    `sender() -> Principal`, not the configured name, so the agent alone cannot
    supply it. Task 10's callers have the `Environment` and pass
    `env.identity.as_ref().map_or("<none>", |i| i.name.as_str())`.
  - `pub fn map_reject_message(message: &str, canister: &str, identity: &str) -> AppError` (with a private `map_agent_error(&AgentError, &str, &str)` extracting the reject text and delegating to it)

- [ ] **Step 1: Write the failing error-mapping test**

The transport's decode and error mapping are unit-testable without a replica; the live path is covered by Task 10.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_method_maps_to_no_sql_surface() {
        let error = map_reject_message(
            "IC0302: Canister has no query method 'icydb_query'",
            "user_hub",
            "demo-local",
        );
        assert!(matches!(error, AppError::NoSqlSurface { .. }));
        assert!(error.explanation().contains("user_hub"));
    }

    #[test]
    fn unauthorized_maps_to_not_controller_naming_the_identity() {
        let error = map_reject_message("Unauthorized: caller is not a controller", "user_hub", "demo-local");
        assert!(matches!(error, AppError::NotController { .. }));
        assert!(error.explanation().contains("demo-local"));
    }

    #[test]
    fn introspection_disabled_is_recognised() {
        let error = map_reject_message("SqlIntrospectionDisabled", "user_hub", "demo-local");
        assert!(matches!(error, AppError::IntrospectionDisabled));
    }

    #[test]
    fn unrecognised_rejections_pass_through_verbatim() {
        let error = map_reject_message("some novel failure", "user_hub", "demo-local");
        assert!(error.explanation().contains("some novel failure"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test sql::transport`
Expected: FAIL — `map_reject_message` not found.

- [ ] **Step 3: Implement the reject-message classifier**

```rust
pub fn map_reject_message(message: &str, canister: &str, identity: &str) -> AppError {
    if message.contains("has no query method 'icydb_query'") {
        return AppError::NoSqlSurface { canister: canister.to_string() };
    }
    if message.contains("SqlIntrospectionDisabled") {
        return AppError::IntrospectionDisabled;
    }
    if message.contains("Unauthorized") || message.contains("not a controller") {
        return AppError::NotController { identity: identity.to_string() };
    }
    AppError::Agent(message.to_string())
}
```

The `has no query method 'icydb_query'` string is the same marker icydb-cli matches on for this condition, so the two tools agree about what a stale-wasm canister looks like.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test sql::transport`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement `run_query`**

```rust
pub async fn run_query(
    agent: &Agent,
    canister: Principal,
    sql: &str,
    identity: &str,
) -> Result<SqlQueryResult, AppError> {
    let bytes = agent
        .query(&canister, "icydb_query")
        .with_arg(Encode!(&sql.to_string()).map_err(|e| AppError::Parse(e.to_string()))?)
        .call()
        .await
        .map_err(|e| map_agent_error(&e, &canister.to_text(), identity))?;

    Decode!(bytes.as_slice(), Result<SqlQueryEnvelope, icydb::Error>)
        .map_err(|e| AppError::Parse(e.to_string()))?
        .map(|envelope| envelope.result)
        .map_err(|e| AppError::IcyDb { code: format!("{e:?}"), message: e.to_string() })
}
```

**The response is wrapped, and the wrapper is not an importable type.** A canister
with `readonly = true` does not return `SqlQueryResult` directly — the actor macro
emits a per-canister `IcydbSqlQueryPerfResult` record holding the real result plus
eight instruction counters, and returns that. Verified in the generated fixture
candid:

```candid
type IcydbSqlQueryPerfResult = record {
  result : SqlQueryResult;
  instructions : nat64;
  planner_instructions : nat64;
  store_instructions : nat64;
  executor_instructions : nat64;
  pure_covering_decode_instructions : nat64;
  pure_covering_row_assembly_instructions : nat64;
  decode_instructions : nat64;
  compiler_instructions : nat64;
};
icydb_query : (text) -> (variant { Ok : IcydbSqlQueryPerfResult; Err : Error }) query;
```

Because that struct is generated *into each canister* rather than exported by the
`icydb` crate, there is nothing to import — you must declare a local mirror.
`icydb-cli` does exactly this with its own `ShellSqlQueryPerfResult`. Declare only
the field you use, in `transport.rs`:

```rust
/// Local mirror of the per-canister `IcydbSqlQueryPerfResult` the actor macro
/// emits for read-only SQL surfaces. Candid skips unmatched record fields on
/// decode, so the eight instruction counters are deliberately omitted — the
/// explorer does not surface them. `icydb-cli` declares all nine in its own
/// mirror; if decoding ever fails here, adding them back is the fallback.
#[derive(CandidType, Deserialize)]
struct SqlQueryEnvelope {
    result: SqlQueryResult,
}
```

`run_query` still returns `SqlQueryResult`, so this unwrap is invisible to callers
and Task 10's tests are unaffected.

Use `agent.query(...)`, never `agent.update(...)` — the Global Constraints forbid
update calls, and `icydb_query` is declared as a query method.

`map_agent_error` extracts the reject message and delegates to
`map_reject_message`. **It must match both reject variants:**

```rust
fn map_agent_error(error: &AgentError, canister: &str, identity: &str) -> AppError {
    match error {
        AgentError::CertifiedReject { reject, .. }
        | AgentError::UncertifiedReject { reject, .. } => {
            map_reject_message(&reject.reject_message, canister, identity)
        }
        other => AppError::Agent(other.to_string()),
    }
}
```

Matching only `CertifiedReject` is the trap here: query calls are not certified by
default, so a rejected `icydb_query` normally arrives as `UncertifiedReject`. Miss
that arm and the `NoSqlSurface` detection — the single most valuable error message in
this app, and the one most users hit first — silently never fires.

Verified ic-agent 0.48.1 surface, so no need to re-check:

- `agent.query<S: Into<String>>(&Principal, S) -> QueryBuilder`
- `QueryBuilder::with_arg<A: Into<Vec<u8>>>(A) -> Self`
- `QueryBuilder::call() -> Result<Vec<u8>, AgentError>`, async
- `AgentError::{CertifiedReject, UncertifiedReject} { reject: RejectResponse, .. }`,
  with the text at `reject.reject_message`

- [ ] **Step 6: Verify the suite passes**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sql
git commit -m "feat: add icydb_query transport with diagnostic error mapping"
```

---

## Task 9: Topology walk

**Files:**
- Create: `src-tauri/src/topology/mod.rs`, `src-tauri/src/topology/types.rs`
- Test: inline `#[cfg(test)]` in `mod.rs`

**Interfaces:**
- Consumes: `AgentPool` (Task 7), `AppError` (Task 3)
- Produces:
  - `pub struct CanisterInfo { pub pid: Principal, pub role: String, pub created_at: u64, pub module_hash: Option<Vec<u8>>, pub parent_pid: Option<Principal> }`
  - `pub struct TreeNode { pub pid: String, pub role: String, pub children: Vec<TreeNode> }`
  - `pub fn build_tree(root: &str, infos: Vec<CanisterInfo>) -> TreeNode`
  - `pub async fn fetch_children(agent: &Agent, canister: Principal) -> Result<Vec<CanisterInfo>, AppError>`

**Why this matters:** `.icp/cache/mappings/*.ids.json` contains only `root`; canic creates the rest of the fleet at runtime. This walk is the only way to obtain most canister ids, so a flat fallback means most of the database is unreachable — the failure must be visible, not silent.

- [ ] **Step 1: Write the failing tree-building test**

Tree assembly is pure and testable without a replica:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 10])
    }

    fn info(pid: u8, role: &str, parent: Option<u8>) -> CanisterInfo {
        CanisterInfo {
            pid: principal(pid),
            role: role.into(),
            created_at: 0,
            module_hash: None,
            parent_pid: parent.map(principal),
        }
    }

    #[test]
    fn nests_children_under_their_parent() {
        let infos = vec![
            info(2, "user_hub", Some(1)),
            info(3, "user_shard", Some(2)),
        ];
        let tree = build_tree(&principal(1).to_text(), infos);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].role, "user_hub");
        assert_eq!(tree.children[0].children[0].role, "user_shard");
    }

    #[test]
    fn attaches_parentless_canisters_to_the_root() {
        let tree = build_tree(&principal(1).to_text(), vec![info(9, "orphan", None)]);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].role, "orphan");
    }

    #[test]
    fn tolerates_a_parent_that_is_not_in_the_list() {
        let tree = build_tree(&principal(1).to_text(), vec![info(9, "stray", Some(77))]);
        assert_eq!(tree.children.len(), 1, "stray should still be reachable");
    }

    #[test]
    fn empty_input_yields_a_root_with_no_children() {
        let tree = build_tree(&principal(1).to_text(), vec![]);
        assert_eq!(tree.role, "root");
        assert!(tree.children.is_empty());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test topology`
Expected: FAIL — `build_tree` not found.

- [ ] **Step 3: Implement `types.rs`**

```rust
use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(CandidType, Clone, Debug, Deserialize)]
pub struct CanisterInfo {
    pub pid: Principal,
    pub role: String,
    pub created_at: u64,
    pub module_hash: Option<Vec<u8>>,
    pub parent_pid: Option<Principal>,
}

#[derive(CandidType, Clone, Debug, Deserialize)]
pub struct CanicPage {
    pub total: u64,
    pub entries: Vec<CanisterInfo>,
}

#[derive(CandidType, Clone, Debug, Deserialize)]
pub struct PageRequest {
    pub offset: u64,
    pub limit: u64,
}

/// Canic's error is `record { code : ErrorCode; message : text }`. Only `message`
/// is declared here: candid skips unmatched record fields, so this deliberately
/// avoids coupling to canic's large and evolving `ErrorCode` variant.
#[derive(CandidType, Clone, Debug, Deserialize)]
pub struct CanicError {
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeNode {
    pub pid: String,
    pub role: String,
    pub children: Vec<TreeNode>,
}
```

- [ ] **Step 4: Implement `build_tree` in `mod.rs`**

Index the infos by `parent_pid` text, then recurse from `root`. Any node whose declared parent is absent from the list attaches to the root so it stays reachable — the third test pins this. Guard against cycles with a visited set so a malformed topology cannot hang the app.

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && cargo test topology`
Expected: PASS, 4 tests.

- [ ] **Step 6: Implement `fetch_children`**

Page with `PageRequest { offset, limit: 100 }`, accumulating `entries` until `offset >= total`. Decode each response as `Result<CanicPage, CanicError>`, mapping the `Err` arm to `AppError::Agent(message)`.

Recurse into each returned child to discover grandchildren, since `canic_canister_children` reports only direct children. Track visited principals to avoid re-walking, and treat a child that lacks `canic_*` endpoints as a leaf rather than an error.

- [ ] **Step 7: Verify the suite passes**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/topology
git commit -m "feat: walk canic topology into a canister tree"
```

---

## Task 10: Tauri commands and live integration test

**Files:**
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/tests/integration.rs`
- Modify: `src-tauri/src/main.rs` (register commands, manage state)

**Interfaces:**
- Consumes: everything from Tasks 3–9
- Produces the frontend contract:
  - `list_environments() -> Vec<Environment>`
  - `canister_tree(env: String) -> TreeNode`
  - `list_tables(env: String, canister: String) -> ResultDto`
  - `describe_table(env: String, canister: String, entity: String) -> ResultDto`
  - `fetch_rows(env: String, canister: String, entity: String, offset: u32) -> ResultDto`
  - `run_sql(env: String, canister: String, sql: String) -> SqlRunDto`
  - `pub struct SqlRunDto { pub result: ResultDto, pub limit_appended: bool }`

- [ ] **Step 1: Implement `commands.rs`**

Each command resolves the environment via `discovery`, gets an `Agent` from `AgentPool`, calls `sql::transport::run_query`, and maps through `view::result_to_dto`. Command bodies build SQL as:

- `list_tables` → `"SHOW ENTITIES"`
- `describe_table` → `format!("DESCRIBE {entity}")`
- `fetch_rows` → `format!("SELECT * FROM {entity} ORDER BY {pk} LIMIT 100 OFFSET {offset}")`

  The `ORDER BY` is mandatory, not stylistic — see the Global Constraints. `{pk}` comes
  from the entity's primary key, which means `fetch_rows` must learn it first via
  `DESCRIBE {entity}` (`EntitySchemaDescription::primary_key()`). That is a second round
  trip per page; accept it rather than guessing a column name. Do not cache it yet —
  if paging proves slow in practice, caching the describe result per (canister, entity)
  is the obvious follow-up, but adding it now is speculative.

**Scalar paging is `LIMIT`/`OFFSET`, not cursors.** icydb's SQL subset contract
(`docs/contracts/SQL_SUBSET.md`) is explicit:

> `pagination.scalar_cursor` — **status: rejected.** Cursor-based pagination is not
> part of the scalar SQL surface.
>
> `pagination.scalar_limit_offset` — **status: accepted.** SQL uses `LIMIT` /
> `OFFSET` for scalar windowing. […] This is intentional: cursor semantics are
> transport-level, not query[-level].

`next_cursor` exists only on **grouped** payloads (`pagination.grouped_cursor`),
because grouped execution differs — so a `Projection` never carries one, and
`RowsDto.next_cursor` stays `None` for scalar browsing. Keep the field for grouped
results arriving through the console.

There is a separate "no offset" rule in that contract, and it does **not** apply
here: it constrains `execute_trusted_sql_prefix_update`, a bounded *mutation* lane.
Reads are unaffected.

Determining "has more": the app cannot know a total without a separate `COUNT`, so
treat a full page (returned `row_count` equal to the requested limit) as "there may
be more" and let the UI offer another page. Do not fabricate a total.

`run_sql` must call `classify` first and return the `Rejected` error without contacting the canister, then `apply_default_limit`, and report `limit_appended` so the UI can show that it modified the statement.

State: `.manage(AgentPool::new())` and `.manage(Project)` in `main.rs`; register all six commands in `invoke_handler`.

- [ ] **Step 2: Write the integration test**

```rust
//! Live tests against the fixture canister. Ignored by default: they need a
//! running replica. Run with:
//!   cargo test --test integration -- --ignored
//!
//! Set ICYDB_EXPLORER_TEST_CANISTER and ICYDB_EXPLORER_TEST_URL first.

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn show_entities_lists_the_fixture_entities() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "SHOW ENTITIES", "test").await.expect("query should succeed");
    let dto = result_to_dto(result).unwrap();
    match dto {
        ResultDto::Entities(entities) => {
            let names: Vec<&str> = entities.iter().map(|e| e.name.as_str()).collect();
            assert!(names.contains(&"demo_row"), "got {names:?}");
        }
        other => panic!("expected Entities, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn select_returns_typed_values_for_every_seeded_column() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "SELECT * FROM demo_row ORDER BY id LIMIT 10", "test")
        .await
        .unwrap();
    match result_to_dto(result).unwrap() {
        ResultDto::Rows(rows) => {
            assert!(!rows.rows.is_empty(), "fixture should be seeded");
            let kinds: Vec<&str> = rows.rows[0].iter().map(|v| v.kind.as_str()).collect();
            for expected in ["ulid", "text", "nat", "decimal", "principal", "timestamp", "blob", "bool"] {
                assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
            }
        }
        other => panic!("expected Rows, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a local replica with the fixture canister installed"]
async fn describe_reports_the_primary_key() {
    let (agent, canister) = connect().await;
    let result = run_query(&agent, canister, "DESCRIBE demo_row", "test").await.unwrap();
    match result_to_dto(result).unwrap() {
        ResultDto::Schema(schema) => {
            assert!(schema.columns.iter().any(|c| c.primary_key), "expected a primary key column");
        }
        other => panic!("expected Schema, got {other:?}"),
    }
}
```

- [ ] **Step 3: Add the integration dev-dependency**

```toml
[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

- [ ] **Step 4: Create the deploy config**

This repo has **no** `dfx.json`, no `icp.yaml`, and no `.icp/` — nothing yet tells a
local replica how to install the fixture. Create the minimal config that names the
fixture as a prebuilt canister, pointing at the wasm and candid Task 2 already
produces:

```json
{
  "canisters": {
    "fixture": {
      "type": "custom",
      "candid": "fixture/fixture.did",
      "wasm": "target/wasm32-unknown-unknown/release/icydb_explorer_fixture.wasm"
    }
  },
  "networks": { "local": { "bind": "127.0.0.1:4943", "type": "ephemeral" } },
  "version": 1
}
```

Both `icp` and `dfx` are on PATH and either may drive the replica — `icp project show`
prints the effective config if you need to debug resolution. Adjust paths to whatever
Task 2 actually emitted rather than trusting the names above, and report what you
created and which tool you used.

- [ ] **Step 5: Deploy the fixture and run the integration tests**

```bash
icp start --background
icp canister create fixture && icp canister install fixture
cargo test --test integration -- --ignored
```

Expected: PASS, 3 tests. These are the first end-to-end proof that a real canister response decodes into DTOs. If `SHOW ENTITIES` returns `IntrospectionDisabled`, `fixture/icydb.toml` has `introspection.local = false` — fix the config, not the test.

- [ ] **Step 6: Verify the unit suite still passes**

Run: `cd src-tauri && cargo test`
Expected: PASS (integration tests skipped as ignored).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src-tauri/tests/integration.rs src-tauri/Cargo.toml dfx.json
git commit -m "feat: add Tauri command surface with live fixture integration tests"
```

---

## Task 11: Frontend — types, API wrappers, and value rendering

**Files:**
- Create: `src/api/types.ts`, `src/api/commands.ts`, `src/components/ValueCell.tsx`
- Create: `src/components/ValueCell.test.tsx`
- Modify: `package.json` (Vitest)

**Interfaces:**
- Consumes: the Task 10 command surface
- Produces:
  - `ValueDto`, `RowsDto`, `SchemaDto`, `EntityDto`, `ResultDto`, `TreeNode`, `AppErrorDto` TypeScript types
  - `listEnvironments`, `canisterTree`, `listTables`, `describeTable`, `fetchRows`, `runSql` async wrappers
  - `<ValueCell value={ValueDto} />`

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

Add to `package.json` scripts: `"test": "vitest run"`. Create `vitest.config.ts` with `test: { environment: "jsdom", globals: true }`.

- [ ] **Step 2: Write `src/api/types.ts`**

Mirror the backend DTOs exactly. `ResultDto` is a discriminated union on `type`:

```ts
export type ValueDto = { kind: string; display: string };

export type RowsDto = {
  entity: string;
  columns: string[];
  rows: ValueDto[][];
  rowCount: number;
  nextCursor: string | null;
};

export type ColumnDto = { name: string; typeName: string; primaryKey: boolean; optional: boolean };
export type SchemaDto = { entity: string; columns: ColumnDto[]; indexes: string[] };
export type EntityDto = {
  name: string; storePath: string; storage: string;
  columns: number; indexes: number; relations: number; schemaVersion: number;
};

export type ResultDto =
  | ({ type: "rows" } & RowsDto)
  | ({ type: "schema" } & SchemaDto)
  | { type: "entities"; entities: EntityDto[] }
  | { type: "count"; entity: string; rowCount: number }
  | { type: "explain"; entity: string; explain: string }
  | { type: "indexes"; entity: string; indexes: string[] };

export type TreeNode = { pid: string; role: string; children: TreeNode[] };
export type AppErrorDto = { kind: string; explanation: string };
export type SqlRunDto = { result: ResultDto; limitAppended: boolean };
```

- [ ] **Step 3: Write the failing `ValueCell` test**

```tsx
import { render, screen } from "@testing-library/react";
import { ValueCell } from "./ValueCell";

test("renders a text value verbatim", () => {
  render(<ValueCell value={{ kind: "text", display: "hello" }} />);
  expect(screen.getByText("hello")).toBeDefined();
});

test("renders null as a visible placeholder rather than empty space", () => {
  render(<ValueCell value={{ kind: "null", display: "" }} />);
  expect(screen.getByText("null")).toBeDefined();
});

test("right-aligns numeric kinds", () => {
  const { container } = render(<ValueCell value={{ kind: "nat", display: "42" }} />);
  expect(container.firstChild).toHaveClass("text-right");
});

test("renders principals and ulids in a monospace font", () => {
  const { container } = render(<ValueCell value={{ kind: "principal", display: "aaaaa-aa" }} />);
  expect(container.firstChild?.className).toContain("font-mono");
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./ValueCell`.

- [ ] **Step 5: Implement `ValueCell.tsx`**

Switch on `kind`. Numeric kinds (`int`, `int128`, `intbig`, `nat`, `nat128`, `natbig`, `float32`, `float64`, `decimal`) get `text-right tabular-nums`. Identifier kinds (`principal`, `ulid`, `subaccount`, `account`, `blob`) get `font-mono text-xs`. `null` renders the literal text `null` in a muted italic style so an empty cell is distinguishable from an empty string. Everything else renders `display` as-is, truncated with `truncate` and a `title` attribute carrying the full value.

- [ ] **Step 6: Run to verify it passes**

Run: `npm test`
Expected: PASS, 4 tests.

- [ ] **Step 7: Implement `src/api/commands.ts`**

Thin typed wrappers over `invoke` from `@tauri-apps/api/core`, one per Task 10 command. Each catches and rethrows the backend error as `AppErrorDto` so callers can render `explanation` directly.

- [ ] **Step 8: Commit**

```bash
git add src/api src/components/ValueCell.tsx src/components/ValueCell.test.tsx package.json vitest.config.ts
git commit -m "feat: add frontend DTO types, command wrappers, and value rendering"
```

---

## Task 12: Frontend — explorer UI

**Files:**
- Create: `src/components/CanisterTree.tsx`, `src/components/TableList.tsx`, `src/components/SchemaPanel.tsx`, `src/components/RowGrid.tsx`, `src/components/SqlConsole.tsx`, `src/components/ErrorBanner.tsx`
- Create: `src/components/RowGrid.test.tsx`, `src/components/SqlConsole.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: everything from Task 11
- Produces: the assembled application

- [ ] **Step 1: Write the failing `RowGrid` test**

```tsx
import { render, screen } from "@testing-library/react";
import { RowGrid } from "./RowGrid";

const rows = {
  entity: "demo_row",
  columns: ["id", "count"],
  rows: [[{ kind: "ulid", display: "01H" }, { kind: "nat", display: "7" }]],
  rowCount: 1,
  nextCursor: null,
};

test("renders column headers and cells", () => {
  render(<RowGrid rows={rows} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText("id")).toBeDefined();
  expect(screen.getByText("01H")).toBeDefined();
  expect(screen.getByText("7")).toBeDefined();
});

test("hides Load more when there is no more to load", () => {
  render(<RowGrid rows={rows} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
});

test("shows Load more when more may exist", () => {
  render(<RowGrid rows={rows} hasMore onLoadMore={() => {}} />);
  expect(screen.getByRole("button", { name: /load more/i })).toBeDefined();
});

test("renders an empty result without crashing", () => {
  render(<RowGrid rows={{ ...rows, rows: [], rowCount: 0 }} hasMore={false} onLoadMore={() => {}} />);
  expect(screen.getByText(/no rows/i)).toBeDefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./RowGrid`.

- [ ] **Step 3: Implement `RowGrid.tsx`**

A `<table>` with sticky headers, one `<ValueCell>` per cell, an empty state reading
"No rows", and a "Load more" button rendered only when the `hasMore` prop is true.

`hasMore` is a prop rather than something `RowGrid` derives, because scalar paging is
`LIMIT`/`OFFSET` (see Task 10) and only the caller knows the requested page size and
current offset. Keeping that arithmetic in `App.tsx` leaves `RowGrid` a dumb,
trivially testable renderer.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Write the failing `SqlConsole` test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { SqlConsole } from "./SqlConsole";

test("surfaces a rejection explanation without running the statement", () => {
  const onRun = vi.fn();
  render(<SqlConsole onRun={onRun} error={{ kind: "rejected", explanation: "INSERT is not available — this explorer is read-only." }} />);
  expect(screen.getByText(/read-only/i)).toBeDefined();
});

test("notifies when a default LIMIT was appended", () => {
  render(<SqlConsole onRun={() => {}} limitAppended />);
  expect(screen.getByText(/limit/i)).toBeDefined();
});

test("runs the statement on submit", () => {
  const onRun = vi.fn();
  render(<SqlConsole onRun={onRun} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SELECT 1" } });
  fireEvent.click(screen.getByRole("button", { name: /run/i }));
  expect(onRun).toHaveBeenCalledWith("SELECT 1");
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./SqlConsole`.

- [ ] **Step 7: Implement `SqlConsole.tsx`**

A textarea, a Run button, an inline rejection message, and a notice when `limitAppended` is true stating that a default `LIMIT` was added. Per the Global Constraints, copy must not claim the app is protecting the database — phrase rejections as what this explorer supports ("this explorer is read-only"), not as an enforcement action.

- [ ] **Step 8: Run to verify it passes**

Run: `npm test`
Expected: PASS, 7 tests.

- [ ] **Step 9: Implement the remaining components and assemble `App.tsx`**

- `CanisterTree.tsx` — recursive `TreeNode` list; clicking a node selects that canister. Show `role` as the label and `pid` in a muted monospace subtitle.
- `TableList.tsx` — entities from `listTables`, showing name plus column and index counts.
- `SchemaPanel.tsx` — columns with type names, a primary-key marker, and the index list.
- `ErrorBanner.tsx` — renders `AppErrorDto.explanation` as pre-wrapped text. Because the backend already writes operator-facing explanations, this component must not paraphrase or truncate them.
- `App.tsx` — three-pane layout: canister tree, table list plus schema, and the grid with the console beneath.

- [ ] **Step 10: Verify the build and full suite**

```bash
npm run build && npm test && (cd src-tauri && cargo test)
```

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src
git commit -m "feat: assemble explorer UI with tree, schema, grid, and console"
```

---

## Task 13: End-to-end verification against a real canister

**Files:**
- Create: `README.md`
- Modify: none

**Interfaces:**
- Consumes: the complete application

- [ ] **Step 1: Run the app against the fixture**

```bash
icp start --background
npm run tauri dev
```

Confirm by direct observation, not assumption: the fixture canister appears in the tree, `demo_row` and `demo_child` appear in the table list, the schema panel shows the Ulid primary key, the grid shows seeded rows with type-aware alignment, and `SELECT * FROM demo_child` runs in the console.

- [ ] **Step 2: Verify the read-only rejection path**

Type `DELETE FROM demo_row` in the console and confirm the rejection appears without a canister call, and that its wording does not claim the app blocked a write for safety.

- [ ] **Step 3: Verify the no-SQL-surface path against toko**

toko does not enable the SQL surface, which makes it the ideal negative test:

```bash
cd /Users/remcodes/projects/dragginz/toko && icp start --background
```

Point the explorer at toko's project root and select a canister. Confirm the `NoSqlSurface` explanation appears, naming the canister and the required `features = ["sql"]` and `icydb.toml`. This is the error most users will hit first, so it must read as actionable guidance.

- [ ] **Step 4: Write `README.md`**

Cover: what the app does; the prerequisite that target canisters need `features = ["sql"]` plus an `icydb.toml` (with the read-only config from `fixture/icydb.toml` as the example); that endpoints are controller-gated so the identity must be a controller; that `introspection.ic = false` means mainnet schema browsing is unavailable until a canister opts in; how to run the fixture; and that `icydb` is pinned to `=0.202.1` with `src-tauri/src/view/` being the module to update on a version bump.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add README covering setup, prerequisites, and version pinning"
```

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to a task: feasibility → Task 1 Step 4 (the icydb-links-on-host check); prerequisite/fixture canister → Task 2; discovery inputs → Task 4; architecture and module table → Tasks 3–10; read-only enforcement → Task 5 plus Task 8 Step 5 (query calls only); SQL console → Tasks 5 and 12; paging → Tasks 10 and 12; error handling (all four cases) → Tasks 3 and 8; testing table (all five scopes) → Tasks 4, 6, 5, 10, 11–12; out-of-scope items → absent by construction; known risks → Task 13 Step 4 documents the version pin and both configuration constraints.

**Deliberate verification steps.** Three places instruct the implementer to confirm a signature against the installed crate before writing code, rather than trusting this plan: the `OutputValue` import path (Task 6 Step 2), the catalog accessor names (Task 6 Step 7), and icydb's cursor syntax (Task 10 Step 1). These are the details most likely to have shifted between icydb releases, and a wrong guess would surface as a confusing compile error. Task 2 Step 5 likewise directs the implementer to icydb's own tests for entity-macro syntax instead of inventing it.

**Task order.** The error type is Task 3 and discovery is Task 4, so discovery uses `AppError` from its first line. An earlier draft had these reversed with an explicit `String`-to-`AppError` conversion step; that was swapped before execution to remove a needless conversion and the reviewer finding it invited.

**Type consistency fixes applied during review.** Three inconsistencies were found and corrected rather than left for the implementer to hit as compile errors: DTO structs needed `#[serde(rename_all = "camelCase")]` for Task 11's TypeScript field names (`rowCount`, `nextCursor`) to match; `Statement` needed `Copy`/`PartialEq`/`Debug` for the Task 5 tests to compile; and a vestigial `AgentError::CertifiedReject` line in the Task 8 test would not have compiled.
