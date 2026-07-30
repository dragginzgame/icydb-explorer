# icydb author's review of our README — findings and disposition

**Date:** 2026-07-30
**Source:** the icydb developer, reviewing the README we wrote (in `README.md`)
against their own codebase. Read-only review; they changed nothing here.

Their report is authoritative about icydb. Every claim below was nonetheless
checked against what is actually on disk or published, because an author may be
reading `main` while we are pinned to a release. That check turned out to matter:
one of their findings is version drift rather than a bug in our code, and
"fixing" it would have introduced one.

## Verification results

| Their point | Verified state |
|---|---|
| Current API is 0.215.x, README targets 0.202.1 | **Confirmed.** Latest published is `0.215.5` (registry index, 1247 versions). We pin `0.202.1` — 13 minors behind. |
| `icydb_query` returns `Result<IcydbSqlQueryPerfResult, icydb::Error>` | **Confirmed, and already handled.** We found this independently during the explorer build and mirror the record locally, exactly as their CLI does in `crates/icydb-cli/src/shell/render.rs`. |
| `readonly = true` does **not** disable `icydb_ddl`, `icydb_update`, integrity, or fixtures | **Confirmed.** `icydb-config-0.202.1`'s `emit.rs` calls four independent switches: `with_sql_readonly_enabled`, `with_sql_ddl_enabled`, `with_sql_fixtures_enabled`, `with_sql_update_policy`. |
| The real read-only guarantee is calling only `icydb_query` | **Confirmed, and our code already does exactly this.** Three separate reviews verified exactly two network call sites, both `agent.query`. |
| Introspection diagnostic is 179, not 183 | **Version drift, not our bug.** `183` is correct at `icydb-diagnostic-code-0.202.1/src/registry.rs:510`. `179` is current. Our code is right for what we pin. |
| Never fall back to an unbounded `SELECT` | **Confirmed defect in our code.** `src-tauri/src/sql/rows.rs:36-38` returns a bare `SELECT * FROM {entity}` with no `LIMIT`. |
| Composite primary keys need every component in `ORDER BY` | **Already correct.** `rows_sql` joins all `pk_columns` (`rows.rs:22-25`). |
| `integrity` config key, `icydb_schema` endpoint | Do not exist in 0.202.1 — these are 0.215 features, so bump work rather than corrections. |
| "Use `icp`, never `dfx`" should be a tested compatibility note | **Accepted.** Ours generalised from a single observed 404 on one machine. |

## The correction that matters most

Our spec and README stated that the canister's `readonly = true` **is** the
security boundary. That is wrong, and wrong in the dangerous direction: a reader
could follow our README, set `readonly = true`, leave `ddl` unset, and believe
they were protected while `icydb_ddl` was still generated.

The author's framing is both accurate and stronger, and it happens to describe
what our implementation already does: the app calls **only** `icydb_query`, a
query method whose dispatcher rejects mutation statements, and query calls cannot
persist canister state. The code was right; the stated reason it was safe was not.

Their recommended target configuration also sets `ddl = false`, `update = false`,
`integrity = false`, and `fixtures = false` for production — belt and braces on
top of the query-only guarantee, rather than a substitute for it.

## Disposition (agreed with the user)

**Folded into the identity work's final task**, since it already owns the README:

1. Correct the `readonly = true` safety claim in both `README.md` and
   `docs/superpowers/specs/2026-07-29-icydb-explorer-design.md`. State the
   query-only guarantee as the real one, and recommend `ddl`/`update`/`integrity`/
   `fixtures = false` as defence in depth rather than as the boundary.
2. Remove the unbounded `SELECT` fallback. When the primary key cannot be
   discovered, disable automatic paging or require a bounded user query — never
   issue an unbounded read against the trusted/admin SQL lane, which
   intentionally bypasses public-read admission.
3. Soften the `dfx` claim to a compatibility note recording what was observed,
   not a categorical rule.

**Deferred to a separate spec/plan cycle:** the `0.202.1` → `0.215.5` bump,
scoped as *bump-and-adapt only* — take the new version, fix what the compiler
flags, renumber the diagnostic, and handle the new recursive `OutputValue`
variants. The `view` layer's exhaustive matches with no wildcard arm exist
precisely so this surfaces as a compile error rather than a silent mis-render;
the bump is the test of that design bet.

**Not ours to do:** the author proposes exposing the generated envelope publicly
as `icydb::db::sql::SqlQueryEndpointResponse`, which would let us delete our local
mirror. Until that ships, mirroring is correct and matches their own CLI.

## Their recommended configuration, for reference

```toml
[canisters.fixture.sql]
readonly = true
ddl = false
fixtures = true        # development fixture only
integrity = false
update = false

[canisters.fixture.sql.introspection]
local = true
ic = false

[canisters.fixture.schema]
enabled = true
```

Note `integrity` and `[schema]` require 0.215; they are not valid keys in 0.202.1.

---

## Parked follow-ups from this phase

Recorded here because the phase's SDD workspace is deleted at completion and these
should outlive it.

1. **`AgentPool` needs a `get_or_build` seam.** The pool-wide lock is now correctly
   released across `load_identity` and `fetch_root_key`, but nothing *tests* that one
   pending build doesn't block another key's lookup — `AgentPool::get` has no seam for
   a slow loader (concrete `Environment`/`IdentityRef`, real `ic_agent::Agent`). An
   inner `async fn get_or_build<F: Future<Output = Result<Arc<Agent>, AppError>>>(&self,
   key: String, build: F)` would let a `tokio::test` hold one build pending on a
   `oneshot` and assert a second key's `get` completes — deterministic, no timers.
   The lock scope is a structural property a reader can confirm today, which is why
   this was parked rather than blocking the merge.
2. **No negative caching in `AgentPool::get`.** A persistently failing identity
   re-runs the 20-second export on every command that touches it. Correct as-is (a
   cached failure would be worse), but a rate-limit or a surfaced "last failure" note
   would be a real UX improvement.
3. **`host_of` can't parse bracketed IPv6 literals** (`agent/mod.rs`). Documented
   candidly in its own test; pre-existing and explicitly scoped out.
4. **`find_identity` doesn't distinguish "no such name" from "exists but unusable."**
   The distinction surfaces later from `load_identity`. A more specific message would
   speed diagnosis in the UI.
5. **Switching identity discards the canister and entity selection.** Canister ids
   don't depend on identity; re-fetching the tree while preserving the selection would
   be kinder.
6. **`identity.rs`'s `pem`-with-no-`pem_path` branch is unreachable** — `IdentityRef::new`
   already sets `unusable_reason` for that combination and the early guard returns
   first. Harmless, but it reads as live and isn't.
7. **The spec still describes cursor paging** in places
   (`2026-07-29-icydb-explorer-design.md`), contradicting the `LIMIT`/`OFFSET` reality.
   Pre-existing.
