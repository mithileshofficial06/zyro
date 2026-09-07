import {NextResponse} from "next/server";

import {verifyPosition} from "@/lib/lens";
import {fetchConsoleData} from "@/lib/subgraph";
import {loadDeployment} from "@/lib/deployment";

/**
 * Re-runs the index-against-chain comparison for one position, on demand.
 *
 * @dev The page renders a comparison at load. This exists so it can be run
 *      again *while someone is watching* — during a demo the interesting
 *      moment is a fill landing and both sides moving together, and a check
 *      that only ever ran at page load cannot show that.
 *
 *      It refetches the subgraph rather than trusting a position posted by the
 *      client. A client-supplied position would let the browser choose what
 *      the chain is compared against, which makes a green result mean nothing
 *      at all.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({error: "missing ?id=<strategyHash>"}, {status: 400});
  }

  const deployment = loadDeployment();
  if (!deployment?.zyroLens) {
    return NextResponse.json(
      {
        error:
          "no ZyroLens address. Deploy with script/DeployZyroRouter.s.sol, then run node scripts/wire-addresses.mjs"
      },
      {status: 503}
    );
  }

  const data = await fetchConsoleData();
  if (data.error) return NextResponse.json({error: data.error}, {status: 502});
  if (!data.meta) {
    return NextResponse.json({error: "the subgraph reported no indexed block"}, {status: 502});
  }

  const position = data.positions.find((p) => p.id.toLowerCase() === id.toLowerCase());
  if (!position) {
    return NextResponse.json({error: `no indexed position ${id}`}, {status: 404});
  }

  // The block is the position's own `lastUpdatedBlock`, chosen inside
  // `verifyPosition` — not latest, and not the index head either. See the note
  // there: the time-dependent fields are snapshots, and they decay after it.
  const result = await verifyPosition(deployment.zyroLens, position);

  return NextResponse.json(result, {
    status: result.error ? 502 : 200,
    headers: {"cache-control": "no-store"}
  });
}
