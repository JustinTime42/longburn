import type { SimTimeMs } from "./clock.js";
import type { MarketConfig, MarketState } from "./market.js";

export type SpotDisposition = "manual" | "sell-on-arrival";
export type SellRefusalReason = "not-arrived-or-docked" | "no-cargo" | "duplicate-sale";
export type CargoCompositionRefusalReason = "forward-market-destination-mismatch";

/** A typed local refusal. Invalid compositions are never appended to the event log. */
export class CargoCompositionValidationError extends Error {
  readonly reason: CargoCompositionRefusalReason;

  constructor(reason: CargoCompositionRefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface TradeConfig {
  readonly originCostPerTon: number;
  readonly startingCredits: number;
  readonly forwardSpreadPerTon: number;
}

export const TIER0_TRADE_CONFIG: TradeConfig = Object.freeze({
  originCostPerTon: 600,
  startingCredits: 10_000,
  forwardSpreadPerTon: 50
});

export interface CargoComposition {
  readonly contractedTons: number;
  readonly spotTons: number;
  readonly spotDisposition: SpotDisposition;
}

export interface CargoState {
  readonly credits: number;
  readonly contractedTons: number;
  readonly contractedRatePerTon?: number;
  readonly spotTons: number;
  readonly spotDisposition?: SpotDisposition;
  /** Retained after a spot settlement so a repeated order has a typed outcome. */
  readonly spotSold: boolean;
}

export const initialCargoState = (config: TradeConfig = TIER0_TRADE_CONFIG): CargoState =>
  ({ credits: safe(config.startingCredits, "Starting credits"), contractedTons: 0, spotTons: 0, spotSold: false });

export type TradeEvent =
  | { readonly type: "cargoComposed"; readonly composition: CargoComposition; readonly originCostPerTon: number; readonly totalCost: number; readonly forwardRatePerTon: number }
  | { readonly type: "cargoSold"; readonly lot: "contracted" | "spot"; readonly tons: number; readonly pricePerTon: number; readonly proceeds: number; readonly commandId?: string }
  | { readonly type: "sellRefused"; readonly reason: SellRefusalReason; readonly commandId?: string }
  | { readonly type: "spotDispositionRevised"; readonly spotDisposition: SpotDisposition; readonly commandId: string };

const safe = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer.`);
  return value;
};

const nonNegative = (value: number, label: string): number => {
  safe(value, label);
  if (value < 0) throw new RangeError(`${label} must be non-negative.`);
  return value;
};

const product = (left: number, right: number, label: string): number => {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds exact integer arithmetic.`);
  return value;
};

const validateComposition = (composition: CargoComposition): CargoComposition => {
  const contractedTons = nonNegative(composition.contractedTons, "Contracted tons");
  const spotTons = nonNegative(composition.spotTons, "Spot tons");
  if (contractedTons + spotTons <= 0) throw new RangeError("Cargo composition requires positive tonnage.");
  if (composition.spotDisposition !== "manual" && composition.spotDisposition !== "sell-on-arrival") {
    throw new RangeError("Spot cargo requires a known disposition.");
  }
  return { contractedTons, spotTons, spotDisposition: composition.spotDisposition };
};

/** Fixed-point a^n/S^n, using only integer exponentiation-by-squaring. */
const coefficientPower = (coefficient: number, scale: number, steps: number): bigint => {
  let exponent = BigInt(steps);
  let base = BigInt(coefficient);
  let result = BigInt(scale);
  const unit = BigInt(scale);
  while (exponent > 0n) {
    if ((exponent & 1n) === 1n) result = (result * base + unit / 2n) / unit;
    base = (base * base + unit / 2n) / unit;
    exponent >>= 1n;
  }
  return result;
};

/** Largest price information a minimum quote horizon can carry, in whole credits. */
export const forwardQuoteInformationBound = (market: MarketConfig): number => {
  const power = coefficientPower(market.meanReversionCoefficient, market.fixedPointScale, market.minimumQuoteHorizonSteps);
  return Number((BigInt(market.maximumPrice - market.meanPrice) * power) / BigInt(market.fixedPointScale));
};

/** Planner-side conditional expectation, quantized before it crosses into the sim. */
export const forwardQuotePerTon = (
  market: MarketConfig,
  spotPrice: number,
  plannedArrivalAtMs: SimTimeMs,
  composedAtMs: SimTimeMs,
  spreadPerTon: number
): number => {
  safe(spotPrice, "Spot price");
  safe(spreadPerTon, "Forward spread");
  if (plannedArrivalAtMs < composedAtMs) throw new RangeError("Forward quote arrival cannot precede composition.");
  const plannedSteps = Math.ceil((plannedArrivalAtMs - composedAtMs) / market.marketStepMs);
  const steps = Math.max(plannedSteps, market.minimumQuoteHorizonSteps);
  const power = coefficientPower(market.meanReversionCoefficient, market.fixedPointScale, steps);
  const expected = BigInt(market.meanPrice) + (BigInt(spotPrice - market.meanPrice) * power) / BigInt(market.fixedPointScale);
  const quote = expected - BigInt(spreadPerTon);
  if (quote < 0n || quote > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Forward quote is outside integer-credit range.");
  return Number(quote);
};

export const composeCargo = (
  config: TradeConfig,
  market: MarketConfig,
  marketState: MarketState,
  composition: CargoComposition,
  plannedArrivalAtMs: SimTimeMs,
  composedAtMs: SimTimeMs,
  plannedDestination: MarketConfig["marketBodyId"]
): Extract<TradeEvent, { readonly type: "cargoComposed" }> => {
  const validated = validateComposition(composition);
  if (validated.contractedTons > 0 && plannedDestination !== market.marketBodyId) {
    throw new CargoCompositionValidationError("forward-market-destination-mismatch", "Forward cargo requires a flight plan to the forward market body.");
  }
  const totalCost = product(validated.contractedTons + validated.spotTons, nonNegative(config.originCostPerTon, "Origin cost"), "Cargo purchase");
  return {
    type: "cargoComposed", composition: validated, originCostPerTon: config.originCostPerTon, totalCost,
    forwardRatePerTon: forwardQuotePerTon(market, marketState.price, plannedArrivalAtMs, composedAtMs, config.forwardSpreadPerTon)
  };
};

export const reduceTradeEvent = (state: CargoState, event: TradeEvent): CargoState => {
  switch (event.type) {
    case "cargoComposed": {
      const composition = validateComposition(event.composition);
      const totalCost = product(composition.contractedTons + composition.spotTons, nonNegative(event.originCostPerTon, "Origin cost"), "Cargo purchase");
      if (event.totalCost !== totalCost || event.totalCost > state.credits) throw new RangeError("Cargo composition has invalid or unfunded purchase cost.");
      nonNegative(event.forwardRatePerTon, "Forward rate");
      if (state.contractedTons !== 0 || state.spotTons !== 0) throw new RangeError("Cargo must be settled before another composition.");
      return { credits: state.credits - totalCost, contractedTons: composition.contractedTons, contractedRatePerTon: event.forwardRatePerTon, spotTons: composition.spotTons, spotDisposition: composition.spotDisposition, spotSold: false };
    }
    case "cargoSold": {
      const tons = nonNegative(event.tons, "Sold tons");
      const price = nonNegative(event.pricePerTon, "Sale price");
      const proceeds = product(tons, price, "Cargo proceeds");
      if (event.proceeds !== proceeds) throw new RangeError("Cargo settlement proceeds must be exact integer price times tons.");
      const available = event.lot === "contracted" ? state.contractedTons : state.spotTons;
      if (tons !== available || tons === 0) throw new RangeError("Cargo settlement must sell its remaining lot exactly once.");
      if (event.lot === "contracted" && price !== state.contractedRatePerTon) throw new RangeError("Forward settlement must use the persisted contract rate.");
      return event.lot === "contracted"
        ? { ...state, credits: state.credits + proceeds, contractedTons: 0, contractedRatePerTon: undefined }
        : { ...state, credits: state.credits + proceeds, spotTons: 0, spotDisposition: undefined, spotSold: true };
    }
    case "sellRefused":
      if (event.reason !== "not-arrived-or-docked" && event.reason !== "no-cargo" && event.reason !== "duplicate-sale") throw new RangeError("Sell refusal requires a known reason.");
      return state;
    case "spotDispositionRevised":
      if (event.commandId.length === 0 || (event.spotDisposition !== "manual" && event.spotDisposition !== "sell-on-arrival")) {
        throw new RangeError("Spot disposition revisions require a command ID and known disposition.");
      }
      if (state.spotTons === 0) throw new RangeError("Spot disposition requires loaded spot cargo.");
      return { ...state, spotDisposition: event.spotDisposition };
  }
};

export const settlement = (lot: "contracted" | "spot", tons: number, pricePerTon: number, commandId?: string): Extract<TradeEvent, { readonly type: "cargoSold" }> =>
  ({ type: "cargoSold", lot, tons, pricePerTon, proceeds: product(nonNegative(tons, "Sold tons"), nonNegative(pricePerTon, "Sale price"), "Cargo proceeds"), ...(commandId === undefined ? {} : { commandId }) });
