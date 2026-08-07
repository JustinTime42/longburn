import { earliestLegalEmissionTimeMs, type ObserverPositionAt, type PositionMeters } from "../sim/causality.js";
import { simTimeMs, type SimTimeMs } from "../sim/clock.js";
import type { FlightPlan } from "../sim/event-log.js";
import { T0_EARTH_HQ_POSITION_METERS } from "../sim/headquarters.js";

export interface InboundPlanRevisionLoop {
  readonly state: { readonly time: SimTimeMs };
  scheduleInboundPlanRevision(
    flightPlan: FlightPlan,
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    eventPosition: () => PositionMeters
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }>;
}

export interface PlanRevisionTransportOptions {
  readonly loop: InboundPlanRevisionLoop;
  /** Authoritative propagated ship worldline, not a client-supplied position. */
  readonly shipPositionAt: ObserverPositionAt;
}

/**
 * The inbound half of the causal transport fence. Commands originate at the
 * fixed T0 Earth HQ and are only handed to the authoritative loop at arrival.
 */
export class PlanRevisionTransport {
  readonly #loop: InboundPlanRevisionLoop;
  readonly #shipPositionAt: ObserverPositionAt;

  constructor({ loop, shipPositionAt }: PlanRevisionTransportOptions) {
    this.#loop = loop;
    this.#shipPositionAt = shipPositionAt;
  }

  issue(flightPlan: FlightPlan): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    return this.#loop.scheduleInboundPlanRevision(
      flightPlan,
      (issuedAtMs) => simTimeMs(earliestLegalEmissionTimeMs({
        eventTime: issuedAtMs,
        emissionTime: issuedAtMs,
        eventPosition: T0_EARTH_HQ_POSITION_METERS,
        observerPositionAt: this.#shipPositionAt
      })),
      () => this.#shipPositionAt(this.#loop.state.time)
    );
  }
}
