import {Address, BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";
import {newMockEvent} from "matchstick-as";

import {Docked, Pulled, Pushed, Shipped} from "../../generated/Aqua/Aqua";
import {Swapped} from "../../generated/ZyroRouter/ZyroRouter";

/**
 * Mock-event builders.
 *
 * @dev Every parameter on Aqua's events is **non-indexed**, so they all go into
 *      `event.parameters` in declaration order. Building these by hand is the
 *      only way to be sure the handlers read the fields they think they do.
 */

/** Matches `src/config.ts` — the handlers filter on this. */
export const ZYRO_APP: Address = Address.fromString(
  "0x0000000000000000000000000000000000000000"
);

export const MAKER: Address = Address.fromString("0x00000000000000000000000000000000000000a1");
export const TAKER: Address = Address.fromString("0x00000000000000000000000000000000000000b2");
export const TOKEN_IN: Address = Address.fromString("0x00000000000000000000000000000000000000c3");
export const TOKEN_OUT: Address = Address.fromString("0x00000000000000000000000000000000000000d4");

function base<T>(): T {
  let event = changetype<T>(newMockEvent());
  return event;
}

export function createShipped(
  app: Address,
  strategyHash: Bytes,
  strategy: Bytes,
  timestamp: BigInt
): Shipped {
  let event = changetype<Shipped>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(MAKER)));
  event.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(app)));
  event.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(strategyHash))
  );
  event.parameters.push(new ethereum.EventParam("strategy", ethereum.Value.fromBytes(strategy)));
  event.block.timestamp = timestamp;
  event.block.number = BigInt.fromI32(1000);
  return event;
}

export function createPushed(
  app: Address,
  strategyHash: Bytes,
  token: Address,
  amount: BigInt,
  timestamp: BigInt
): Pushed {
  let event = changetype<Pushed>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(MAKER)));
  event.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(app)));
  event.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(strategyHash))
  );
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  );
  event.block.timestamp = timestamp;
  return event;
}

export function createPulled(
  app: Address,
  strategyHash: Bytes,
  token: Address,
  amount: BigInt,
  timestamp: BigInt
): Pulled {
  let event = changetype<Pulled>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(MAKER)));
  event.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(app)));
  event.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(strategyHash))
  );
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  );
  event.block.timestamp = timestamp;
  return event;
}

export function createDocked(app: Address, strategyHash: Bytes, timestamp: BigInt): Docked {
  let event = changetype<Docked>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(MAKER)));
  event.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(app)));
  event.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(strategyHash))
  );
  event.block.timestamp = timestamp;
  return event;
}

export function createSwapped(
  orderHash: Bytes,
  amountIn: BigInt,
  amountOut: BigInt,
  timestamp: BigInt
): Swapped {
  let event = changetype<Swapped>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("orderHash", ethereum.Value.fromFixedBytes(orderHash))
  );
  event.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(MAKER)));
  event.parameters.push(new ethereum.EventParam("taker", ethereum.Value.fromAddress(TAKER)));
  event.parameters.push(new ethereum.EventParam("tokenIn", ethereum.Value.fromAddress(TOKEN_IN)));
  event.parameters.push(
    new ethereum.EventParam("tokenOut", ethereum.Value.fromAddress(TOKEN_OUT))
  );
  event.parameters.push(
    new ethereum.EventParam("amountIn", ethereum.Value.fromUnsignedBigInt(amountIn))
  );
  event.parameters.push(
    new ethereum.EventParam("amountOut", ethereum.Value.fromUnsignedBigInt(amountOut))
  );
  event.block.timestamp = timestamp;
  event.block.number = BigInt.fromI32(1001);
  return event;
}
