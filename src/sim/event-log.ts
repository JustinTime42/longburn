import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
import { SeededRng } from "./rng.js";

export type SimEvent =
  | { readonly type: "clockAdvanced"; readonly elapsedMs: number }
  | { readonly type: "randomValueRequested"; readonly upperExclusive: number };

export interface SimState {
  readonly time: SimTimeMs;
  readonly randomValues: readonly number[];
}

/** Rebuild a segment from its append-only event log and its recorded RNG seed. */
export const replaySegment = (seed: number, events: readonly SimEvent[]): SimState => {
  const clock = SimClock.production(simTimeMs(0));
  const rng = new SeededRng(seed);
  const randomValues: number[] = [];

  for (const event of events) {
    switch (event.type) {
      case "clockAdvanced":
        clock.advance(event.elapsedMs);
        break;
      case "randomValueRequested":
        randomValues.push(rng.nextInt(event.upperExclusive));
        break;
    }
  }

  return { time: clock.now, randomValues };
};

/** Replays an event-store stream from its persisted seed and append-only order. */
export const replayPersistedSegment = (
  stream: { readonly seed: number; readonly events: readonly { readonly event: SimEvent }[] }
): SimState => replaySegment(stream.seed, stream.events.map(({ event }) => event));
