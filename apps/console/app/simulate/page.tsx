import type {Metadata} from "next";
import Link from "next/link";

import {BenchmarkSummary} from "@/components/BenchmarkSummary";
import {Field} from "@/components/Field";
import {PageHead, PageNav} from "@/components/PageNav";
import {Receipt} from "@/components/Receipt";
import {PressPanel, Reveal, Stagger, StaggerItem} from "@/components/motion";
import {Section} from "@/components/Section";
import {advantageBps, advantageWad, fillRate, loadBenchmark} from "@/lib/benchmark";
import {formatDuration, formatTokens, formatWad} from "@/lib/format";
import type {Benchmark, BenchmarkScenario} from "@/lib/types";

export const metadata: Metadata = {
  title: "Benchmark · Zyro",
  description:
    "The competitive routing benchmark: an exogenous price, a taker that chooses, and both positions marked at neither one's quote."
};

/**
 * `/simulate` — the benchmark, tick by tick.
 *
 * @dev Every number on this page is read out of
 *      `contracts/test/fixtures/benchmark.json`, which `CompetitiveFlow.t.sol`
 *      writes on every `forge test`. Nothing here is typed, and CI fails on a
 *      diff under `contracts/test/fixtures/`, so nothing here *can* be typed
 *      and survive a commit.
 *
 *      Static, unlike the landing page. The benchmark is a build artifact, not
 *      an index that moves, and forcing it dynamic would re-read the same file
 *      on every request to render the same bytes.
 */
export default function SimulatePage() {
  const benchmark = loadBenchmark();

  return (
    <>
      <PageNav current="simulate" />

      <main className="shell">
        <PageHead
          crumb={<Link href="/">← Console</Link>}
          index="06 / Benchmark"
          title={
            <>
              Skewing costs fills.
              <br />
              Here is the bill.
            </>
          }
          lede={
            <>
              The previous version of this benchmark reported a PnL advantage that was{" "}
              <strong>arithmetically guaranteed before it ran</strong>: identical flow into
              both positions, Zyro paying out strictly less by construction, and both marked
              at the stock position&apos;s own mid.{" "}
              <span className="dim">
                This one fixes all three, and one of its four scenarios comes out against
                Zyro.
              </span>
            </>
          }
        />

        {benchmark ? <Results benchmark={benchmark} /> : <MissingFixture />}
      </main>
    </>
  );
}

function Results({benchmark}: {benchmark: Benchmark}) {
  const {config, scenarios} = benchmark;

  return (
    <>
      <Section
        index="01 / Corrections"
        title="What makes this one mean anything"
        lede="Three properties, each of which the previous benchmark lacked, and each of which can make Zyro lose."
      >
        <Stagger className="grid grid--3">
          {CORRECTIONS.map((c) => (
            <StaggerItem key={c.n}>
              <PressPanel className="step">
                <span className="step__n">{c.n}</span>
                <h3 className="step__title">{c.title}</h3>
                <p className="step__body">{c.body}</p>
              </PressPanel>
            </StaggerItem>
          ))}
        </Stagger>

        <Reveal delay={0.2} style={{marginTop: 24}}>
          <ConfigPanel benchmark={benchmark} />
        </Reveal>
      </Section>

      <Section
        index="02 / Results"
        title="Four scenarios"
        lede={
          <>
            Value is the position marked at the <strong>final exogenous price</strong> —
            never at its own quote.{" "}
            <span className="dim">
              Fill rate is printed beside it deliberately: a position that wins on value by
              refusing to trade has not succeeded, and that is a claim you can only check if
              both numbers are on the same row.
            </span>
          </>
        }
      >
        <Reveal>
          <SummaryTable scenarios={scenarios} />
        </Reveal>

        <Reveal delay={0.1} style={{marginTop: 24}}>
          <Falsification scenarios={scenarios} />
        </Reveal>
      </Section>

      <Section
        index="03 / Receipt"
        title="Every tick"
        lede={
          <>
            The summary is four numbers. This is the {scenarios.reduce((n, s) => n + s.ticks, 0)}{" "}
            decisions they came from, including the ones where Zyro was outbid and lost the
            flow.
          </>
        }
      >
        <Reveal>
          <Receipt scenarios={scenarios} config={config} />
        </Reveal>
      </Section>
    </>
  );
}

const CORRECTIONS = [
  {
    n: "01",
    title: "The price path is exogenous",
    body: (
      <>
        A declared constant, not something the measured flow pushes around. If the
        simulation&apos;s own trades move the price it is measuring against, it is grading
        its own homework.
      </>
    )
  },
  {
    n: "02",
    title: "The taker chooses",
    body: (
      <>
        It quotes <strong>both</strong> positions, routes to whichever pays more, and
        declines if neither clears its tolerance. Zyro can therefore lose fills — which is
        the entire cost side of the trade-off, and was previously unmodelled.
      </>
    )
  },
  {
    n: "03",
    title: "Both marked at the same price",
    body: (
      <>
        At the exogenous price, never at either position&apos;s quote. Marking Zyro at the
        stock curve&apos;s mid credits it for a price it never offered anyone.
      </>
    )
  }
];

function ConfigPanel({benchmark}: {benchmark: Benchmark}) {
  const {config} = benchmark;

  return (
    <div className="grid grid--2">
      <section className="panel">
        <div className="panel__head">
          <h2>The venue</h2>
        </div>
        <Field label="starting inventory" value={formatTokens(config.startInventoryWad, 0)} />
        <Field label="starting quote asset" value={formatTokens(config.startQuoteWad, 0)} />
        <Field label="tick size" value={formatTokens(config.tickSizeWad, 0)} />
        <Field label="seconds per tick" value={`${config.tickSeconds}s`} />
        <Field label="ticks per price leg" value={String(config.ticksPerLeg)} />
        <Field label="taker tolerance" value={`${config.takerToleranceBps} bps`} />

        <p className="dim" style={{fontSize: "0.74rem", marginBottom: 0, marginTop: 14}}>
          Depth matters more than it looks. A trade worth 2% of the pool costs ~2% in
          constant-product slippage, which swamps a spread measured in basis points — the
          first configuration of this benchmark used a 1,000-token pool with 20-token fills
          and the taker declined 28 of 40 ticks on slippage alone, before the skew entered
          into it. The tick here is 0.2% of depth.
        </p>
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2>The Zyro position</h2>
        </div>
        <Field label="target inventory" value={formatTokens(config.targetInventoryWad, 0)} />
        <Field label="soft bound" value={formatTokens(config.boundWad, 0)} />
        <Field label="gamma" value={formatWad(config.gammaWad, 8)} />
        <Field label="sigma²" value={formatWad(config.sigmaSqWad, 8)} />
        <Field label="base spread" value={formatWad(config.baseSpreadWad, 6)} />
        <Field label="horizon" value={formatDuration(String(config.horizonSecs))} />

        <p className="dim" style={{fontSize: "0.74rem", marginBottom: 0, marginTop: 14}}>
          Calibrated for <em>this</em> pool. The skew is{" "}
          <span className="mono">q · γ · σ² · (T−t)</span>, so with a 2,000-token drift over
          an hour these values put it at roughly 50 bps of a mid of 1 — large enough to
          change a routing decision, small enough that Zyro is not simply priced out of the
          market.
        </p>
      </section>
    </div>
  );
}

function SummaryTable({scenarios}: {scenarios: BenchmarkScenario[]}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Results</h2>
        <span className="label" style={{display: "inline"}}>
          marked at the exogenous price
        </span>
      </div>

      <BenchmarkSummary scenarios={scenarios} footnote={false} />

      <p className="dim" style={{margin: "16px 0 0", maxWidth: "76ch", fontSize: "0.78rem"}}>
        <strong>Drift</strong> is the furthest either position got from its starting
        inventory. <strong>Near bound</strong> counts ticks spent within 20% of the soft
        bound, stock&nbsp;/&nbsp;Zyro. It is the risk measure that matters most, and the one
        a PnL column cannot show: a position can end a scenario level and have spent half of
        it one bad fill from its own limit.
      </p>
    </section>
  );
}

/**
 * The losing scenario, given its own panel.
 *
 * @dev Found from the data rather than hard-coded to D. If a parameter change
 *      makes a different scenario the loser — or makes all four win — a
 *      hard-coded panel would keep asserting a falsification that no longer
 *      happened, which is a worse failure than having no panel at all.
 */
function Falsification({scenarios}: {scenarios: BenchmarkScenario[]}) {
  const losing = scenarios.filter((s) => advantageWad(s) < 0n);

  if (losing.length === 0) {
    return (
      <div className="panel panel--flat">
        <span className="label">No losing scenario</span>
        <p style={{margin: "10px 0 0", maxWidth: "76ch"}}>
          Every scenario in this run came out ahead. That is a weaker result than it looks:
          a mechanism that only ever wins in its own benchmark has not been tested against
          the case that would falsify it. The whipsaw path exists to produce a loss, and if
          it stopped producing one the parameters should be examined before the claim is
          strengthened.
        </p>
      </div>
    );
  }

  return (
    <div className="panel panel--maroon">
      <span className="label" style={{color: "var(--white)"}}>
        {losing.map((s) => s.label).join(", ")} falsifies the simple version
      </span>
      <p style={{margin: "10px 0 0", maxWidth: "76ch"}}>
        <strong>Zyro loses here, and that is the correct result to report.</strong> The
        whipsaw ends <em>above</em> where it started. The stock curve accumulated the asset;
        Zyro&apos;s skew held it back — and when the price recovers past the entry level,
        having accumulated more of that asset is a win. Zyro bought less of something that
        ultimately appreciated, and paid{" "}
        {losing.map((s) => formatTokens(-advantageWad(s), 1)).join(", ")} units for the
        privilege.
      </p>
      <p style={{margin: "12px 0 0", maxWidth: "76ch"}}>
        That is not a bug — it is what the mechanism <em>is</em>. Zyro is insurance against a
        trend continuing. It pays out when the move persists and costs a premium when the
        move reverses. A maker whose market mean-reverts more often than it trends should
        expect to lose money running this, and should not run it.
      </p>
    </div>
  );
}

function MissingFixture() {
  return (
    <Reveal>
      <section className="panel" style={{marginTop: 40}}>
        <div className="panel__head">
          <h2>No benchmark fixture</h2>
        </div>
        <p style={{marginTop: 0, maxWidth: "70ch"}}>
          This page renders{" "}
          <span className="mono">contracts/test/fixtures/benchmark.json</span>, and there is
          no such file. It is written by the benchmark itself, so generating it is a test
          run:
        </p>
        <p className="mono dim" style={{fontSize: "0.8rem", margin: 0}}>
          cd contracts &amp;&amp; forge test --match-test test_WriteBenchmarkFixture
        </p>
        <p className="dim" style={{maxWidth: "70ch", marginBottom: 0}}>
          There is no fallback copy on purpose. A page that falls back to bundled numbers
          when the generated ones are missing is a page that can show stale results without
          saying so — and the build spec&apos;s rule for this one is that every number is
          generated.
        </p>
      </section>
    </Reveal>
  );
}
