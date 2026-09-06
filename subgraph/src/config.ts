import {Address} from "@graphprotocol/graph-ts";

/**
 * The Zyro router's address, as an Aqua "app".
 *
 * Aqua's `Shipped`, `Pushed`, `Pulled` and `Docked` fire for **every** app built
 * on Aqua, not just this one. Every handler filters on this address; without it
 * the subgraph would try to decode unrelated protocols' strategies as Zyro
 * programs and publish nonsense for them.
 *
 * `graph build --network <name>` substitutes contract addresses in
 * `subgraph.yaml` from `networks.json`, but it cannot substitute a constant in
 * mapping code — so this is set here per deployment. Keep it in step with the
 * `ZyroRouter` data source's address in `networks.json`.
 */
export const ZYRO_APP: Address = Address.fromString(
  "0x0000000000000000000000000000000000000000"
);
