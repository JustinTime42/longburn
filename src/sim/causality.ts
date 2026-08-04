import type { SimTimeMs } from "./clock.js";

/** Exact SI value, shared by every server-side causality check. */
export const SPEED_OF_LIGHT_METERS_PER_SECOND = 299_792_458;

/**
 * Endpoint motion during Tier 0 light transit is bounded below one part per
 * thousand: two endpoints at 150 km/s move at most 0.001 of a light path.
 */
export const CAUSALITY_RELATIVE_TOLERANCE = 0.001;

export interface PositionMeters {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CausalityProvenance {
  readonly eventTime: SimTimeMs;
  readonly emissionTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
  readonly observerPosition: PositionMeters;
}

export interface OutboundEvent<T> extends CausalityProvenance {
  readonly payload: T;
}

export interface EmittedMessage<T> extends OutboundEvent<T> {
  /** Server-authoritative age for the client to render, in simulation ms. */
  readonly stalenessMs: number;
}

export interface CausalityIncident extends CausalityProvenance {
  readonly requiredLightTravelMs: number;
  readonly actualElapsedMs: number;
}

export class CausalityInvariantViolation extends Error {
  readonly incident: CausalityIncident;

  constructor(incident: CausalityIncident) {
    super("Causality invariant violated: message emitted before light could arrive.");
    this.name = "CausalityInvariantViolation";
    this.incident = incident;
  }
}

const distanceMeters = (left: PositionMeters, right: PositionMeters): number => {
  const distance = Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  if (!Number.isFinite(distance)) {
    throw new RangeError("Causality positions must produce a finite distance.");
  }

  return distance;
};

export const requiredLightTravelMs = (provenance: CausalityProvenance): number =>
  (distanceMeters(provenance.eventPosition, provenance.observerPosition) / SPEED_OF_LIGHT_METERS_PER_SECOND) *
  1_000;

/** Throws for a leak so tests and callers can prove the invariant directly. */
export const assertCausalityInvariant = (provenance: CausalityProvenance): void => {
  const actualElapsedMs = provenance.emissionTime - provenance.eventTime;
  const requiredLightTravel = requiredLightTravelMs(provenance);
  const toleratedRequiredLightTravel = requiredLightTravel * (1 - CAUSALITY_RELATIVE_TOLERANCE);

  if (actualElapsedMs < toleratedRequiredLightTravel) {
    throw new CausalityInvariantViolation({
      ...provenance,
      requiredLightTravelMs: requiredLightTravel,
      actualElapsedMs
    });
  }
};

export interface CausalEmissionGateOptions<T> {
  /** The sole outbound transport callback. No message reaches it unchecked. */
  readonly send: (message: EmittedMessage<T>) => void;
  /** Incident-grade sink, invoked before a causality violation is suppressed. */
  readonly recordIncident: (incident: CausalityIncident) => void;
}

export type EmissionResult = { readonly sent: true } | { readonly sent: false };

/**
 * The outbound choke point. Later transports receive this gate, never a raw
 * send callback, so a causality breach fails closed before it reaches a client.
 */
export class CausalEmissionGate<T> {
  readonly #send: (message: EmittedMessage<T>) => void;
  readonly #recordIncident: (incident: CausalityIncident) => void;

  constructor({ send, recordIncident }: CausalEmissionGateOptions<T>) {
    this.#send = send;
    this.#recordIncident = recordIncident;
  }

  emit(event: OutboundEvent<T>): EmissionResult {
    try {
      assertCausalityInvariant(event);
    } catch (error: unknown) {
      if (error instanceof CausalityInvariantViolation) {
        this.#recordIncident(error.incident);
        return { sent: false };
      }

      throw error;
    }

    this.#send({ ...event, stalenessMs: event.emissionTime - event.eventTime });
    return { sent: true };
  }
}
