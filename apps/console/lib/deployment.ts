import "server-only";

import {readFileSync, existsSync} from "node:fs";
import {join} from "node:path";

import type {Deployment} from "./types";

/**
 * The deployment record `scripts/wire-addresses.mjs` writes.
 *
 * @dev Read from the repository rather than from environment variables,
 *      because it is the *same* file the subgraph's `networks.json` and
 *      `src/config.ts` were generated from. Duplicating the router address
 *      into a `.env` reintroduces the exact drift that script exists to
 *      remove — and a console pointed at a different router than the subgraph
 *      indexes would show every field disagreeing and blame the mappings.
 *
 *      Environment variables still win when set, so a hosted deployment that
 *      cannot ship the repo file has a way in.
 */
export function loadDeployment(network = process.env.ZYRO_NETWORK ?? "base-sepolia"): Deployment | null {
  const fromEnv = envDeployment(network);
  if (fromEnv) return fromEnv;

  // Resolved from the process cwd, which for `next dev`/`next build` is
  // apps/console. Two levels up is the repository root.
  const path = join(process.cwd(), "..", "..", "deployments", `${network}.json`);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as Deployment;
  } catch {
    return null;
  }
}

function envDeployment(network: string): Deployment | null {
  const router = process.env.ZYRO_ROUTER;
  const lens = process.env.ZYRO_LENS;
  const aqua = process.env.AQUA;
  if (!router || !aqua) return null;

  return {
    network,
    chainId: Number(process.env.ZYRO_CHAIN_ID ?? 84532),
    aqua: aqua.toLowerCase(),
    zyroRouter: router.toLowerCase(),
    zyroLens: lens ? lens.toLowerCase() : null,
    startBlock: Number(process.env.ZYRO_START_BLOCK ?? 0),
    deployedAt: null
  };
}
