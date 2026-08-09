import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { replaySegment, type SimEvent } from "./event-log.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { AuthoritativeSimLoop } from "./loop.js";
import { advanceMarket, centeredIrwinHall12, MARKET_NOISE_DRAW_COUNT, marketInitialState, marketUpdateNumeratorBound, nextMarketPrice, reduceMarketEvent, replayMarketEvents, TIER0_MARKET_CONFIG, type MarketConfig, type MarketEvent } from "./market.js";
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

  it("pins fixed-seed mean reversion, clamp walls, and centered Irwin-Hall noise", () => {
    const events = marketEvents(0x1234_5678, 500).events;
    const quotes = events.filter((event): event is Extract<SimEvent, { type: "marketQuoteUpdated" }> => event.type === "marketQuoteUpdated");
    expect(quotes.at(-1)?.price).toBe(916);
    expect(quotes.some(({ price }) => price === TIER0_MARKET_CONFIG.minimumPrice)).toBe(false);
    expect(quotes.some(({ price }) => price === TIER0_MARKET_CONFIG.maximumPrice)).toBe(false);
    const noise = deriveStream(0x1234_5678, "market:noise-centering");
    const total = Array.from({ length: 500 }, () => centeredIrwinHall12(noise)).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(949_024);
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

  it("persists hourly quotes at the market host position and resumes their substream", async () => {
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
    const resumed = await AuthoritativeSimLoop.resume(store, "market-cadence", { marketPositionAt: (_body, time) => ({ x: time, y: 2, z: 3 }) });
    await resumed.advance(TIER0_MARKET_CONFIG.marketStepMs, () => ({ x: 0, y: 0, z: 0 }));
    expect((await resumed.persistedStream()).events.filter(({ event }) => event.type === "marketQuoteUpdated")).toHaveLength(3);
  });

  it("pins the live-config exact-integer headroom", () => {
    expect(marketUpdateNumeratorBound(TIER0_MARKET_CONFIG)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});
