import type {Metadata} from "next";
import Link from "next/link";
import {notFound} from "next/navigation";

import {Field} from "@/components/Field";
import {Gauge} from "@/components/Gauge";
import {PageHead, PageNav} from "@/components/PageNav";
import {InventoryTrack, PriceSeries} from "@/components/PriceSeries";
import {Section} from "@/components/Section";
import {SkewTrack} from "@/components/SkewTrack";
import {VerifyPanel} from "@/components/VerifyPanel";
import {Reveal} from "@/components/motion";
import {loadDeployment} from "@/lib/deployment";
import {
  formatBlock,
  formatBps,
  formatDuration,
  formatSigned,
  formatTimestamp,
  formatTokens,
  formatWad,
  shortHex,
  spreadBps
} from "@/lib/format";
import {verifyPosition} from "@/lib/lens";
import {fetchPosition} from "@/lib/subgraph";
import type {Position} from "@/lib/types";

/**
 * A strategy hash is a `bytes32`. Anything else cannot be a position, and
 * asking the subgraph about it wastes a round trip to be told so.
 */
const HASH = /^0x[0-9a-fA-F]{64}$/;

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  params: Promise<{hash: string}>;
}): Promise<Metadata> {
  const {hash} = await params;
  return {
    title: `${shortHex(hash, 10, 6)} · Zyro`,
    description: "One position's live reservation price, its inventory against the soft bound, and the chain's own answer beside it."
  };
}

/**
 * `/position/[hash]` — one position, live.
 *
 * @dev `force-dynamic`, like the landing page and for the same reason: the
 *      whole claim is that these numbers match the chain *now*, and a cached
 *      reservation price rendered beside a live `eth_call` looks exactly like
 *      a mismatch that is really a stale page.
 */
export default async function PositionPage({params}: {params: Promise<{hash: string}>}) {
  const {hash} = await params;

  // A malformed hash is a 404 — there is no such resource and no diagnosis to
  // offer. A well-formed hash that is simply not indexed is a different thing
  // entirely, and gets a panel rather than a 404, because it is one of the two
  // silent failure modes this console exists to make visible.
  if (!HASH.test(hash)) notFound();

  const [data, deployment] = await Promise.all([
    fetchPosition(hash),
    Promise.resolve(loadDeployment())
  ]);

  const position = data.position;

  const verification =
    position && deployment?.zyroLens && data.meta
      ? await verifyPosition(deployment.zyroLens, position)
      : null;

  return (
    <>
      <PageNav current="position" />

      <main className="shell">
        <PageHead
          crumb={
            <>
              <Link href="/">← Console</Link> <span style={{opacity: 0.4}}>/</span> position
            </>
          }
          index={data.meta ? `Block ${formatBlock(data.meta.block)}` : "Not indexed"}
          title={
            <span className="mono" style={{fontSize: "0.42em", lineHeight: 1.3}}>
              {hash}
            </span>
          }
          lede={
            position ? (
              <>
                Shipped by <span className="mono">{shortHex(position.maker, 10, 6)}</span>,{" "}
                {position.fills.length} fill{position.fills.length === 1 ? "" : "s"} settled.{" "}
                <span className="dim">
                  Everything below is what the subgraph published, checked field for field
                  against what <span className="mono">ZyroLens</span> returns from the chain
                  at the block the index has reached.
                </span>
              </>
            ) : undefined
          }
        />

        {!data.configured ? <NotConfigured /> : null}
        {data.error ? <Unreachable message={data.error} /> : null}
        {data.configured && !data.error && !position ? <NotIndexed hash={hash} /> : null}

        {position ? (
          <>
            <Section
              index="01 / Inventory"
              title="Where it is, and where it wants to be"
              lede={
                <>
                  <strong>q = balance − target</strong>, and the soft bound is the distance
                  past which the penalty starts to bite.{" "}
                  <span className="dim">
                    This is the input a pool AMM cannot supply. Its inventory belongs to
                    everybody, so there is no individual to be away from a target.
                  </span>
                </>
              }
            >
              <Reveal>
                <section className="panel">
                  <div className="panel__head">
                    <h2>Inventory against the soft bound</h2>
                    <span className={position.active ? "tag tag--live" : "tag tag--idle"}>
                      {position.active ? "shipped" : "docked"}
                    </span>
                  </div>

                  <Gauge
                    q={position.inventoryImbalanceWad}
                    bound={position.boundWad}
                    penaltyBps={position.penaltyBps}
                  />

                  <div className="grid grid--3" style={{marginTop: 28}}>
                    <Quantity
                      label="Mid"
                      value={formatWad(position.midWad, 8)}
                      hint="implied by the current balance pair"
                    />
                    <Quantity
                      label="Reservation price"
                      value={formatWad(position.reservationPriceWad, 8)}
                      hint={`${separation(position)} from the mid`}
                      accent
                    />
                    <Quantity
                      label="Horizon left"
                      value={formatDuration(position.horizonRemainingSecs)}
                      hint={
                        BigInt(position.horizonRemainingSecs) === 0n
                          ? "expired — every time-dependent term is zero"
                          : `of ${formatDuration(position.horizonSecs)}`
                      }
                    />
                  </div>

                  {BigInt(position.horizonRemainingSecs) === 0n ? (
                    <p
                      style={{
                        margin: "20px 0 0",
                        maxWidth: "72ch",
                        color: "var(--fail)",
                        fontSize: "0.85rem"
                      }}
                    >
                      <strong>The horizon has expired.</strong> Every time-dependent term has
                      vanished and this position is now an ordinary constant-product curve
                      with a flat spread. It does not revert, warn, or stop trading — it has
                      stopped defending itself, and the gauge above will keep drifting.
                    </p>
                  ) : null}
                </section>
              </Reveal>
            </Section>

            <Section
              index="02 / Series"
              title="Mid vs reservation price"
              lede={
                <>
                  Two lines that sit on top of each other while the position is at its
                  target, and separate as it takes on one side.{" "}
                  <span className="dim">
                    The y-axis is zoomed to the data — the separation is a fraction of a
                    percent, and against a domain starting at zero it would be invisible.
                  </span>
                </>
              }
            >
              <Reveal>
                <section className="panel">
                  <div className="panel__head">
                    <h2>Across {position.fills.length} fills</h2>
                  </div>

                  {position.fills.length === 0 ? (
                    <p className="dim" style={{margin: 0}}>
                      Nothing has traded against this position yet, so there is no series —
                      only the current state above.
                    </p>
                  ) : (
                    <>
                      <PriceSeries
                        fills={position.fills}
                        currentMidWad={position.midWad}
                        currentReservationWad={position.reservationPriceWad}
                      />
                      <SkewTrack
                        fills={position.fills}
                        currentMidWad={position.midWad}
                        currentReservationWad={position.reservationPriceWad}
                      />
                      <InventoryTrack fills={position.fills} />
                    </>
                  )}
                </section>
              </Reveal>
            </Section>

            <Section
              index="03 / Proof"
              title="Correct, not just live"
              lede={
                <>
                  The parameters on the left are what the mappings decoded out of the
                  program bytes. The panel on the right recomputes the state from{" "}
                  <span className="mono">AQUA.safeBalances</span> through the same Solidity
                  library the instruction prices with.
                </>
              }
            >
              <div className="grid grid--2">
                <Reveal>
                  <Parameters position={position} />
                </Reveal>
                <Reveal delay={0.08}>
                  <VerifyPanel positionId={position.id} initial={verification} />
                </Reveal>
              </div>
            </Section>

            <Section
              index="04 / Settlement"
              title="Every fill"
              lede={
                <>
                  Mid and reservation price are the state <em>before</em> each fill —
                  reconstructed by undoing its own deltas, because Aqua emits{" "}
                  <span className="mono">Pushed</span>/<span className="mono">Pulled</span>{" "}
                  during settlement and <span className="mono">Swapped</span> after it.
                </>
              }
            >
              <Reveal>
                <Fills position={position} />
              </Reveal>
            </Section>
          </>
        ) : null}
      </main>
    </>
  );
}

function separation(position: Position): string {
  const bps = spreadBps(position.midWad, position.reservationPriceWad);
  return `${bps >= 0 ? "+" : ""}${bps.toFixed(2)} bps`;
}

function Quantity({
  label,
  value,
  hint,
  accent = false
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "panel panel--maroon" : "panel panel--flat"}>
      <span className="label">{label}</span>
      <div
        className="num"
        style={{
          fontSize: "clamp(1.2rem, 2.4vw, 1.7rem)",
          fontWeight: 700,
          marginTop: 8,
          overflowWrap: "anywhere",
          color: accent ? "var(--white-pure)" : "var(--white)"
        }}
      >
        {value}
      </div>
      <div className="dim" style={{fontSize: "0.7rem", marginTop: 8, lineHeight: 1.4}}>
        {hint}
      </div>
    </div>
  );
}

function Parameters({position}: {position: Position}) {
  const [tokenIn, tokenOut] = position.tokens;
  const balance = (token?: string) =>
    token
      ? (position.balances.find((b) => b.token.toLowerCase() === token.toLowerCase())?.amount ??
        "0")
      : "0";

  return (
    <section className="panel" style={{height: "100%"}}>
      <div className="panel__head">
        <h2>Program</h2>
        <span className="label" style={{display: "inline"}}>
          opcode 34
        </span>
      </div>

      <Field label="maker" value={shortHex(position.maker, 10, 6)} title={position.maker} />
      <Field label="app" value={shortHex(position.app, 10, 6)} title={position.app} />
      <Field label="gamma" value={formatWad(position.gammaWad, 8)} />
      <Field label="sigma²" value={formatWad(position.sigmaSqWad, 8)} />
      <Field label="base spread" value={formatWad(position.baseSpreadWad, 6)} />
      <Field label="target inventory" value={formatTokens(position.targetInventoryWad)} />
      <Field label="soft bound" value={formatTokens(position.boundWad)} />
      <Field label="penalty" value={formatBps(position.penaltyBps)} />
      <Field label="half spread" value={formatWad(position.halfSpreadWad, 8)} />
      <Field
        label="horizon"
        value={formatDuration(position.horizonSecs)}
        title={`${position.horizonSecs}s`}
      />
      <Field label="started" value={formatTimestamp(position.startTimestamp)} />
      <Field
        label={`balance ${shortHex(tokenIn ?? "0x", 4, 3)}`}
        value={formatTokens(balance(tokenIn))}
        title={tokenIn}
      />
      <Field
        label={`balance ${shortHex(tokenOut ?? "0x", 4, 3)}`}
        value={formatTokens(balance(tokenOut))}
        title={tokenOut}
      />
      <Field
        label="shipped at block"
        value={formatBlock(position.createdAtBlock)}
        title={formatTimestamp(position.createdAtTimestamp)}
      />

      <p className="dim" style={{fontSize: "0.72rem", marginBottom: 0, marginTop: 14}}>
        These are decoded from the program bytes carried in the order, not from any
        off-chain record. <span className="mono">targetInventoryWad</span> configures one
        direction: the instruction computes{" "}
        <span className="mono">q = balanceIn − target</span>, and{" "}
        <span className="mono">balanceIn</span> is whichever token the taker is giving — so
        a position quoting both ways would need a target per side.
      </p>
    </section>
  );
}

function Fills({position}: {position: Position}) {
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
                <th>Time</th>
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
                    <td className="dim" title={fill.transactionHash}>
                      {fill.blockNumber}
                    </td>
                    <td className="dim" style={{fontSize: "0.74rem"}}>
                      {formatTimestamp(fill.timestamp)}
                    </td>
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// The three states that are not a position
// ---------------------------------------------------------------------------

function NotConfigured() {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 40}}>
        <div className="panel__head">
          <h2>Not configured</h2>
        </div>
        <p style={{marginTop: 0, maxWidth: "70ch"}}>
          <span className="mono">SUBGRAPH_URL</span> is unset, so there is nothing to look
          this hash up in. See <span className="mono">docs/RUNBOOK.md</span>, or run the
          mock:
        </p>
        <p className="mono dim" style={{fontSize: "0.8rem", margin: 0}}>
          node scripts/mock-subgraph.mjs
        </p>
      </section>
    </Reveal>
  );
}

function Unreachable({message}: {message: string}) {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 40, borderColor: "var(--maroon-lit)"}}>
        <div className="panel__head">
          <h2 style={{color: "var(--maroon-lit)"}}>Subgraph unreachable</h2>
        </div>
        <p className="mono" style={{margin: 0, fontSize: "0.82rem"}}>
          {message}
        </p>
      </section>
    </Reveal>
  );
}

/**
 * @dev Not a 404. The hash is well-formed, the subgraph answered, and it has
 *      nothing under that id — which is a diagnosable state with three distinct
 *      causes, and the whole reason this console exists is that all three look
 *      identical from a status page. A 404 would throw that away and tell the
 *      reader they typed the URL wrong.
 */
function NotIndexed({hash}: {hash: string}) {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 40}}>
        <div className="panel__head">
          <h2>Not indexed</h2>
          <span className="tag tag--idle">no such position</span>
        </div>
        <p style={{marginTop: 0, maxWidth: "70ch"}}>
          The subgraph is reachable and has no position under{" "}
          <span className="mono">{shortHex(hash, 12, 8)}</span>. That has three causes, and
          they are indistinguishable from here — check them in this order:
        </p>
        <ul style={{maxWidth: "70ch", lineHeight: 1.7}}>
          <li>
            <strong>The app filter.</strong> <span className="mono">ZYRO_APP</span> in{" "}
            <span className="mono">subgraph/src/config.ts</span> must be the deployed
            router. A stale value does not error — every event fails the filter and the
            subgraph syncs to chainhead having stored nothing at all.
          </li>
          <li>
            <strong>The program decode.</strong> If{" "}
            <span className="mono">decodeStrategy</span> finds no Zyro instruction, the
            position is skipped as legitimately not ours. Same symptom, different cause, and
            a legitimate one for any other app on Aqua.
          </li>
          <li>
            <strong>The hash.</strong> It is the <em>strategy</em> hash — the order hash the
            router returns — not the transaction that shipped it.
          </li>
        </ul>
        <p style={{marginBottom: 0}}>
          <Link href="/">← every indexed position</Link>
        </p>
      </section>
    </Reveal>
  );
}
