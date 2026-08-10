import { type SeededRng } from "./rng.js";

/** M=2^16 permits an unbiased uint32 high-bits draw in SeededRng.nextInt. */
export const MARKET_NOISE_UPPER_EXCLUSIVE = 2 ** 16;
export const MARKET_NOISE_DRAW_COUNT = 12;
export const MARKET_FIXED_POINT_SCALE = 2 ** 32;
export const MARKET_STEP_MS = 3_600_000;

export interface MarketConfig {
  readonly commodityId: string;
  readonly marketBodyId: "earth" | "moon" | "mars";
  readonly meanPrice: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  /** a = round(S * exp(-theta * step)), built outside the sim core. */
  readonly meanReversionCoefficient: number;
  /** b = round(S * sigmaStep / sqrt(M^2 - 1)), built outside the sim core. */
  readonly noiseCoefficient: number;
  readonly fixedPointScale: number;
  readonly marketStepMs: number;
  /** Minimum market steps used by a forward quote, even for a shorter paper plan. */
  readonly minimumQuoteHorizonSteps: number;
  /** Percentage threshold expressed as basis points, avoiding fractional prices. */
  readonly notificationThresholdBasisPoints: number;
}

/** Approved v0.1 tuning constants, quantized outside the sim core. */
export const TIER0_MARKET_CONFIG: MarketConfig = {
  commodityId: "refined-volatiles",
  marketBodyId: "mars",
  meanPrice: 1_000,
  minimumPrice: 200,
  maximumPrice: 5_000,
  meanReversionCoefficient: 4_270_230_105,
  noiseCoefficient: 1_755_917,
  fixedPointScale: MARKET_FIXED_POINT_SCALE,
  marketStepMs: MARKET_STEP_MS,
  minimumQuoteHorizonSteps: 480,
  notificationThresholdBasisPoints: 1_500
};

export interface MarketState {
  readonly price: number;
  readonly stepIndex: number;
  /** The price from the most recently notified surge or crash. */
  readonly lastNotifiedReference: number;
}

export type MarketEvent =
  | {
    readonly type: "marketQuoteUpdated";
    readonly commodityId: string;
    readonly price: number;
    readonly stepIndex: number;
    readonly marketBodyId: "earth" | "moon" | "mars";
  }
  | {
    readonly type: "marketEventOccurred";
    readonly commodityId: string;
    readonly price: number;
    readonly kind: "surge" | "crash";
    readonly referencePrice: number;
  };

const assertSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer.`);
  return value;
};

export const assertMarketConfig = (config: MarketConfig): MarketConfig => {
  if (config.commodityId.length === 0) throw new RangeError("Market commodity ID must be non-empty.");
  if (config.marketBodyId !== "earth" && config.marketBodyId !== "moon" && config.marketBodyId !== "mars") {
    throw new RangeError("Market host body must be a known Tier 0 body.");
  }
  const minimumPrice = assertSafeInteger(config.minimumPrice, "Market minimum price");
  const meanPrice = assertSafeInteger(config.meanPrice, "Market mean price");
  const maximumPrice = assertSafeInteger(config.maximumPrice, "Market maximum price");
  if (minimumPrice > meanPrice || meanPrice > maximumPrice) throw new RangeError("Market prices must satisfy minimum <= mean <= maximum.");
  const scale = assertSafeInteger(config.fixedPointScale, "Market fixed-point scale");
  if (scale <= 0 || scale !== MARKET_FIXED_POINT_SCALE) throw new RangeError("Market fixed-point scale must be the pinned 2^32 value.");
  const a = assertSafeInteger(config.meanReversionCoefficient, "Market mean-reversion coefficient");
  if (a < 0 || a > scale) throw new RangeError("Market mean-reversion coefficient must be within the fixed-point scale.");
  const b = assertSafeInteger(config.noiseCoefficient, "Market noise coefficient");
  if (b < 0) throw new RangeError("Market noise coefficient must be non-negative.");
  if (!Number.isSafeInteger(config.marketStepMs) || config.marketStepMs <= 0) throw new RangeError("Market cadence must be a positive safe integer.");
  if (!Number.isSafeInteger(config.minimumQuoteHorizonSteps) || config.minimumQuoteHorizonSteps < 0) {
    throw new RangeError("Market minimum quote horizon must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(config.notificationThresholdBasisPoints) || config.notificationThresholdBasisPoints <= 0 || config.notificationThresholdBasisPoints >= 10_000) {
    throw new RangeError("Market notification threshold must be between 1 and 9,999 basis points.");
  }
  if (marketUpdateNumeratorBound(config) > Number.MAX_SAFE_INTEGER) throw new RangeError("Market configuration exceeds exact integer update headroom.");
  return config;
};

export const marketInitialState = (config: MarketConfig): MarketState => {
  assertMarketConfig(config);
  return { price: config.meanPrice, stepIndex: 0, lastNotifiedReference: config.meanPrice };
};

/** Worst possible absolute update numerator, computed from the live config. */
export const marketUpdateNumeratorBound = (config: MarketConfig): number => {
  const maximumNoise = MARKET_NOISE_DRAW_COUNT / 2 * (MARKET_NOISE_UPPER_EXCLUSIVE - 1);
  return config.meanReversionCoefficient * config.maximumPrice +
    (config.fixedPointScale - config.meanReversionCoefficient) * Math.abs(config.meanPrice) +
    config.noiseCoefficient * maximumNoise + config.fixedPointScale / 2;
};

export const centeredIrwinHall12 = (rng: Pick<SeededRng, "nextInt">): number => {
  let sum = 0;
  for (let index = 0; index < MARKET_NOISE_DRAW_COUNT; index += 1) sum += rng.nextInt(MARKET_NOISE_UPPER_EXCLUSIVE);
  return sum - MARKET_NOISE_DRAW_COUNT / 2 * (MARKET_NOISE_UPPER_EXCLUSIVE - 1);
};

const clamp = (minimum: number, maximum: number, value: number): number => Math.min(maximum, Math.max(minimum, value));

/** Integer AR(1) update. All coefficients are pre-quantized config facts. */
export const nextMarketPrice = (config: MarketConfig, currentPrice: number, noise: number): number => {
  assertMarketConfig(config);
  assertSafeInteger(currentPrice, "Market price");
  assertSafeInteger(noise, "Market noise");
  const numerator = config.meanReversionCoefficient * currentPrice +
    (config.fixedPointScale - config.meanReversionCoefficient) * config.meanPrice +
    config.noiseCoefficient * noise + config.fixedPointScale / 2;
  if (!Number.isSafeInteger(numerator)) throw new RangeError("Market update exceeded exact integer arithmetic.");
  return clamp(config.minimumPrice, config.maximumPrice, Math.floor(numerator / config.fixedPointScale));
};

const notification = (config: MarketConfig, state: MarketState, price: number): Extract<MarketEvent, { readonly type: "marketEventOccurred" }> | undefined => {
  const reference = state.lastNotifiedReference;
  const basis = 10_000;
  if (price * basis >= reference * (basis + config.notificationThresholdBasisPoints)) {
    return { type: "marketEventOccurred", commodityId: config.commodityId, price, kind: "surge", referencePrice: reference };
  }
  if (price * basis <= reference * (basis - config.notificationThresholdBasisPoints)) {
    return { type: "marketEventOccurred", commodityId: config.commodityId, price, kind: "crash", referencePrice: reference };
  }
  return undefined;
};

/** Produces the persisted facts for one fixed-cadence market step. */
export const advanceMarket = (config: MarketConfig, state: MarketState, rng: SeededRng): readonly MarketEvent[] => {
  assertMarketConfig(config);
  const price = nextMarketPrice(config, state.price, centeredIrwinHall12(rng));
  const quote: MarketEvent = {
    type: "marketQuoteUpdated", commodityId: config.commodityId, price,
    stepIndex: state.stepIndex + 1, marketBodyId: config.marketBodyId
  };
  const event = notification(config, state, price);
  return event === undefined ? [quote] : [quote, event];
};

export const reduceMarketEvent = (config: MarketConfig, state: MarketState, event: MarketEvent): MarketState => {
  assertMarketConfig(config);
  if (event.commodityId !== config.commodityId) throw new RangeError("Market event commodity does not match this market.");
  if (!Number.isSafeInteger(event.price) || event.price < config.minimumPrice || event.price > config.maximumPrice) {
    throw new RangeError("Market event price must be an integer within clamp walls.");
  }
  if (event.type === "marketQuoteUpdated") {
    if (event.marketBodyId !== config.marketBodyId || event.stepIndex !== state.stepIndex + 1) throw new RangeError("Market quotes must advance one step at their configured host body.");
    return { ...state, price: event.price, stepIndex: event.stepIndex };
  }
  if (event.referencePrice !== state.lastNotifiedReference) throw new RangeError("Market event reference must match the last notified price.");
  const threshold = config.notificationThresholdBasisPoints;
  const expectedKind = event.price * 10_000 >= event.referencePrice * (10_000 + threshold) ? "surge"
    : event.price * 10_000 <= event.referencePrice * (10_000 - threshold) ? "crash" : undefined;
  if (event.kind !== expectedKind) throw new RangeError("Market event must cross its configured notification threshold.");
  return { ...state, lastNotifiedReference: event.price };
};

export const replayMarketEvents = (config: MarketConfig, events: readonly MarketEvent[]): MarketState =>
  events.reduce((state, event) => reduceMarketEvent(config, state, event), marketInitialState(config));
