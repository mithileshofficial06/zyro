# Zyro Substreams

A Substreams package that decodes 1inch Aqua's position lifecycle and the Zyro
router's fills, and emits `EntityChanges` so the **same schema** as the
AssemblyScript subgraph can be served by a Substreams-powered subgraph.

Built following [`streamingfast/substreams-skills`](https://github.com/streamingfast/substreams-skills)
(`substreams-dev`, `substreams-ethereum`).

## Modules

| Module | Kind | Output |
|---|---|---|
| `map_events` | map | `zyro.v1.Events` — one typed message per decoded event |
| `graph_out` | map | `sf.substreams.sink.entity.v1.EntityChanges` |

## Build

```bash
cargo build --target wasm32-unknown-unknown --release
cargo test --lib
substreams pack          # requires the substreams CLI
```

## Design notes

**One protobuf message per event.** `Shipped`, `Docked`, `Pushed`, `Pulled` and
`Swapped` each get a dedicated message with named, typed fields — not one
generic `Event` with a `raw_data` blob. Sinks and SQL tables need stable
per-event schemas.

**Every `uint256` is a decimal string.** It never fits in a `uint64`, and
silently truncating an amount or a WAD-scaled parameter is a correctness bug,
not a formatting choice.

**The router address is a module parameter**, not a compiled-in constant. Aqua's
events fire for *every* app built on Aqua, so without the filter this would try
to decode unrelated protocols' strategies as Zyro programs.

**Balances come from `Pushed`/`Pulled` only.** They are Aqua's authoritative
per-strategy ledger. Accumulating `Swapped` deltas on top of zero measures flow
rather than holdings; handling both would double-count.

**Zyro's opcode is 34, not `0x92`.** The Aqua dispatch table is a dense 34-entry
array, so `0x92` (146) is off the end of it. The instruction walk is exact
(`opcode ++ argsLength ++ args`) rather than a scan for a magic byte, so a `34`
inside another instruction's arguments cannot be mistaken for an opcode.

**`order.data` is `hooksData ++ program`.** The program is sliced at the offset
`MakerTraits` records in bits [208, 224) of the traits word — *not* at a fixed
40 bytes. See [`docs/UPSTREAM-SDK-VERIFICATION.md`](../docs/UPSTREAM-SDK-VERIFICATION.md).

## Three toolchain decisions worth recording

**`substreams-entity-change` is not a dependency.** Its latest release (2.0.0)
pins `substreams 0.6.4` while `substreams-ethereum 0.11` needs `0.7.6`. Two
copies of the `substreams` crate means two allocators, and the wasm link fails
with `duplicate symbol: alloc`. `proto/entity.proto` is vendored instead — the
same approach StreamingFast's own `T3.2-cross-dex-volume` example takes.

**`crate-type` is `cdylib` only.** Adding `rlib` links the crate twice into the
module and produces the same duplicate-allocator failure.

**LTO is off.** With `lto = true` the build fails with `failed to load bitcode of
module "substreams-….rcgu.o"` — a mismatch between the crate's precompiled
bitcode and the current rustc. The cost is a larger `.wasm`.

## Building on Windows

`rustup`'s default MSVC toolchain needs Visual Studio C++ build tools. Without
them, use the GNU host toolchain and a MinGW-w64 install whose path contains
**no spaces** — `ld.exe` does not quote paths, so a toolchain under
`C:\Users\First Last\…` fails with `cannot find C:/Users/First`.

```powershell
rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal
winget install BrechtSanders.WinLibs.POSIX.UCRT
# then copy mingw64 somewhere space-free, e.g. C:\ProgramData\mingw64
```

CI runs on Linux and needs none of this.
