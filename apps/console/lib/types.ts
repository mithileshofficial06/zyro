/**
 * The shapes the console reads.
 *
 * @dev Every integer arrives from GraphQL as a decimal **string**, and stays a
 *      string until something needs to do arithmetic on it. Typing these as
 *      `number` would be the single most damaging thing possible here: a WAD
 *      price is ~2e18, which is past `Number.MAX_SAFE_INTEGER`, so a JSON
 *      round-trip through a `number` loses the low digits — exactly the digits
 *      that separate a reservation price from the mid it is being compared to.
 */

export interface PositionBalance {
  token: string;
  amount: string;
  lastUpdatedTimestamp: string;
}

export interface Fill {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  midWadAtFill: string;
  reservationPriceWadAtFill: string;
  inventoryImbalanceWadAtFill: string;
  exposed: boolean;
  blockNumber: string;
  timestamp: string;
  transactionHash: string;
}

export interface Position {
  id: string;
  maker: string;
  app: string;
  active: boolean;
  tokens: string[];

  gammaWad: string;
  sigmaSqWad: string;
  baseSpreadWad: string;
  targetInventoryWad: string;
  boundWad: string;
  horizonSecs: string;
  startTimestamp: string;
  program: string;

  inventoryImbalanceWad: string;
  midWad: string;
  reservationPriceWad: string;
  halfSpreadWad: string;
  penaltyBps: string;
  horizonRemainingSecs: string;

  createdAtBlock: string;
  createdAtTimestamp: string;
  lastUpdatedTimestamp: string;

  balances: PositionBalance[];
  fills: Fill[];
}

export interface Protocol {
  id: string;
  positionCount: string;
  activePositionCount: string;
  fillCount: string;
}

export interface IndexMeta {
  block: number;
  hasIndexingErrors: boolean;
}

export interface ConsoleData {
  meta: IndexMeta | null;
  protocol: Protocol | null;
  positions: Position[];
  /** Non-null when the console could not reach a configured subgraph. */
  error: string | null;
  /** False when SUBGRAPH_URL is unset, which is a setup state, not a failure. */
  configured: boolean;
}

/** `ZyroLens.State`, decoded. The field names match `schema.graphql`. */
export interface LensState {
  balanceIn: string;
  balanceOut: string;
  inventoryImbalanceWad: string;
  midWad: string;
  reservationPriceWad: string;
  halfSpreadWad: string;
  penaltyBps: string;
  horizonRemainingSecs: string;
  elapsedSecs: string;
}

/** One field, as the index has it and as the chain has it. */
export interface Comparison {
  field: string;
  indexed: string;
  onChain: string;
  agrees: boolean;
}

export interface VerificationResult {
  ok: boolean;
  /** The block both sides were read at. Comparing across blocks is a clock. */
  block: number;
  comparisons: Comparison[];
  error: string | null;
}

export interface Deployment {
  network: string;
  chainId: number;
  aqua: string;
  zyroRouter: string;
  zyroLens: string | null;
  startBlock: number;
  deployedAt: string | null;
}
