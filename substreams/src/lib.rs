//! Zyro Substreams.
//!
//! Decodes 1inch Aqua's position lifecycle and the Zyro router's fills, then
//! emits `EntityChanges` for a Substreams-powered subgraph serving the same
//! schema as `subgraph/schema.graphql`.
//!
//! ## Why the app filter matters
//!
//! Aqua's `Shipped`, `Docked`, `Pushed` and `Pulled` fire for **every app built
//! on Aqua**, not just Zyro. Every module here filters on the router address,
//! passed as a module parameter so it is configurable per network rather than
//! compiled in.
//!
//! ## Why balances come only from Pushed/Pulled
//!
//! Those two are the authoritative per-strategy ledger. Starting from zero and
//! accumulating swap deltas measures *flow* rather than *holdings*, which makes
//! every derived reservation price wrong; handling both sources would
//! double-count. `Swapped` is used for the fill series only.

mod abi;
pub mod program;

use substreams::errors::Error;
use substreams::log;
use substreams_ethereum::pb::eth::v2 as eth;

#[allow(clippy::all)]
mod pb {
    include!(concat!(env!("OUT_DIR"), "/zyro.v1.rs"));

    /// The entity-change wire format graph-node's Substreams sink consumes.
    /// Vendored rather than pulled from `substreams-entity-change`, whose
    /// latest release pins an incompatible `substreams` version.
    #[allow(clippy::all)]
    pub mod entity {
        include!(concat!(env!("OUT_DIR"), "/sf.substreams.sink.entity.v1.rs"));
    }
}

use pb::entity::{
    entity_change::Operation, value::Typed, EntityChange, EntityChanges, Field, Value,
};
use pb::{Docked, Events, Pulled, Pushed, Shipped, Swapped};
use program::{decode_strategy, to_decimal};

// ---------------------------------------------------------------------------
// EntityChange builders
// ---------------------------------------------------------------------------

fn string_value(s: &str) -> Value {
    Value {
        typed: Some(Typed::String(s.to_string())),
    }
}

/// Integers go over the wire as `bigint` decimal strings.
///
/// The subgraph schema types these as `BigInt`, and a `uint256` never fits in
/// an `int32` — silently truncating an amount or a WAD-scaled parameter would
/// be a correctness bug, not a formatting one.
fn bigint_value(s: &str) -> Value {
    Value {
        typed: Some(Typed::Bigint(s.to_string())),
    }
}

fn bigint_from_u64(v: u64) -> Value {
    bigint_value(&v.to_string())
}

fn bytes_value(b: &[u8]) -> Value {
    Value {
        typed: Some(Typed::Bytes(b.to_vec())),
    }
}

fn bool_value(b: bool) -> Value {
    Value {
        typed: Some(Typed::Bool(b)),
    }
}

fn field(name: &str, value: Value) -> Field {
    Field {
        name: name.to_string(),
        new_value: Some(value),
    }
}

fn change(entity: &str, id: &str, op: Operation, fields: Vec<Field>) -> EntityChange {
    EntityChange {
        entity: entity.to_string(),
        id: id.to_string(),
        ordinal: 0,
        operation: op as i32,
        fields,
    }
}

substreams_ethereum::init!();

/// Parses the module parameter into the Aqua "app" address to filter on.
fn parse_app(params: &str) -> Result<Vec<u8>, Error> {
    let trimmed = params.trim().trim_start_matches("0x");
    let bytes = hex::decode(trimmed)
        .map_err(|e| Error::msg(format!("router address is not hex: {e}")))?;
    if bytes.len() != 20 {
        return Err(Error::msg(format!(
            "router address must be 20 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(bytes)
}

fn addr(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn hash(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Decodes every Zyro-relevant event in the block.
#[substreams::handlers::map]
fn map_events(params: String, blk: eth::Block) -> Result<Events, Error> {
    let app = parse_app(&params)?;
    let mut events = Events::default();

    let timestamp = blk
        .header
        .as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds as u64)
        .unwrap_or_default();

    for log_view in blk.logs() {
        let l = log_view.log;
        let tx_hash = format!("0x{}", hex::encode(&log_view.receipt.transaction.hash));
        let log_index = l.block_index;

        // `match_log` checks topic0, `decode` reads the payload. Every field of
        // every Aqua event is non-indexed, so all of them come out of
        // `log.data` — a handler expecting `maker` or `app` in `topics` would
        // read the wrong bytes without erroring.
        if abi::aqua::events::Shipped::match_log(l) {
            let e = match abi::aqua::events::Shipped::decode(l) {
                Ok(e) => e,
                Err(err) => {
                    log::info!("failed to decode Shipped: {}", err);
                    continue;
                }
            };
            if e.app != app {
                continue;
            }
            let decoded = decode_strategy(&e.strategy);
            let mut m = Shipped {
                block_number: blk.number,
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index,
                maker: addr(&e.maker),
                app: addr(&e.app),
                strategy_hash: hash(&e.strategy_hash),
                strategy: e.strategy.clone(),
                ..Default::default()
            };
            if let Some(s) = decoded {
                m.is_zyro = true;
                m.gamma_wad = to_decimal(&s.gamma_wad);
                m.sigma_sq_wad = to_decimal(&s.sigma_sq_wad);
                m.base_spread_wad = to_decimal(&s.base_spread_wad);
                m.target_inventory_wad = to_decimal(&s.target_inventory_wad);
                m.bound_wad = to_decimal(&s.bound_wad);
                m.horizon_secs = s.horizon_secs;
                m.start_timestamp = s.start_timestamp;
                m.program = s.program;
            } else {
                log::info!(
                    "shipped to the Zyro router but not a Zyro program: {}",
                    hash(&e.strategy_hash)
                );
            }
            events.shipped.push(m);
        } else if abi::aqua::events::Docked::match_log(l) {
            let e = match abi::aqua::events::Docked::decode(l) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if e.app != app {
                continue;
            }
            events.docked.push(Docked {
                block_number: blk.number,
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index,
                maker: addr(&e.maker),
                app: addr(&e.app),
                strategy_hash: hash(&e.strategy_hash),
            });
        } else if abi::aqua::events::Pushed::match_log(l) {
            let e = match abi::aqua::events::Pushed::decode(l) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if e.app != app {
                continue;
            }
            events.pushed.push(Pushed {
                block_number: blk.number,
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index,
                maker: addr(&e.maker),
                app: addr(&e.app),
                strategy_hash: hash(&e.strategy_hash),
                token: addr(&e.token),
                amount: e.amount.to_string(),
            });
        } else if abi::aqua::events::Pulled::match_log(l) {
            let e = match abi::aqua::events::Pulled::decode(l) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if e.app != app {
                continue;
            }
            events.pulled.push(Pulled {
                block_number: blk.number,
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index,
                maker: addr(&e.maker),
                app: addr(&e.app),
                strategy_hash: hash(&e.strategy_hash),
                token: addr(&e.token),
                amount: e.amount.to_string(),
            });
        } else if abi::zyro_router::events::Swapped::match_log(l) {
            // Emitted by the router itself, so the emitting address is the
            // filter here rather than an `app` field.
            if l.address != app {
                continue;
            }
            let e = match abi::zyro_router::events::Swapped::decode(l) {
                Ok(e) => e,
                Err(_) => continue,
            };
            events.swapped.push(Swapped {
                block_number: blk.number,
                timestamp,
                tx_hash: tx_hash.clone(),
                log_index,
                order_hash: hash(&e.order_hash),
                maker: addr(&e.maker),
                taker: addr(&e.taker),
                token_in: addr(&e.token_in),
                token_out: addr(&e.token_out),
                amount_in: e.amount_in.to_string(),
                amount_out: e.amount_out.to_string(),
            });
        }
    }

    Ok(events)
}

/// Projects decoded events onto the subgraph schema as `EntityChanges`.
///
/// Entity and field names match `subgraph/schema.graphql` exactly, so the same
/// schema can be served either by the AssemblyScript handlers or by this
/// module — that is what makes this a port rather than a second data model.
#[substreams::handlers::map]
fn graph_out(events: Events) -> Result<EntityChanges, Error> {
    let mut changes: Vec<EntityChange> = Vec::new();

    for e in events.shipped.iter() {
        // Shipped to the Zyro router but not a Zyro program: legal, not ours.
        if !e.is_zyro {
            continue;
        }
        changes.push(change(
            "Position",
            &e.strategy_hash,
            Operation::Create,
            vec![
                field("maker", string_value(&e.maker)),
                field("app", string_value(&e.app)),
                field("active", bool_value(true)),
                field("gammaWad", bigint_value(&e.gamma_wad)),
                field("sigmaSqWad", bigint_value(&e.sigma_sq_wad)),
                field("baseSpreadWad", bigint_value(&e.base_spread_wad)),
                field("targetInventoryWad", bigint_value(&e.target_inventory_wad)),
                field("boundWad", bigint_value(&e.bound_wad)),
                field("horizonSecs", bigint_from_u64(e.horizon_secs)),
                field("startTimestamp", bigint_from_u64(e.start_timestamp)),
                field("program", bytes_value(&e.program)),
                field("createdAtBlock", bigint_from_u64(e.block_number)),
                field("createdAtTimestamp", bigint_from_u64(e.timestamp)),
                field("lastUpdatedTimestamp", bigint_from_u64(e.timestamp)),
            ],
        ));
    }

    for e in events.docked.iter() {
        changes.push(change(
            "Position",
            &e.strategy_hash,
            Operation::Update,
            vec![
                field("active", bool_value(false)),
                field("lastUpdatedTimestamp", bigint_from_u64(e.timestamp)),
            ],
        ));
    }

    // Balances come from Pushed/Pulled only — Aqua's authoritative per-strategy
    // ledger. Accumulating swap deltas instead would measure flow rather than
    // holdings, and handling both would double-count.
    for e in events.pushed.iter() {
        let id = format!("{}-{}", e.strategy_hash, e.token);
        changes.push(change(
            "PositionBalance",
            &id,
            Operation::Update,
            vec![
                field("position", string_value(&e.strategy_hash)),
                field("token", string_value(&e.token)),
                field("lastUpdatedTimestamp", bigint_from_u64(e.timestamp)),
            ],
        ));
    }

    for e in events.pulled.iter() {
        let id = format!("{}-{}", e.strategy_hash, e.token);
        changes.push(change(
            "PositionBalance",
            &id,
            Operation::Update,
            vec![
                field("position", string_value(&e.strategy_hash)),
                field("token", string_value(&e.token)),
                field("lastUpdatedTimestamp", bigint_from_u64(e.timestamp)),
            ],
        ));
    }

    for e in events.swapped.iter() {
        let id = format!("{}-{}", e.tx_hash, e.log_index);
        changes.push(change(
            "Fill",
            &id,
            Operation::Create,
            vec![
                field("position", string_value(&e.order_hash)),
                field("taker", string_value(&e.taker)),
                field("tokenIn", string_value(&e.token_in)),
                field("tokenOut", string_value(&e.token_out)),
                field("amountIn", bigint_value(&e.amount_in)),
                field("amountOut", bigint_value(&e.amount_out)),
                field("blockNumber", bigint_from_u64(e.block_number)),
                field("timestamp", bigint_from_u64(e.timestamp)),
                field("transactionHash", string_value(&e.tx_hash)),
            ],
        ));
    }

    Ok(EntityChanges {
        entity_changes: changes,
    })
}
