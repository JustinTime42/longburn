import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { replaySegment, type SimEvent } from "./event-log.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { AuthoritativeSimLoop } from "./loop.js";
import { advanceMarket, centeredIrwinHall12, MARKET_NOISE_DRAW_COUNT, MARKET_NOISE_UPPER_EXCLUSIVE, marketInitialState, marketUpdateNumeratorBound, nextMarketPrice, reduceMarketEvent, replayMarketEvents, TIER0_MARKET_CONFIG, type MarketConfig, type MarketEvent, type MarketState } from "./market.js";
import { deriveStream } from "./rng.js";

const marketEvents = (seed: number, steps: number, config: MarketConfig = TIER0_MARKET_CONFIG) => {
  const rng = deriveStream(seed, `market:${config.commodityId}`);
  let state = marketInitialState(config);
  const events: MarketEvent[] = [];
  for (let index = 0; index < steps; index += 1) {
    const step = advanceMarket(config, state, rng);
    for (const event of step) {
      events.push(event);
      state = reduceMarketEvent(config, state, event);
    }
  }
  return { events, state };
};

describe("deterministic market process", () => {
  it("reproduces the same price series from a recorded world seed", () => {
    const first = marketEvents(0x1234_5678, 500);
    const second = marketEvents(0x1234_5678, 500);
    expect(first.events).toEqual(second.events);
    expect(first.state).toEqual(second.state);
  });

  it("pins fixed-seed mean reversion and clamp walls", () => {
    const events = marketEvents(0x1234_5678, 500).events;
    const quotes = events.filter((event): event is Extract<SimEvent, { type: "marketQuoteUpdated" }> => event.type === "marketQuoteUpdated");
    expect(quotes.at(-1)?.price).toBe(916);
    expect(quotes.some(({ price }) => price === TIER0_MARKET_CONFIG.minimumPrice)).toBe(false);
    expect(quotes.some(({ price }) => price === TIER0_MARKET_CONFIG.maximumPrice)).toBe(false);
  });

  it("centers Irwin-Hall endpoints and keeps a 500-draw window within five sigma", () => {
    const endpointRng = (draw: number) => ({ nextInt: (upperExclusive: number) => {
      expect(upperExclusive).toBe(MARKET_NOISE_UPPER_EXCLUSIVE);
      return draw;
    } });
    const endpoint = MARKET_NOISE_DRAW_COUNT / 2 * (MARKET_NOISE_UPPER_EXCLUSIVE - 1);
    expect(centeredIrwinHall12(endpointRng(0))).toBe(-endpoint);
    expect(centeredIrwinHall12(endpointRng(MARKET_NOISE_UPPER_EXCLUSIVE - 1))).toBe(endpoint);

    const draws = 500;
    const noise = deriveStream(0x1234_5678, "market:noise-centering");
    const total = Array.from({ length: draws }, () => centeredIrwinHall12(noise))
      .reduce((sum, value) => sum + value, 0);
    const windowSigma = Math.sqrt(draws * (MARKET_NOISE_UPPER_EXCLUSIVE ** 2 - 1));
    expect(Math.abs(total)).toBeLessThanOrEqual(5 * windowSigma);
  });

  it("pulls an extreme price toward the mean and takes both clamp branches", () => {
    expect(nextMarketPrice(TIER0_MARKET_CONFIG, 4_000, 0)).toBeLessThan(4_000);
    const floorConfig = { ...TIER0_MARKET_CONFIG, noiseCoefficient: 100_000_000 };
    expect(nextMarketPrice(floorConfig, TIER0_MARKET_CONFIG.meanPrice, -MARKET_NOISE_DRAW_COUNT / 2 * (2 ** 16 - 1))).toBe(TIER0_MARKET_CONFIG.minimumPrice);
    expect(nextMarketPrice(floorConfig, TIER0_MARKET_CONFIG.meanPrice, MARKET_NOISE_DRAW_COUNT / 2 * (2 ** 16 - 1))).toBe(TIER0_MARKET_CONFIG.maximumPrice);
  });

  it("replays persisted market facts without re-running the stochastic process", () => {
    const { events, state } = marketEvents(99, 50);
    expect(replayMarketEvents(TIER0_MARKET_CONFIG, events)).toEqual(state);
    expect(replaySegment(99, events)).toMatchObject({ market: state });
  });

  it("continues the identical market price series after resume", async () => {
    const continuousStore = new InMemorySimulationEventStore();
    const resumedStore = new InMemorySimulationEventStore();
    const options = (store: InMemorySimulationEventStore, id: string) => ({
      store, stream: { id, seed: 99, initialTime: simTimeMs(0) },
      marketPositionAt: (_body: "earth" | "moon" | "mars", time: number) => ({ x: time, y: 2, z: 3 })
    });
    const firstSteps = 17;
    const secondSteps = 23;
    const continuous = await AuthoritativeSimLoop.create(options(continuousStore, "market-continuous"));
    await continuous.advance(firstSteps * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));
    await continuous.advance(secondSteps * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));

    const interrupted = await AuthoritativeSimLoop.create(options(resumedStore, "market-resumed"));
    await interrupted.advance(firstSteps * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));
    const resumed = await AuthoritativeSimLoop.resume(resumedStore, "market-resumed", {
      marketPositionAt: (_body, time) => ({ x: time, y: 2, z: 3 })
    });
    await resumed.advance(secondSteps * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));

    const prices = async (loop: AuthoritativeSimLoop) => (await loop.persistedStream()).events
      .flatMap(({ event }) => event.type === "marketQuoteUpdated" ? [event.price] : []);
    expect(await prices(resumed)).toEqual(await prices(continuous));
    expect(resumed.state.market).toEqual(continuous.state.market);
  });

  it("persists hourly quotes at the market host position", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "market-cadence", seed: 99, initialTime: simTimeMs(0) },
      marketPositionAt: (_body, time) => ({ x: time, y: 2, z: 3 })
    });
    await loop.advance(2 * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));
    const persisted = await loop.persistedStream();
    const quotes = persisted.events.filter(({ event }) => event.type === "marketQuoteUpdated");
    expect(quotes).toHaveLength(2);
    expect(quotes.map(({ eventTime, eventPosition }) => [eventTime, eventPosition])).toEqual([
      [TIER0_MARKET_CONFIG.marketStepMs, { x: TIER0_MARKET_CONFIG.marketStepMs, y: 2, z: 3 }],
      [2 * TIER0_MARKET_CONFIG.marketStepMs, { x: 2 * TIER0_MARKET_CONFIG.marketStepMs, y: 2, z: 3 }]
    ]);
  });

  it("fails closed if a non-market loop is later resumed with the live market resolver", async () => {
    const store = new InMemorySimulationEventStore();
    const disabled = await AuthoritativeSimLoop.create({
      store, stream: { id: "market-resolver-wedge", seed: 99, initialTime: simTimeMs(0) }
    });
    await disabled.advance(2 * TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));
    const resumed = await AuthoritativeSimLoop.resume(store, "market-resolver-wedge", {
      marketPositionAt: () => ({ x: 0, y: 0, z: 0 })
    });

    await expect(resumed.advance(1, () => ({ x: 0, y: 0, z: 0 }))).rejects.toThrow("Market boundary is behind the authoritative simulation time.");
  });

  it("emits threshold-crossing surge and crash events, then re-arms once", () => {
    const atThreshold = (meanPrice: number): MarketConfig => ({
      ...TIER0_MARKET_CONFIG, meanPrice, minimumPrice: 1, maximumPrice: 5_000,
      meanReversionCoefficient: 0, noiseCoefficient: 0
    });
    const stateAt = (price: number, referencePrice: number): MarketState => ({ price, stepIndex: 0, lastNotifiedReference: referencePrice });
    const surge = advanceMarket(atThreshold(1_150), stateAt(1_000, 1_000), deriveStream(1, "surge"));
    expect(surge.at(-1)).toEqual({ type: "marketEventOccurred", commodityId: "refined-volatiles", price: 1_150, kind: "surge", referencePrice: 1_000 });
    const crash = advanceMarket(atThreshold(850), stateAt(1_000, 1_000), deriveStream(1, "crash"));
    expect(crash.at(-1)).toEqual({ type: "marketEventOccurred", commodityId: "refined-volatiles", price: 850, kind: "crash", referencePrice: 1_000 });

    const driftConfig = { ...TIER0_MARKET_CONFIG, meanPrice: 1_200, minimumPrice: 1, maximumPrice: 5_000, meanReversionCoefficient: TIER0_MARKET_CONFIG.fixedPointScale / 2, noiseCoefficient: 0 };
    const rng = deriveStream(2, "slow-drift");
    let state = stateAt(1_000, 1_000);
    const first = advanceMarket(driftConfig, state, rng);
    expect(first).toHaveLength(1);
    state = first.reduce((current, event) => reduceMarketEvent(driftConfig, current, event), state);
    const second = advanceMarket(driftConfig, state, rng);
    expect(second.at(-1)).toEqual({ type: "marketEventOccurred", commodityId: "refined-volatiles", price: 1_150, kind: "surge", referencePrice: 1_000 });
    state = second.reduce((current, event) => reduceMarketEvent(driftConfig, current, event), state);
    expect(state.lastNotifiedReference).toBe(1_150);
    expect(advanceMarket(driftConfig, state, rng)).toHaveLength(1);
  });

  it("pins the live-config exact-integer headroom", () => {
    expect(marketUpdateNumeratorBound(TIER0_MARKET_CONFIG)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});
