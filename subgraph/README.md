# Zyro subgraph

Mirrors the live reservation price of every shipped Zyro position.

## Why this exists

Zyro's liquidity is **order-based and distributed across individual makers**.
There is no pool contract holding reserves, so a router cannot read a reserve to
price a Zyro position — it would have to re-derive the entire
Avellaneda–Stoikov calculation itself. This subgraph re-runs that math in
AssemblyScript ([`src/avellaneda-stoikov.ts`](src/avellaneda-stoikov.ts)) so a
solver can query the current reservation price directly.

## Correctness

A subgraph that publishes a price the chain would not quote is worse than one
that publishes nothing: a solver routes on it, and the execution disagrees with
the quote.

So the Solidity is the source of truth. `contracts/test/KernelFixtures.t.sol`
writes reference outputs from a live `forge test` run into
`contracts/test/fixtures/kernel.json`, and every off-chain re-implementation is
checked against it — every intermediate, not just the final balance pair, since
two compensating errors can land on the right endpoint. CI fails if the
committed fixtures drift from the contract.

## Four things that are easy to get wrong here

Each is a silent failure — a plausible wrong number, not an error.

**1. Balances come from `Pushed`/`Pulled`, and only from them.** They are Aqua's
authoritative per-strategy ledger. Starting from zero and accumulating `Swapped`
deltas measures *flow* rather than *holdings*, which makes every derived
reservation price wrong; handling both sources would double-count.
`handleSwapped` therefore deliberately does not touch balances.

**2. `Pushed` fires before `Shipped`** within the same `ship()` transaction.
Early pushes are buffered in `PendingPush` and drained when the position is
created. Without that the position starts empty and every price is computed
against a zero balance.

**3. The mid is captured *before* the fill's deltas are applied.** Writing it
afterwards stores the post-fill mid under a pre-fill name — and that series is
exactly the headline chart, mid and reservation price sitting on top of each
other when balanced and separating as inventory drifts.

**4. EVM bytes are big-endian; `BigInt.fromSignedBytes` expects little-endian.**
Every multi-byte field is reversed before conversion (`readIntBE` /
`readUintBE`). Skipping the reversal gives a wrong number with no error — and
using the *unsigned* reader on a signed field would turn a negative `gamma`, the
exact value `validate` exists to reject, into a huge positive one.

## Two corrections to the build spec

- **`order.data` has no token prefix.** `ZYRO_BUILD_SPEC.md` §20 says it is
  `tokenA(20) ++ tokenB(20) ++ program`. 1inch's own `Order.build()` shows it is
  `hooksData ++ program`. The program is sliced at the offset `MakerTraits`
  records in bits [208, 224) of the traits word — a fixed 40-byte offset would
  read program bytes as two addresses and mis-parse everything after.
- **Zyro's opcode is 34, not `0x92`.** The Aqua dispatch table is a dense
  34-entry array, so `0x92` (146) is off the end of it. See
  [`docs/PHASE2-SOURCE-VERIFICATION.md`](../docs/PHASE2-SOURCE-VERIFICATION.md).

Aqua's events fire for *every* app built on it, so each handler filters on the
Zyro router's address in [`src/config.ts`](src/config.ts).

## Usage

```bash
npm install
npm run codegen
npm run build

# Set the deployed addresses first — see networks.json and src/config.ts
npm run auth -- <DEPLOY_KEY>
npm run deploy
```

`Aqua` and `ZyroRouter` addresses in `networks.json` and `src/config.ts` are
placeholders until the Base Sepolia deployment lands.

## Subgraph MCP

[`mcp/mcp.config.json`](mcp/mcp.config.json) points at The Graph's official
Subgraph MCP endpoint, so an agent can discover and query the reservation-price
mirror without being handed the schema up front.
