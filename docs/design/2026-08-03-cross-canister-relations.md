# Cross-canister relations — design

**Status:** approved 2026-08-03. Mockup:
`https://claude.ai/code/artifact/a311abde-8f57-4e2c-b816-a621d59a9c92`

## The constraint this is built around

icydb has no `JOIN` and no cross-database addressing, and this is not an
oversight to be waited out:

- `JOIN` is a lexer keyword that exists **only** to raise a diagnostic.
  `db/sql/parser/mod.rs:375` maps it to `SqlFeatureCode::Join`, the same
  treatment given `WITH`, `HAVING`, and window functions. There is no join
  within one canister either.
- `SHOW DATABASES` is a tested-unsupported command
  (`db/sql/parser/tests/mod.rs:4432` → `SqlFeatureCode::ShowUnsupportedCommand`).
- `FROM` takes one entity selector. There is no qualified `db.table`.
- Nothing in icydb's schema layer has any notion of a remote or foreign store.

So the explorer is the glue. Every statement it sends still goes to exactly one
canister; anything spanning two is the explorer fanning out and correlating the
results itself. Verified against `icydb-core-0.215.7`.

## Two kinds of link, and why they must never look alike

**Declared.** icydb's describe payload already carries a relation graph:

```rust
EntityRelationDescription {
    field, target_path, target_entity_name, target_store_path, cardinality
}
```

`EntitySchemaDescription::relations()` returns it on every `DESCRIBE`, and the
explorer currently fetches and discards it — `SchemaDto` keeps only `columns`
and `indexes`. `ConstraintDto` likewise drops `relation`, `target_entity`, and
`action`. Surfacing this costs no new queries.

Declared relations are **always intra-canister**. `target_store_path` names a
store in the same schema, and icydb could not enforce a foreign key across a
canister boundary even if it wanted to.

**Inferred.** A `project_instance` row holding a user id has nothing in its
schema saying that id lives in a `user_shard`. Cross-canister links are
therefore *always* a guess, and the design's central rule follows:

> An inferred link must never borrow the visual language of declared metadata,
> must always carry its reason, and following one is a choice between candidates
> rather than a jump.

Concretely: declared uses `--accent` (it is metadata with the same confidence as
a primary key, so it takes the primary key's colour); inferred uses `--warn-*`
(a guess the reader must distinguish at a glance, and `--warn` already means
"you need to know this"). No new tokens.

## What makes inference defensible here

toko's schema is newtype-heavy. `UserId`, `LedgerId`, and `AssetId` are distinct
types, so "this column's type is the primary-key type of that entity" is a
strong signal. The same rule over bare `Ulid` columns would produce far more
candidates than signal, so the inference is explicitly **type-name based, not
column-name based**, and a column whose type is a bare primitive yields no
candidates at all.

The fleet-wide catalog (`SHOW ENTITIES` per canister, one cheap query each) is
what turns a candidate type into a candidate location.

## Honesty requirements

These are requirements, not preferences. Each exists because the naive version
tells the reader something false.

1. **A sweep is not globally ordered.** Each canister orders its own page; the
   union is merged in canister order. The header says `merged`, never
   `ORDER BY`. Re-sorting the merged rows would only sort the fetched window,
   which is not the same thing and must not be presented as if it were.
2. **A canister the identity does not control is neither a hit nor a miss.** It
   cannot answer either way. It is reported as an error and excluded from the
   union — counting it as a zero would make a partly-authorised sweep read as a
   definitive "not found".
3. **Misses are reported.** When a keyed lookup sweeps a pool, "not in shard 1"
   is an answer. Without it a single hit looks like the only place the key could
   have been.
4. **One canister's failure never voids the sweep.** Outcomes are per-canister.
5. **Following a relation is a keyed lookup, not a join.** The explorer will not
   pretend to join two large tables. A real join would mean paging both sides;
   that is out of scope, and if it is ever added it must be bounded and say so.
6. **Read-only is unchanged.** Fan-out adds no new call site and relaxes no
   classification. Still one `.query()` in `sql/transport.rs`, still the same
   `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` classifier. No copy anywhere may claim
   the app *enforces* read-only access as a security boundary.

## Scope becomes state

The SQL bar currently carries a fixed note that a statement reaches only the
selected canister. Once a statement can sweep a pool that note is false, so it
becomes a **control**: a chip reading `project_instance · 1 canister` or
`user_shard · 3 canisters`, which toggles between a single canister and its
pool. A pool sweep additionally shows *"merged, not globally ordered"*.

## Navigation

Following a relation can land the reader in a different canister, so the Rows
pane header carries a trail (`ProjectInstance › User`) with each earlier step
clickable. Without it, crossing a boundary means losing your place.

## Phasing

Each phase is independently useful and shippable.

1. **Surface the relation metadata.** Free — the data is already fetched.
   `SchemaDto.relations`, the three `ConstraintDto` fields, and a Relations
   section in the schema pane.
2. **Follow a declared relation** within one canister: cell affordance,
   popover, trail. A one-to-many is followed *backwards* — the key is the row's
   own primary key matched against the target's column — so the generated
   statement must name that column, not `id`.
3. **Fan-out over a pool** with per-canister outcomes.
4. **Inferred cross-canister links**, built on the fleet catalog from (3).
