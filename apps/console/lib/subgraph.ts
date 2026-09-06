import "server-only";

import type {ConsoleData, Position, Protocol} from "./types";

/**
 * The subgraph client.
 *
 * @dev Server-only, and deliberately so. `SUBGRAPH_URL` for a Studio
 *      deployment can carry an API key in the path, and a `NEXT_PUBLIC_`
 *      variable is compiled into the client bundle where anyone can read it.
 *      The page is a server component and the browser refreshes through
 *      `app/api/data`, so the endpoint never leaves this process.
 */

const POSITION_FIELDS = `
  id
  maker
  app
  active
  tokens
  gammaWad
  sigmaSqWad
  baseSpreadWad
  targetInventoryWad
  boundWad
  horizonSecs
  startTimestamp
  program
  inventoryImbalanceWad
  midWad
  reservationPriceWad
  halfSpreadWad
  penaltyBps
  horizonRemainingSecs
  createdAtBlock
  createdAtTimestamp
  lastUpdatedTimestamp
  balances {
    token
    amount
    lastUpdatedTimestamp
  }
  fills(first: 250, orderBy: timestamp, orderDirection: asc) {
    id
    taker
    tokenIn
    tokenOut
    amountIn
    amountOut
    midWadAtFill
    reservationPriceWadAtFill
    inventoryImbalanceWadAtFill
    exposed
    blockNumber
    timestamp
    transactionHash
  }
`;

/**
 * @dev Fills are ordered ascending by timestamp, not descending. The chart
 *      plots them left to right in the order they happened; fetching the most
 *      recent 250 and reversing would silently drop the *start* of a long
 *      series, which is the balanced end — the half that shows the two lines
 *      sitting on top of each other before they separate.
 */
const CONSOLE_QUERY = `
  query Console {
    _meta {
      block { number }
      hasIndexingErrors
    }
    protocol(id: "0x7a79726f") {
      id
      positionCount
      activePositionCount
      fillCount
    }
    positions(first: 50, orderBy: createdAtBlock, orderDirection: desc) {
      ${POSITION_FIELDS}
    }
  }
`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: {message: string}[];
}

async function request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = process.env.SUBGRAPH_URL;
  if (!url) throw new Error("SUBGRAPH_URL is not set");

  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query, variables}),
    // The index moves; a cached page would show a reservation price from an
    // earlier block beside a live on-chain reading and look like a mismatch.
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`subgraph responded ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("subgraph returned no data");

  return json.data;
}

/**
 * Everything the console renders, in one round trip.
 *
 * Never throws: an unset endpoint and an unreachable one are both states the
 * page has to render, and a thrown error there would replace a working console
 * with a stack trace at exactly the moment someone is watching it.
 */
export async function fetchConsoleData(): Promise<ConsoleData> {
  if (!process.env.SUBGRAPH_URL) {
    return {meta: null, protocol: null, positions: [], error: null, configured: false};
  }

  try {
    const data = await request<{
      _meta: {block: {number: number}; hasIndexingErrors: boolean};
      protocol: Protocol | null;
      positions: Position[];
    }>(CONSOLE_QUERY);

    return {
      meta: {
        block: data._meta.block.number,
        hasIndexingErrors: data._meta.hasIndexingErrors
      },
      protocol: data.protocol,
      positions: data.positions ?? [],
      error: null,
      configured: true
    };
  } catch (error) {
    return {
      meta: null,
      protocol: null,
      positions: [],
      error: error instanceof Error ? error.message : String(error),
      configured: true
    };
  }
}
