/**
 * Checks the order, hash and Aqua-calldata builders against the chain.
 *
 * Three things are re-implemented here that cannot be got wrong: the
 * `MakerTraits` bit packing, `abi.encode` of the order tuple, and `keccak256`
 * over it. Each fails the same way — a plausible wrong value, no error, and a
 * position that either cannot be found by `safeBalances` or cannot be docked.
 *
 * The expectations come from `contracts/test/OrderFixtures.t.sol`, which builds
 * the order with the real on-chain `MakerTraitsLib` and takes the hash from the
 * router's own `hash()`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildOrder,
  encodeOrder,
  orderHash,
  programStartByte,
  MakerTraitsBits,
} from "../src/order.ts";
import {
  Selectors,
  buildDockTx,
  buildShipZyroStrategyTx,
  calculateStrategyHash,
  encodeDockCalldata,
  encodeShipCalldata,
} from "../src/aqua.ts";
import { keccak256 } from "../src/keccak.ts";
import { buildZyroProgram, encodeSalt } from "../src/instructions.ts";
import type { Hex } from "../src/bytes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../../contracts/test/fixtures/order.json");

interface OrderFixture {
  maker: string;
  salt: string;
  startTimestamp: number;
  program: string;
  traits: string;
  strategy: string;
  strategyHash: string;
  orderHash: string;
  app: string;
  aqua: string;
  tokens: string[];
  amounts: string[];
  shipCalldata: string;
  dockCalldata: string;
}

const f: OrderFixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

// The same position the Solidity fixture builds.
const STRATEGY = {
  gammaWad: 10n ** 14n,
  sigmaSqWad: 5n * 10n ** 13n,
  baseSpreadWad: 10n ** 15n,
  targetInventoryWad: 1000n * 10n ** 18n,
  boundWad: 500n * 10n ** 18n,
  horizonSecs: 3600,
  startTimestamp: f.startTimestamp,
};

describe("keccak256 matches the EVM", () => {
  // Known-answer tests first: if these fail, nothing downstream means anything.
  test("the empty input", () => {
    assert.equal(
      keccak256("0x"),
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  test("the canonical 'abc'", () => {
    assert.equal(
      keccak256("0x616263"),
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  test("an input spanning more than one 136-byte block", () => {
    // 200 bytes forces a second absorb round, which is where a padding or
    // rate mistake first shows up.
    const input = ("0x" + "ab".repeat(200)) as Hex;
    const digest = keccak256(input);
    assert.match(digest, /^0x[0-9a-f]{64}$/);
    assert.notEqual(digest, keccak256("0x"));
  });

  test("hashes the real encoded order to the value the chain computed", () => {
    assert.equal(keccak256(f.strategy), f.strategyHash);
  });

  test("rejects malformed hex rather than hashing garbage", () => {
    assert.throws(() => keccak256("0xabc"), /odd number of digits/);
    assert.throws(() => keccak256("0xzz"), /not hex/);
  });
});

describe("order construction matches MakerTraitsLib", () => {
  const order = buildOrder({
    maker: f.maker,
    program: f.program as Hex,
  });

  test("traits pack identically", () => {
    assert.equal(order.traits, BigInt(f.traits));
  });

  test("the Aqua flag is bit 254", () => {
    assert.equal((order.traits >> MakerTraitsBits.USE_AQUA_INSTEAD_OF_SIGNATURE) & 1n, 1n);
    assert.equal((order.traits >> MakerTraitsBits.SHOULD_UNWRAP) & 1n, 0n);
    assert.equal((order.traits >> MakerTraitsBits.ALLOW_ZERO_AMOUNT_IN) & 1n, 0n);
  });

  test("an unset receiver stays zero rather than being filled with the maker", () => {
    // A receiver equal to the maker is a *custom* receiver and changes the
    // hash, so writing one in would silently orphan the position.
    assert.equal(order.traits & ((1n << 160n) - 1n), 0n);
  });

  test("with no hooks the program starts at byte 0", () => {
    assert.equal(programStartByte(order.traits), 0);
    assert.equal(order.data, f.program);
  });

  test("abi.encode of the order matches byte for byte", () => {
    assert.equal(encodeOrder(order), f.strategy);
  });

  test("the order hash matches the router's", () => {
    assert.equal(orderHash(order), f.orderHash);
    assert.equal(orderHash(order), f.strategyHash, "strategy hash and order hash are one number");
  });

  test("hashing a signature-mode order is refused, not silently wrong", () => {
    const signed = buildOrder({
      maker: f.maker,
      program: f.program as Hex,
      useAquaInsteadOfSignature: false,
    });
    assert.throws(() => orderHash(signed), /EIP-712/);
  });
});

describe("Aqua calldata matches abi.encodeCall", () => {
  test("selectors are derived correctly", () => {
    assert.equal(Selectors.ship, f.shipCalldata.slice(0, 10));
    assert.equal(Selectors.dock, f.dockCalldata.slice(0, 10));
  });

  test("ship calldata matches byte for byte", () => {
    const calldata = encodeShipCalldata(
      f.app,
      f.strategy as Hex,
      f.tokens.map((token, i) => ({ token, amount: BigInt(f.amounts[i]!) })),
    );
    assert.equal(calldata, f.shipCalldata);
  });

  test("dock calldata matches byte for byte", () => {
    assert.equal(encodeDockCalldata(f.app, f.strategyHash as Hex, f.tokens), f.dockCalldata);
  });

  test("calculateStrategyHash agrees with the chain", () => {
    assert.equal(calculateStrategyHash(f.strategy as Hex), f.strategyHash);
  });
});

describe("buildShipZyroStrategyTx", () => {
  const result = buildShipZyroStrategyTx({
    aqua: f.aqua,
    app: f.app,
    maker: f.maker,
    strategy: STRATEGY,
    salt: f.salt as Hex,
    funding: f.tokens.map((token, i) => ({ token, amount: BigInt(f.amounts[i]!) })),
  });

  test("reproduces the program the Solidity fixture shipped", () => {
    assert.equal(result.program, f.program);
    assert.equal(
      result.program,
      buildZyroProgram(STRATEGY, f.salt as Hex),
      "the program must be skew ++ curve ++ salt",
    );
  });

  test("reproduces the strategy blob and its hash", () => {
    assert.equal(result.strategy, f.strategy);
    assert.equal(result.strategyHash, f.strategyHash);
  });

  test("produces the same ship transaction", () => {
    assert.equal(result.tx.to, f.aqua.toLowerCase());
    assert.equal(result.tx.data, f.shipCalldata);
    assert.equal(result.tx.value, 0n);
  });

  test("the strategy hash is available before the transaction is sent", () => {
    // It is fully determined by the bytes, which is what lets a caller seed a
    // subgraph query or prepare a dock without waiting for the receipt.
    assert.match(result.strategyHash, /^0x[0-9a-f]{64}$/);
  });

  test("changing only the salt changes the strategy hash", () => {
    const other = buildShipZyroStrategyTx({
      aqua: f.aqua,
      app: f.app,
      maker: f.maker,
      strategy: STRATEGY,
      salt: "0x0000000000000001",
      funding: [],
    });
    assert.notEqual(other.strategyHash, result.strategyHash);
  });

  test("the salt instruction is what makes identical parameters distinct", () => {
    assert.equal(encodeSalt("0x0000000000000001"), "0x14080000000000000001");
  });
});

describe("buildDockTx", () => {
  test("targets Aqua with the dock calldata", () => {
    const tx = buildDockTx(f.aqua, f.app, f.strategyHash as Hex, f.tokens);
    assert.equal(tx.to, f.aqua.toLowerCase());
    assert.equal(tx.data, f.dockCalldata);
    assert.equal(tx.value, 0n);
  });
});
