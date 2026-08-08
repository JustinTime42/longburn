import { earliestLegalEmissionTimeMs, type ObserverPositionAt, type PositionMeters } from "../sim/causality.js";
import { simTimeMs, type SimTimeMs } from "../sim/clock.js";
import type { FlightPlan } from "../sim/event-log.js";

export interface InboundPlanRevisionLoop {
  readonly state: { readonly time: SimTimeMs };
  scheduleInboundPlanRevision(
    flightPlan: FlightPlan,
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    hqPositionAt: (issuedAtMs: SimTimeMs) => PositionMeters,
    arrivalPositionAt: (arrivalAtMs: SimTimeMs) => PositionMeters
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }>;
}

export interface PlanRevisionTransportOptions {
  readonly loop: InboundPlanRevisionLoop;
  /** Authoritative propagated ship worldline, not a client-supplied position. */
  readonly shipPositionAt: ObserverPositionAt;
  /** T0 HQ is Earth, evaluated in the same heliocentric frame at issue time. */
  readonly hqPositionAt: ObserverPositionAt;
}

/**
 * The inbound half of the causal transport fence. Commands originate at the
 * fixed T0 Earth HQ and are only handed to the authoritative loop at arrival.
 */
export class PlanRevisionTransport {
  readonly #loop: InboundPlanRevisionLoop;
  readonly #shipPositionAt: ObserverPositionAt;
  readonly #hqPositionAt: ObserverPositionAt;

  constructor({ loop, shipPositionAt, hqPositionAt }: PlanRevisionTransportOptions) {
    this.#loop = loop;
    this.#shipPositionAt = shipPositionAt;
    this.#hqPositionAt = hqPositionAt;
  }

  issue(flightPlan: FlightPlan): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    return this.#loop.scheduleInboundPlanRevision(
      flightPlan,
      (issuedAtMs) => simTimeMs(earliestLegalEmissionTimeMs({
        eventTime: issuedAtMs,
        emissionTime: issuedAtMs,
        eventPosition: this.#hqPositionAt(issuedAtMs),
        observerPositionAt: this.#shipPositionAt
      })),
      this.#hqPositionAt,
      (arrivalAtMs) => this.#shipPositionAt(arrivalAtMs)
    );
  }
}
