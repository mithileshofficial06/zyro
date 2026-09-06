# Feedback — The Graph

Written against `@graphprotocol/graph-cli` `0.97.1`, `graph-ts` `0.38.1`,
`matchstick-as` `0.6.0`, plus the hosted Subgraph MCP server.

Development machine is Windows 11. Several items below are specific to that,
and we think they matter more than they look — a hackathon entrant on Windows
hits them in the first hour.

---

## 1. Matchstick has no Windows binary, and the fallback needs Docker

```
Error: Failed to get matchstick binary: Unsupported platform: Windows_NT x64 10
Consider using -d flag to run it in Docker instead:
  graph test -d
```

Clear error, and a real dead end without Docker installed. We ended up running
the suite only in Linux CI, which meant every subgraph test was written blind
and validated on a push.

We did find a partial workaround worth documenting: matchstick tests are just
AssemblyScript, so they can be **typechecked** locally with

```
npx asc --explicitStart --exportRuntime --runtime stub tests/x.test.ts \
  --lib node_modules --outFile /dev/null
```

That catches the large majority of mistakes — wrong imports, wrong entity field
names, type errors — without executing anything. (Note the `--use abort=…` flag
that `graph test` passes fails to resolve when invoked this way; omitting it is
fine for a typecheck.)

**Suggestion:** either a WASM/Node build of matchstick, or a documented
"typecheck only" mode. The second is cheap and would have changed our week.

## 2. `graph build --network <name>` rewrites `subgraph.yaml` and strips comments

This one cost us real content. `--network` substitutes `networks.json` into the
manifest by parsing the YAML and writing it back out, which discards every
comment in the file.

Our `subgraph.yaml` documented two non-obvious things: why no Aqua event
parameter may be marked `indexed` (a signature that marked one would decode
garbage), and why balances come from `Pushed`/`Pulled` rather than `Swapped`.
Both vanished on the first build.

We worked around it by patching the manifest addresses ourselves and dropping
`--network` entirely. That works, but it means opting out of the intended
mechanism to keep comments — which feels like the wrong trade to have to make.

**Suggestion:** a comment-preserving YAML round-trip, or `--network` writing
only to `build/` and leaving the source manifest alone.

## 3. `graph auth --studio` and `graph deploy --studio` no longer exist

Our scripts carried `graph auth --studio` and `graph deploy --studio <name>`,
copied from documentation that was current when written. In `0.97.1` there is no
`--studio` flag on either command and both fail outright.

That failure is at least loud. The quieter sibling is worse:

## 4. Forgetting `--network` produces a subgraph that indexes nothing, silently

`graph build` with no `--network` leaves the manifest's placeholder addresses in
place. If those are `0x000…0` — which they are in any repo that commits a
template — the deployed subgraph watches `address(0)`, indexes nothing, reports
no error, and shows a healthy sync to chainhead.

That is indistinguishable, from Studio's UI, from a subgraph whose mappings
filter everything out. We spent time on the wrong one.

**Suggestion:** warn at build time when a data source address is the zero
address. It is never intentional.

## 5. "Live and indexing" and "returns correct data" are very far apart

This is the most useful thing we can report, and it is about the platform's
success surface rather than a bug.

Our subgraph shipped **two** distinct bugs that each produced a perfectly
healthy deployment returning wrong numbers:

- Aqua emits `Shipped` before `Pushed`, so our position-creation handler priced
  against zero balances and published `reservationPrice = 0` for every position
  until it happened to be traded against.
- Aqua emits `Pushed`/`Pulled` at settlement *before* the router's `Swapped`, so
  our fill handler read the store expecting pre-fill state and got post-fill
  state — storing the post-fill mid under a pre-fill name in the exact series
  our headline chart plots.

Neither threw. Neither produced an indexing error. Both synced to chainhead and
reported themselves healthy. Studio's status page said everything was fine, and
it was telling the truth about everything it measures.

We only found them by building a second opinion: a read-only on-chain contract
that reads the same authoritative ledger and runs the same arithmetic, then
comparing every published field against it **at the block `_meta` reports** —
never at chainhead, since a subgraph lags and comparing across blocks reports a
clock as a bug.

**Suggestion:** we think there is a real product here. Something like a
"correctness harness" primitive — declare an `eth_call` that should agree with
an entity field, and have the indexer surface disagreement the way it surfaces
indexing errors. Right now the platform can tell you a mapping *crashed* but has
no notion of a mapping being *wrong*, and the second failure mode is far more
common and far more damaging.

At minimum: the docs could say plainly that a green sync is not evidence of
correctness, and suggest cross-checking against chain state. We would have built
our verifier on day one instead of day four.

## 6. The AssemblyScript sharp edges are real, and the docs undersell them

Three that bit us, all silent:

- **`BigInt.fromUnsignedBytes`/`fromSignedBytes` expect little-endian.** Every
  value decoded out of EVM bytes is big-endian. Skipping the reversal gives a
  plausible wrong number with no warning. This is mentioned in the docs, but it
  deserves to be in a box, in red.
- **`==` on `Bytes` compares identity, not value.** An address filter written
  with `!=` rejects everything, so the subgraph indexes nothing and looks
  healthy. Same symptom as item 4, different cause. `.equals()` is required.
- **Entity array fields must be reassigned wholesale.** Mutating what a getter
  returned does not write back. No error, no warning, no stored value.

All three share a shape: the wrong code compiles, runs, and produces nothing or
something plausible. A "common silent failures" page would be genuinely
valuable.

## 7. Nullable user-class returns can crash the compiler

Returning `ZyroStrategy | null` from a mapping helper crashed `asc` with
`AssertionError: assertion failed` and no source location. We modelled
nullability as a `valid: boolean` field on the class instead, which works fine.

Worth a known-issues note — the error gives you nothing to search for.

## 8. Subgraph MCP: good, but the config shape is hard to find

We had committed a config of the form `{"type": "sse", "url": …}` with a
`SUBGRAPH_ID` in `env`, which would never have connected. The working shape
goes through `mcp-remote` and authenticates with a **Gateway API key** in an
`Authorization` header — the subgraph id is an argument to a tool, not a
credential.

We eventually found this, but two documentation URLs we tried returned 404s and
the config we ended up using came from a community repository rather than the
official docs.

One thing we would add to the docs: prefer the **deployment id** over the
subgraph id when demonstrating anything. A subgraph id resolves to whatever
version is current, so a redeploy silently changes what an agent is querying —
which for a live demo is exactly the wrong property.

## 9. What worked well

- `graph codegen` producing typed entity and event classes is excellent, and
  caught a schema/mapping mismatch immediately every time we changed the schema.
- `indexerHints: prune: auto` is a good default and needed no thought.
- `@derivedFrom` made the position → balances → fills shape natural to query.
- `_meta { block { number } hasIndexingErrors }` is exactly the right primitive
  and is what made our block-pinned verification possible at all. More of this.

---

## Summary

| Friction | Cost | Suggested fix |
|---|---|---|
| No Windows matchstick | High — tests written blind, validated in CI | WASM build, or a documented typecheck-only mode |
| `--network` strips manifest comments | Medium — lost documentation | Comment-preserving round-trip |
| Missing `--network` indexes nothing | High — silent, looks healthy | Warn on a zero-address data source |
| Green sync ≠ correct data | Highest — two shipped bugs | A correctness-harness primitive; at minimum, say so in the docs |
| AssemblyScript silent failures | High — three separate instances | A "common silent failures" page |
| MCP config shape | Low | Put the working JSON in the official docs |

The through-line: The Graph is very good at telling you when a mapping
*crashed*, and has nothing to say about a mapping being *wrong*. Everything
expensive we hit lived in that gap.
