import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { marketInitialState, TIER0_MARKET_CONFIG } from "./market.js";
import { composeCargo, forwardQuotePerTon, initialCargoState, reduceTradeEvent, settlement, TIER0_TRADE_CONFIG } from "./trade.js";

describe("cargo composition and settlement", () => {
  it("persists a planner-side forward quote and never reprices it at settlement", () => {
    const composed = composeCargo(TIER0_TRADE_CONFIG, TIER0_MARKET_CONFIG, marketInitialState(TIER0_MARKET_CONFIG),
      { contractedTons: 4, spotTons: 1, spotDisposition: "manual" }, simTimeMs(9 * TIER0_MARKET_CONFIG.marketStepMs), simTimeMs(0));
    const loaded = reduceTradeEvent(initialCargoState(), composed);
    expect(composed.forwardRatePerTon).toBe(forwardQuotePerTon(TIER0_MARKET_CONFIG, 1_000, simTimeMs(9 * TIER0_MARKET_CONFIG.marketStepMs), simTimeMs(0), 50));
    expect(reduceTradeEvent(loaded, settlement("contracted", 4, composed.forwardRatePerTon))).toMatchObject({ credits: 10_000 - 3_000 + 4 * composed.forwardRatePerTon, contractedTons: 0 });
  });

  it("uses exact integer proceeds and rejects duplicate or repriced settlement", () => {
    const composition = composeCargo(TIER0_TRADE_CONFIG, TIER0_MARKET_CONFIG, marketInitialState(TIER0_MARKET_CONFIG),
      { contractedTons: 0, spotTons: 3, spotDisposition: "sell-on-arrival" }, simTimeMs(0), simTimeMs(0));
    const loaded = reduceTradeEvent(initialCargoState(), composition);
    const sold = reduceTradeEvent(loaded, settlement("spot", 3, 1_234));
    expect(sold.credits).toBe(10_000 - 1_800 + 3_702);
    expect(() => reduceTradeEvent(sold, settlement("spot", 3, 1_234))).toThrow("remaining lot exactly once");
    expect(() => reduceTradeEvent(loaded, { ...settlement("spot", 3, 1_234), proceeds: 3_703 })).toThrow("proceeds must be exact");
  });

  it("keeps typed sell refusals as durable no-op facts", () => {
    for (const reason of ["not-arrived-or-docked", "no-cargo", "duplicate-sale"] as const) {
      expect(reduceTradeEvent(initialCargoState(), { type: "sellRefused", reason })).toEqual(initialCargoState());
    }
  });
});
