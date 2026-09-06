import {Hero} from "@/components/Hero";
import {Nav} from "@/components/Nav";
import {CountUp, Marquee, PressPanel, Reveal, Stagger, StaggerItem} from "@/components/motion";
import {InventoryTrack, PriceSeries} from "@/components/PriceSeries";
import {Section} from "@/components/Section";
import {SkewTrack} from "@/components/SkewTrack";
import {Field} from "@/components/Field";
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
 * cached reservation price beside a live `eth_call` would look like a mismatch
 * that is really a stale render.
 *
 * @dev Structured as an argument rather than a dashboard. Each section is one
 *      step — the claim, the mechanism, the live series, the proof — because a
 *      wall of equally-weighted panels makes a reader skim and skimming is
 *      fatal to a page whose entire point is a number being correct.
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
    <>
      <Nav />

      <Hero
        block={data.meta?.block ?? null}
        network={deployment?.network ?? null}
        configured={data.configured}
        hasErrors={data.meta?.hasIndexingErrors ?? false}
      />

      <main className="shell">
        {!data.configured ? <SetupNotice /> : null}
        {data.error ? <ErrorNotice message={data.error} /> : null}

        <Mechanism />

        <Section
          id="live"
          index="02 / Live"
          title={
            <>
              The price
              <br />
              no pool can quote
            </>
          }
          lede={
            <>
              Two lines that sit exactly on top of each other while the position is at its
              inventory target, and separate as it takes on one side.{" "}
              <span className="dim">
                The y-axis is zoomed to the data — the separation is a fraction of a
                percent, and against a domain starting at zero it would be invisible.
              </span>
            </>
          }
        >
          <ProtocolStats
            positions={data.protocol?.positionCount ?? String(data.positions.length)}
            active={data.protocol?.activePositionCount ?? "0"}
            fills={data.protocol?.fillCount ?? "0"}
            position={position}
          />

          {position ? (
            <Reveal delay={0.1} style={{marginTop: 24}}>
              <HeadlineChart position={position} />
            </Reveal>
          ) : data.configured && !data.error ? (
            <EmptyIndex />
          ) : null}
        </Section>

        {position ? (
          <>
            <Section
              id="proof"
              index="03 / Proof"
              title="Correct, not just live"
              lede={
                <>
                  &ldquo;Live and indexing&rdquo; shows on any subgraph&apos;s status page.
                  Whether it returns <em>correct</em> data is not something a subgraph can
                  demonstrate about itself — it needs a second opinion computed somewhere
                  else.{" "}
                  <span className="dim">
                    So the right-hand column is the chain: <span className="mono">ZyroLens</span>{" "}
                    reading <span className="mono">AQUA.safeBalances</span> and running the
                    same Solidity library the instruction prices with.
                  </span>
                </>
              }
            >
              <div className="grid grid--2">
                <Reveal>
                  <PositionDetail position={position} />
                </Reveal>
                <Reveal delay={0.08}>
                  <VerifyPanel positionId={position.id} initial={verification} />
                </Reveal>
              </div>
            </Section>

            <Section
              id="fills"
              index="04 / Settlement"
              title="Every fill, on-chain"
              lede={
                <>
                  Each row settled on Base Sepolia, and each quoted before it swapped with
                  the two required to match.{" "}
                  <span className="dim">
                    Mid and reservation price are the state <em>before</em> the fill —
                    reconstructed by undoing its own deltas, because Aqua emits{" "}
                    <span className="mono">Pushed</span>/<span className="mono">Pulled</span>{" "}
                    during settlement and <span className="mono">Swapped</span> after it.
                  </span>
                </>
              }
            >
              <Reveal>
                <FillsTable position={position} />
              </Reveal>

              {data.positions.length > 1 ? (
                <Reveal style={{marginTop: 24}}>
                  <PositionsTable positions={data.positions} />
                </Reveal>
              ) : null}
            </Section>
          </>
        ) : null}

        <Section
          id="stack"
          index="05 / Stack"
          title="What is running"
          lede="Three independent implementations of the same kernel, and a way to make them disagree out loud."
        >
          <Stack deployment={deployment} />
        </Section>

        <Footer deployment={deployment} />
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// 01 — the mechanism
// ---------------------------------------------------------------------------

const STEPS = [
  {
    n: "01",
    title: "The maker keeps their tokens",
    body: (
      <>
        Shipping a position to Aqua moves <strong>nothing</strong>. It writes a number
        into a ledger 1inch themselves comment as <em>makers&apos; allowances</em>. Tokens
        stay in the maker&apos;s own wallet until a swap settles, then move maker ↔ taker
        directly.
      </>
    )
  },
  {
    n: "02",
    title: "So there is a q",
    body: (
      <>
        Because every position has a named owner with a declared target,{" "}
        <strong>q = balance − target</strong> exists. A pool AMM&apos;s inventory belongs
        to everybody, so there is no individual to be away from a target, and no q to
        price against.
      </>
    )
  },
  {
    n: "03",
    title: "SwapVM pre-loads the balance",
    body: (
      <>
        <strong>Before any instruction runs</strong>, the VM populates the execution
        context from <span className="mono">AQUA.safeBalances</span>. The number
        Avellaneda–Stoikov needs is already in a register.
      </>
    )
  },
  {
    n: "04",
    title: "One instruction re-centres the curve",
    body: (
      <>
        <strong>Opcode 34</strong>, appended to the stock Aqua table by copying it
        positionally. Every program the real 1inch SDK emits still runs byte-identically —
        proved against a real <span className="mono">AquaSwapVMRouter</span>, not asserted.
      </>
    )
  }
];

function Mechanism() {
  return (
    <Section
      id="mechanism"
      index="01 / Mechanism"
      title={
        <>
          Known since 2008.
          <br />
          Impossible on-chain until now.
        </>
      }
      lede={
        <>
          A market maker earns spread on every fill and can still lose money, because
          one-directional flow forces them to accumulate an asset that is falling. The fix
          is to quote around your <strong>reservation price</strong> — where you, given
          what you hold, are indifferent to trading — instead of the market mid.{" "}
          <span className="dim">
            It required an input no on-chain venue exposed. Aqua exposes it.
          </span>
        </>
      }
    >
      <Stagger className="grid grid--4" gap={0.09}>
        {STEPS.map((step) => (
          <StaggerItem key={step.n}>
            <PressPanel className="step">
              <span className="step__n">{step.n}</span>
              <h3 className="step__title">{step.title}</h3>
              <p className="step__body">{step.body}</p>
            </PressPanel>
          </StaggerItem>
        ))}
      </Stagger>

      <Reveal delay={0.2} style={{marginTop: 24}}>
        <div className="panel panel--maroon">
          <span className="label" style={{color: "var(--white)"}}>
            What is not claimed
          </span>
          <p style={{margin: "10px 0 0", maxWidth: "72ch"}}>
            Not that inventory-aware market making was invented here. It has been standard
            on professional desks since Avellaneda &amp; Stoikov published it. The claim is
            that it required an input no on-chain venue exposed, that 1inch Aqua exposes
            it, and that this is the implementation — running as a native instruction
            inside 1inch&apos;s own execution engine.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 02 — live
// ---------------------------------------------------------------------------

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
    <Stagger className="grid grid--4">
      <StaggerItem>
        <BigStat label="Positions" value={positions} hint={`${active} still shipped`} count />
      </StaggerItem>
      <StaggerItem>
        <BigStat label="Fills" value={fills} hint="settled on-chain" count />
      </StaggerItem>
      <StaggerItem>
        <BigStat
          label="Mid"
          value={position ? formatWad(position.midWad, 6) : "—"}
          hint="implied by the current balance pair"
        />
      </StaggerItem>
      <StaggerItem>
        <BigStat
          label="Reservation price"
          value={position ? formatWad(position.reservationPriceWad, 6) : "—"}
          accent
          hint={
            separation === null
              ? "no position indexed"
              : `${separation >= 0 ? "+" : ""}${separation.toFixed(2)} bps from the mid`
          }
        />
      </StaggerItem>
    </Stagger>
  );
}

/**
 * @dev `count` is opt-in, and off for prices. `CountUp` refuses anything past
 *      `MAX_SAFE_INTEGER` anyway, but a six-decimal price rolling up to its
 *      final value reads as a live ticker rather than a settled quote — which
 *      is the opposite of what this page is asserting.
 */
function BigStat({
  label,
  value,
  hint,
  accent = false,
  count = false
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  count?: boolean;
}) {
  return (
    <PressPanel className={accent ? "panel panel--maroon" : "panel"} style={{height: "100%"}}>
      <span className="label">{label}</span>
      <div
        className="num"
        style={{
          fontSize: "clamp(1.6rem, 3.2vw, 2.4rem)",
          fontWeight: 700,
          marginTop: 8,
          overflowWrap: "anywhere",
          color: accent ? "var(--white-pure)" : "var(--white)"
        }}
      >
        {count ? <CountUp value={value} /> : value}
      </div>
      {hint ? (
        <div className="dim" style={{fontSize: "0.7rem", marginTop: 8, lineHeight: 1.4}}>
          {hint}
        </div>
      ) : null}
    </PressPanel>
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

      <PriceSeries
        fills={position.fills}
        currentMidWad={position.midWad}
        currentReservationWad={position.reservationPriceWad}
      />

      {/* The price chart buries its own signal: the mid falls steeply across a
          one-direction series, and the separation is a small residual on a
          large trend. These two tracks are that residual, and the inventory it
          is a response to, plotted where they are the whole series. */}
      <SkewTrack
        fills={position.fills}
        currentMidWad={position.midWad}
        currentReservationWad={position.reservationPriceWad}
      />
      <InventoryTrack fills={position.fills} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// 03 — proof
// ---------------------------------------------------------------------------

function PositionDetail({position}: {position: Position}) {
  const [tokenIn, tokenOut] = position.tokens;
  const balance = (token?: string) =>
    token
      ? (position.balances.find((b) => b.token.toLowerCase() === token.toLowerCase())?.amount ??
        "0")
      : "0";

  return (
    <section className="panel" style={{height: "100%"}}>
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
        value={<span className="maroon-text">{formatSigned(position.inventoryImbalanceWad)}</span>}
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
      <Field
        label={`balance ${shortHex(tokenIn ?? "0x", 4, 3)}`}
        value={formatTokens(balance(tokenIn))}
      />
      <Field
        label={`balance ${shortHex(tokenOut ?? "0x", 4, 3)}`}
        value={formatTokens(balance(tokenOut))}
      />

      <p className="dim" style={{fontSize: "0.72rem", marginBottom: 0, marginTop: 14}}>
        Balances are reconstructed from Aqua&apos;s <span className="mono">Pushed</span>/
        <span className="mono">Pulled</span> ledger, never accumulated from swap deltas —
        the latter measures flow rather than holdings, and makes every derived price wrong.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 04 — settlement
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 05 — stack
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS = [
  {
    name: "AvellanedaStoikov.sol",
    role: "Prices real swaps",
    detail: "The instruction. 95 Foundry tests, including exhaustive quote/swap parity fuzzing."
  },
  {
    name: "packages/strategy-sdk",
    role: "The TypeScript port",
    detail: "Encoders byte-verified against Solidity-generated fixtures. 125 tests."
  },
  {
    name: "subgraph/src",
    role: "The AssemblyScript port",
    detail: "Publishes the index. Decoder checked against a real abi.encode(order)."
  }
];

function Stack({deployment}: {deployment: ReturnType<typeof loadDeployment>}) {
  return (
    <>
      <Stagger className="grid grid--3">
        {IMPLEMENTATIONS.map((impl) => (
          <StaggerItem key={impl.name}>
            <PressPanel className="step">
              <span className="label" style={{color: "var(--maroon-lit)"}}>
                {impl.role}
              </span>
              <h3 className="step__title mono" style={{textTransform: "none"}}>
                {impl.name}
              </h3>
              <p className="step__body">{impl.detail}</p>
            </PressPanel>
          </StaggerItem>
        ))}
      </Stagger>

      <Reveal delay={0.15} style={{marginTop: 24}}>
        <div className="panel panel--flat">
          <div className="panel__head">
            <h2>Deployment</h2>
          </div>

          {deployment ? (
            <>
              <Field label="network" value={`${deployment.network} · ${deployment.chainId}`} />
              <Field label="aqua" value={deployment.aqua} title={deployment.aqua} />
              <Field
                label="zyro router"
                value={deployment.zyroRouter}
                title={deployment.zyroRouter}
              />
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
        </div>
      </Reveal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notices and footer
// ---------------------------------------------------------------------------

function SetupNotice() {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 56}}>
        <div className="panel__head">
          <h2>Not configured</h2>
        </div>
        <p style={{marginTop: 0}}>
          Set <span className="mono">SUBGRAPH_URL</span> and{" "}
          <span className="mono">BASE_SEPOLIA_RPC_URL</span>, then restart. Both are read
          server-side; neither reaches the browser.
        </p>
        <ol className="mono dim" style={{fontSize: "0.8rem", lineHeight: 1.9, paddingLeft: 20}}>
          <li>forge script script/DeployZyroRouter.s.sol --broadcast</li>
          <li>forge script script/SwapSeries.s.sol --broadcast --slow</li>
          <li>node scripts/wire-addresses.mjs</li>
          <li>cd subgraph &amp;&amp; npm run codegen &amp;&amp; npx graph deploy zyro</li>
          <li>cp .env.example .env.local, then fill it in</li>
        </ol>
      </section>
    </Reveal>
  );
}

function ErrorNotice({message}: {message: string}) {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 56, borderColor: "var(--maroon-lit)"}}>
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

function EmptyIndex() {
  return (
    <Reveal style={{marginTop: 24}}>
      <section className="panel">
        <div className="panel__head">
          <h2>Nothing indexed</h2>
        </div>
        <p style={{marginTop: 0, maxWidth: "66ch"}}>
          The subgraph is reachable and has indexed no positions. Both silent failure modes
          look exactly like this, so check them in order:
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
    </Reveal>
  );
}

function Footer({deployment}: {deployment: ReturnType<typeof loadDeployment>}) {
  return (
    <footer className="footer">
      <div className="footer__grid">
        <div>
          <h2 style={{fontSize: "clamp(1.6rem, 4vw, 2.6rem)"}}>
            ZYRO<span style={{color: "var(--maroon-lit)"}}>.</span>
          </h2>
          <p className="dim" style={{maxWidth: "44ch", fontSize: "0.86rem"}}>
            ETHOnline 2026. Inventory-aware dynamic liquidity as a native 1inch SwapVM
            instruction.
          </p>
        </div>

        <div>
          <span className="label">Tracks</span>
          <ul className="footer__list dim">
            <li>1inch — SwapVM / Aqua</li>
            <li>The Graph — subgraph + MCP</li>
            <li>Uniswap — v4 hook</li>
          </ul>
        </div>

        <div>
          <span className="label">Repository</span>
          <ul className="footer__list">
            <li>
              <a href="https://github.com/mithileshofficial06/zyro" target="_blank" rel="noreferrer">
                github ↗
              </a>
            </li>
            <li className="dim">{deployment?.network ?? "not deployed"}</li>
          </ul>
        </div>
      </div>

      <div style={{marginTop: 40, borderTop: "2px solid var(--line)", background: "var(--maroon)"}}>
        <Marquee items={["ZYRO", "RESERVATION PRICE", "q = BALANCE − TARGET", "OPCODE 34"]} reverse />
      </div>
    </footer>
  );
}
