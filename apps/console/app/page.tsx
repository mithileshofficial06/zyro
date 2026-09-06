import {InventoryTrack, PriceSeries} from "@/components/PriceSeries";
import {Field, Stat} from "@/components/Stat";
import {VerifyPanel} from "@/components/VerifyPanel";
import {loadDeployment} from "@/lib/deployment";
import {
  formatBps,
  formatDuration,
  formatSigned,
  formatTokens,
  formatWad,
  shortHex,
  spreadBps
} from "@/lib/format";
import {verifyPosition} from "@/lib/lens";
import {fetchConsoleData} from "@/lib/subgraph";
import type {Position} from "@/lib/types";

/**
 * The console.
 *
 * A server component, refetched on every request. Nothing here is cached: the
 * page's whole claim is that these numbers match the chain right now, and a
 * cached reservation price beside a live `eth_call` would look like a
 * mismatch that is really a stale render.
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  const [data, deployment] = await Promise.all([
    fetchConsoleData(),
    Promise.resolve(loadDeployment())
  ]);

  const position = data.positions[0] ?? null;

  // Verified on the server so the panel has an answer before any client
  // JavaScript runs — the check is the point of the page, and it should not
  // depend on hydration to appear.
  const verification =
    position && deployment?.zyroLens && data.meta
      ? await verifyPosition(deployment.zyroLens, position, data.meta.block)
      : null;

  return (
    <main className="shell">
      <Masthead
        block={data.meta?.block ?? null}
        hasErrors={data.meta?.hasIndexingErrors ?? false}
        network={deployment?.network ?? null}
        configured={data.configured}
      />

      {!data.configured ? <SetupNotice /> : null}
      {data.error ? <ErrorNotice message={data.error} /> : null}

      <div className="stack" style={{marginTop: 32}}>
        <ProtocolStats
          positions={data.protocol?.positionCount ?? String(data.positions.length)}
          active={data.protocol?.activePositionCount ?? "0"}
          fills={data.protocol?.fillCount ?? "0"}
          position={position}
        />

        {position ? (
          <>
            <HeadlineChart position={position} />
            <div className="grid grid--2">
              <PositionDetail position={position} />
              <VerifyPanel positionId={position.id} initial={verification} />
            </div>
            <FillsTable position={position} />
            {data.positions.length > 1 ? (
              <PositionsTable positions={data.positions} />
            ) : null}
          </>
        ) : data.configured && !data.error ? (
          <EmptyIndex />
        ) : null}

        <Deployment deployment={deployment} />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Masthead({
  block,
  hasErrors,
  network,
  configured
}: {
  block: number | null;
  hasErrors: boolean;
  network: string | null;
  configured: boolean;
}) {
  return (
    <header style={{paddingTop: 56}}>
      <div className="row" style={{gap: 10, marginBottom: 18}}>
        <span className={block !== null ? "tag tag--live" : "tag tag--idle"}>
          {block !== null ? "indexing" : configured ? "unreachable" : "not configured"}
        </span>
        {network ? <span className="tag tag--idle">{network}</span> : null}
        {block !== null ? (
          <span className="tag tag--idle num">block {block.toLocaleString()}</span>
        ) : null}
        {hasErrors ? (
          <span className="tag" style={{color: "var(--maroon-lit)"}}>
            indexing errors
          </span>
        ) : null}
      </div>

      <h1>
        ZYRO<span style={{color: "var(--maroon-lit)"}}>.</span>
      </h1>

      <p
        style={{
          maxWidth: "62ch",
          marginTop: 18,
          fontSize: "1.02rem",
          borderLeft: "4px solid var(--maroon)",
          paddingLeft: 16
        }}
      >
        Inventory-aware dynamic liquidity as a native 1inch SwapVM instruction. Every
        shipped position publishes the reservation price it is actually quoting at, so a
        solver can route on it without re-implementing Avellaneda–Stoikov — and this page
        checks that price against the chain, field for field.
      </p>
    </header>
  );
}

function SetupNotice() {
  return (
    <section className="panel" style={{marginTop: 32}}>
      <div className="panel__head">
        <h2>Not configured</h2>
      </div>
      <p style={{marginTop: 0}}>
        Set <span className="mono">SUBGRAPH_URL</span> and{" "}
        <span className="mono">BASE_SEPOLIA_RPC_URL</span>, then restart. The console
        reads both server-side; neither reaches the browser.
      </p>
      <ol className="mono dim" style={{fontSize: "0.8rem", lineHeight: 1.9, paddingLeft: 20}}>
        <li>forge script script/DeployZyroRouter.s.sol --broadcast</li>
        <li>forge script script/SwapSeries.s.sol --broadcast --slow</li>
        <li>node scripts/wire-addresses.mjs</li>
        <li>cd subgraph &amp;&amp; npm run codegen &amp;&amp; npx graph deploy --studio zyro</li>
        <li>cp .env.example .env.local, then fill it in</li>
      </ol>
    </section>
  );
}

function ErrorNotice({message}: {message: string}) {
  return (
    <section className="panel" style={{marginTop: 32, borderColor: "var(--maroon-lit)"}}>
      <div className="panel__head">
        <h2 style={{color: "var(--maroon-lit)"}}>Subgraph unreachable</h2>
      </div>
      <p className="mono" style={{margin: 0, fontSize: "0.82rem"}}>
        {message}
      </p>
    </section>
  );
}

function EmptyIndex() {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Nothing indexed</h2>
      </div>
      <p style={{marginTop: 0, maxWidth: "66ch"}}>
        The subgraph is reachable and has indexed no positions. Both silent failure
        modes look exactly like this, so check them in order:
      </p>
      <ul style={{maxWidth: "66ch", lineHeight: 1.7}}>
        <li>
          <strong>The app filter.</strong> <span className="mono">ZYRO_APP</span> in{" "}
          <span className="mono">subgraph/src/config.ts</span> must be the deployed
          router. A stale value does not error — every event fails the filter and the
          subgraph syncs to chainhead having stored nothing.
        </li>
        <li>
          <strong>The program decode.</strong> If{" "}
          <span className="mono">decodeStrategy</span> finds no Zyro instruction, the
          position is skipped as legitimately not ours. Same symptom, different cause.
        </li>
        <li>
          <strong>Nothing shipped yet.</strong> Run{" "}
          <span className="mono">script/SwapSeries.s.sol</span>.
        </li>
      </ul>
    </section>
  );
}

function ProtocolStats({
  positions,
  active,
  fills,
  position
}: {
  positions: string;
  active: string;
  fills: string;
  position: Position | null;
}) {
  const separation = position ? spreadBps(position.midWad, position.reservationPriceWad) : null;

  return (
    <section className="grid grid--4">
      <Stat label="Positions" value={positions} hint={`${active} still shipped`} />
      <Stat label="Fills" value={fills} hint="settled on-chain" />
      <Stat
        label="Mid"
        value={position ? formatWad(position.midWad, 6) : "—"}
        hint="implied by the current balance pair"
      />
      <Stat
        label="Reservation price"
        value={position ? formatWad(position.reservationPriceWad, 6) : "—"}
        accent
        hint={
          separation === null
            ? undefined
            : `${separation >= 0 ? "+" : ""}${separation.toFixed(2)} bps from the mid`
        }
      />
    </section>
  );
}

function HeadlineChart({position}: {position: Position}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Mid vs reservation price</h2>
        <span className="label" style={{display: "inline"}}>
          {position.fills.length} fills
        </span>
      </div>

      <p className="dim" style={{margin: "0 0 18px", maxWidth: "72ch", fontSize: "0.84rem"}}>
        The two lines start together while the position sits at its inventory target, and
        separate as it takes on one side. A pool AMM cannot draw the maroon line at all:
        it has one price, and no notion of whose inventory is behind it. The y-axis is
        zoomed to the data — the full separation here is a fraction of a percent, and it
        would be invisible against a domain starting at zero.
      </p>

      <PriceSeries
        fills={position.fills}
        currentMidWad={position.midWad}
        currentReservationWad={position.reservationPriceWad}
      />
      <InventoryTrack fills={position.fills} />
    </section>
  );
}

function PositionDetail({position}: {position: Position}) {
  const [tokenIn, tokenOut] = position.tokens;
  const balance = (token?: string) =>
    token
      ? (position.balances.find((b) => b.token.toLowerCase() === token.toLowerCase())?.amount ??
        "0")
      : "0";

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Position</h2>
        <span className={position.active ? "tag tag--live" : "tag tag--idle"}>
          {position.active ? "shipped" : "docked"}
        </span>
      </div>

      <Field
        label="strategy hash"
        value={<span title={position.id}>{shortHex(position.id, 12, 8)}</span>}
        title={position.id}
      />
      <Field label="maker" value={shortHex(position.maker, 10, 6)} title={position.maker} />
      <Field
        label="inventory q"
        value={
          <span className="maroon-text">{formatSigned(position.inventoryImbalanceWad)}</span>
        }
        title={position.inventoryImbalanceWad}
      />
      <Field label="target" value={formatTokens(position.targetInventoryWad)} />
      <Field label="soft bound" value={formatTokens(position.boundWad)} />
      <Field label="penalty" value={formatBps(position.penaltyBps)} />
      <Field label="half spread" value={formatWad(position.halfSpreadWad, 6)} />
      <Field
        label="horizon left"
        value={formatDuration(position.horizonRemainingSecs)}
        title={`${position.horizonSecs}s total`}
      />
      <Field label={`balance ${shortHex(tokenIn ?? "0x", 4, 3)}`} value={formatTokens(balance(tokenIn))} />
      <Field
        label={`balance ${shortHex(tokenOut ?? "0x", 4, 3)}`}
        value={formatTokens(balance(tokenOut))}
      />

      <p className="dim" style={{fontSize: "0.72rem", marginBottom: 0, marginTop: 14}}>
        Balances are reconstructed from Aqua&apos;s <span className="mono">Pushed</span>/
        <span className="mono">Pulled</span> ledger, never accumulated from swap deltas —
        the latter measures flow rather than holdings, and makes every derived price
        wrong.
      </p>
    </section>
  );
}

function FillsTable({position}: {position: Position}) {
  const fills = [...position.fills].reverse();

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Fills</h2>
        <span className="label" style={{display: "inline"}}>
          newest first
        </span>
      </div>

      {fills.length === 0 ? (
        <p className="dim" style={{margin: 0}}>
          No fills yet.
        </p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Block</th>
                <th className="num">Amount in</th>
                <th className="num">Amount out</th>
                <th className="num">Mid at fill</th>
                <th className="num">Reservation</th>
                <th className="num">Δ bps</th>
                <th className="num">q at fill</th>
                <th>Side</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((fill) => {
                const delta = spreadBps(fill.midWadAtFill, fill.reservationPriceWadAtFill);
                return (
                  <tr key={fill.id}>
                    <td className="dim">{fill.blockNumber}</td>
                    <td className="num">{formatTokens(fill.amountIn)}</td>
                    <td className="num">{formatTokens(fill.amountOut)}</td>
                    <td className="num">{formatWad(fill.midWadAtFill, 6)}</td>
                    <td className="num maroon-text">
                      {formatWad(fill.reservationPriceWadAtFill, 6)}
                    </td>
                    <td className="num">
                      {delta >= 0 ? "+" : ""}
                      {delta.toFixed(2)}
                    </td>
                    <td className="num">{formatSigned(fill.inventoryImbalanceWadAtFill)}</td>
                    <td>
                      <span className={fill.exposed ? "tag tag--live" : "tag tag--idle"}>
                        {fill.exposed ? "exposed" : "covered"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="dim" style={{fontSize: "0.72rem", marginBottom: 0, marginTop: 14}}>
        Mid and reservation price are the state <em>before</em> each fill settled.
        Aqua emits <span className="mono">Pushed</span>/<span className="mono">Pulled</span>{" "}
        during settlement and <span className="mono">Swapped</span> after it, so these are
        reconstructed by undoing the fill&apos;s own deltas — reading the store directly
        would file the post-fill mid under a pre-fill name.
      </p>
    </section>
  );
}

function PositionsTable({positions}: {positions: Position[]}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>All positions</h2>
        <span className="label" style={{display: "inline"}}>
          {positions.length}
        </span>
      </div>

      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Strategy hash</th>
              <th>Maker</th>
              <th className="num">Mid</th>
              <th className="num">Reservation</th>
              <th className="num">Δ bps</th>
              <th className="num">q</th>
              <th className="num">Fills</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const delta = spreadBps(p.midWad, p.reservationPriceWad);
              return (
                <tr key={p.id}>
                  <td title={p.id}>{shortHex(p.id, 10, 6)}</td>
                  <td className="dim" title={p.maker}>
                    {shortHex(p.maker, 6, 4)}
                  </td>
                  <td className="num">{formatWad(p.midWad, 6)}</td>
                  <td className="num maroon-text">{formatWad(p.reservationPriceWad, 6)}</td>
                  <td className="num">
                    {delta >= 0 ? "+" : ""}
                    {delta.toFixed(2)}
                  </td>
                  <td className="num">{formatSigned(p.inventoryImbalanceWad)}</td>
                  <td className="num">{p.fills.length}</td>
                  <td>
                    <span className={p.active ? "tag tag--live" : "tag tag--idle"}>
                      {p.active ? "shipped" : "docked"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Deployment({deployment}: {deployment: ReturnType<typeof loadDeployment>}) {
  return (
    <section className="panel panel--flat">
      <div className="panel__head">
        <h2>Deployment</h2>
      </div>

      {deployment ? (
        <>
          <Field label="network" value={`${deployment.network} · ${deployment.chainId}`} />
          <Field label="aqua" value={deployment.aqua} title={deployment.aqua} />
          <Field label="zyro router" value={deployment.zyroRouter} title={deployment.zyroRouter} />
          <Field
            label="zyro lens"
            value={deployment.zyroLens ?? "not deployed"}
            title={deployment.zyroLens ?? undefined}
          />
          <Field label="start block" value={deployment.startBlock.toLocaleString()} />
        </>
      ) : (
        <p className="dim" style={{margin: 0}}>
          No <span className="mono">deployments/&lt;network&gt;.json</span>. Run{" "}
          <span className="mono">node scripts/wire-addresses.mjs</span> after deploying.
        </p>
      )}

      <p className="dim" style={{fontSize: "0.72rem", marginTop: 16, marginBottom: 0}}>
        Read from the same generated record the subgraph&apos;s{" "}
        <span className="mono">networks.json</span> and{" "}
        <span className="mono">src/config.ts</span> come from. Duplicating the router
        address into an env var reintroduces the drift that generation exists to remove.
      </p>
    </section>
  );
}
