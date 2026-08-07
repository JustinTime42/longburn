import type { SimTimeMs } from "./clock.js";

/** Exact SI value, shared by every server-side causality check. */
export const SPEED_OF_LIGHT_METERS_PER_SECOND = 299_792_458;
const CONVERGENCE_MS = 0.001;
const MAX_LIGHT_CONE_ITERATIONS = 32;

/**
 * Keeps a converged floating-point estimate on the delayed side of the light
 * cone. For a convergent fixed point, the remaining error is bounded by the
 * preceding step; adding that step keeps the estimate on the delayed side.
 */
const conservativeArrivalTimeMs = (arrivalTimeMs: number, precedingStepMs: number): number =>
  arrivalTimeMs + precedingStepMs;

export interface PositionMeters {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Evaluates the receiver worldline at a (possibly fractional) sim millisecond. */
export type ObserverPositionAt = (timeMs: number) => PositionMeters;

export interface CausalityProvenance {
  readonly eventTime: SimTimeMs;
  readonly emissionTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
  readonly observerPositionAt: ObserverPositionAt;
}

export interface OutboundEvent<T> extends CausalityProvenance {
  readonly payload: T;
}

export interface EmittedMessage<T> extends OutboundEvent<T> {
  /** Receiver position at emission, supplied by the authoritative trajectory. */
  readonly observerPosition: PositionMeters;
  /** Server-authoritative age for the client to render, in simulation ms. */
  readonly stalenessMs: number;
}

export type CausalityFailureReason = "invalid-provenance" | "invalid-position" | "light-cone-failure" | "early-emission";
export type TransportFailureReason = "transport-failure";
export type EmissionFailureReason = CausalityFailureReason | TransportFailureReason;

/**
 * The incident-safe portion of outbound provenance. Payloads and receiver
 * worldlines are deliberately excluded because incident sinks are logs.
 */
export interface IncidentProvenance {
  readonly eventTime?: unknown;
  readonly emissionTime?: unknown;
  readonly eventPosition?: PositionMeters;
}

export interface CausalityIncident {
  readonly reason: EmissionFailureReason;
  readonly provenance: IncidentProvenance;
  readonly requiredArrivalTimeMs?: number;
  readonly actualElapsedMs?: number;
}

export class CausalityInvariantViolation extends Error {
  readonly incident: CausalityIncident;

  constructor(incident: CausalityIncident) {
    super("Causality invariant violated: message emitted before light could arrive.");
    this.name = "CausalityInvariantViolation";
    this.incident = incident;
  }
}

const isSimTimeMs = (value: unknown): value is SimTimeMs => Number.isSafeInteger(value) && (value as number) >= 0;

const validatedPosition = (position: unknown): PositionMeters => {
  if (
    typeof position !== "object" ||
    position === null ||
    !Number.isFinite((position as PositionMeters).x) ||
    !Number.isFinite((position as PositionMeters).y) ||
    !Number.isFinite((position as PositionMeters).z)
  ) {
    throw new RangeError("Causality positions must contain finite Cartesian coordinates.");
  }

  return position as PositionMeters;
};

const distanceMeters = (left: PositionMeters, right: PositionMeters): number => {
  const distance = Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  if (!Number.isFinite(distance)) {
    throw new RangeError("Causality positions must produce a finite distance.");
  }

  return distance;
};

const incidentProvenance = (provenance: unknown): IncidentProvenance => {
  try {
    if (typeof provenance !== "object" || provenance === null) {
      return {};
    }
    const event = provenance as Partial<CausalityProvenance>;
    const eventPosition = event.eventPosition;
    const position = typeof eventPosition === "object" && eventPosition !== null
      ? eventPosition as Partial<PositionMeters>
      : undefined;
    const x = position?.x;
    const y = position?.y;
    const z = position?.z;
    const positionSnapshot = typeof x === "number" && typeof y === "number" && typeof z === "number" &&
      Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
      ? { x, y, z }
      : undefined;

    return {
      eventTime: event.eventTime,
      emissionTime: event.emissionTime,
      ...(positionSnapshot === undefined ? {} : { eventPosition: positionSnapshot })
    };
  } catch {
    // A throwing getter in malformed input must not make reporting unsafe.
    return {};
  }
};

const failure = (
  reason: CausalityFailureReason,
  provenance: unknown,
  requiredArrivalTimeMs?: number,
  actualElapsedMs?: number
): CausalityInvariantViolation =>
  new CausalityInvariantViolation({
    reason, provenance: incidentProvenance(provenance), requiredArrivalTimeMs, actualElapsedMs
  });

/**
 * Solves the receiver's arrival-time light cone. The returned value is a
 * conservative floating-point arrival estimate; callers must schedule with
 * ceil().
 */
export const requiredArrivalTimeMs = (provenance: CausalityProvenance): number => {
  try {
    if (!isSimTimeMs(provenance.eventTime) || !isSimTimeMs(provenance.emissionTime)) {
      throw failure("invalid-provenance", provenance);
    }
    const eventPosition = validatedPosition(provenance.eventPosition);
    if (typeof provenance.observerPositionAt !== "function") {
      throw failure("invalid-provenance", provenance);
    }

    let arrivalTimeMs = provenance.eventTime +
      (distanceMeters(validatedPosition(provenance.observerPositionAt(provenance.eventTime)), eventPosition) /
        SPEED_OF_LIGHT_METERS_PER_SECOND) *
        1_000;
    let precedingStepMs = Number.POSITIVE_INFINITY;
    let lastNonzeroStepMs = 0;
    for (let iteration = 0; iteration < MAX_LIGHT_CONE_ITERATIONS; iteration += 1) {
      const nextArrivalTimeMs = provenance.eventTime +
        (distanceMeters(validatedPosition(provenance.observerPositionAt(arrivalTimeMs)), eventPosition) /
          SPEED_OF_LIGHT_METERS_PER_SECOND) *
          1_000;
      if (!Number.isFinite(nextArrivalTimeMs)) {
        throw new RangeError("Light-cone solve produced a non-finite arrival time.");
      }
      precedingStepMs = Math.abs(nextArrivalTimeMs - arrivalTimeMs);
      if (precedingStepMs > 0) lastNonzeroStepMs = precedingStepMs;
      arrivalTimeMs = nextArrivalTimeMs;
    }
    if (precedingStepMs < CONVERGENCE_MS) {
      // A fixed-point update can round to zero one iteration after its final
      // nonzero step. Preserve that step so rounding never pulls us inside c.
      const roundingMarginMs = lastNonzeroStepMs === 0
        ? 0
        : Math.max(lastNonzeroStepMs, Number.EPSILON * Math.max(1, Math.abs(arrivalTimeMs)) * 2);
      return conservativeArrivalTimeMs(arrivalTimeMs, roundingMarginMs);
    }
  } catch (error: unknown) {
    if (error instanceof CausalityInvariantViolation) {
      throw error;
    }
    throw failure("invalid-position", provenance);
  }

  throw failure("light-cone-failure", provenance);
};

/** The earliest integral simulation tick at which the message may be emitted. */
export const earliestLegalEmissionTimeMs = (provenance: CausalityProvenance): number =>
  Math.ceil(requiredArrivalTimeMs(provenance));

/** Throws for every malformed or early emission, so callers can fail closed. */
export const assertCausalityInvariant = (provenance: CausalityProvenance): void => {
  const arrivalTimeMs = requiredArrivalTimeMs(provenance);
  if (provenance.emissionTime < Math.ceil(arrivalTimeMs)) {
    throw failure("early-emission", provenance, arrivalTimeMs, provenance.emissionTime - provenance.eventTime);
  }
};

export interface CausalEmissionGateOptions<T> {
  /** The sole raw outbound transport callback. No message reaches it unchecked. */
  readonly send: (message: EmittedMessage<T>) => void;
  /** Incident-grade sink, invoked for every blocked message. */
  readonly recordIncident: (incident: CausalityIncident) => void;
  /** Counter/alert hook, invoked even if incident recording itself fails. */
  readonly incrementCausalityFailure: () => void;
}

export type EmissionResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: EmissionFailureReason };

/**
 * The outbound choke point. Future transports receive this gate, never a raw
 * send callback. `test/causal-transport-fence.test.ts` enforces that boundary.
 */
export class CausalEmissionGate<T> {
  readonly #send: (message: EmittedMessage<T>) => void;
  readonly #recordIncident: (incident: CausalityIncident) => void;
  readonly #incrementCausalityFailure: () => void;

  constructor({ send, recordIncident, incrementCausalityFailure }: CausalEmissionGateOptions<T>) {
    this.#send = send;
    this.#recordIncident = recordIncident;
    this.#incrementCausalityFailure = incrementCausalityFailure;
  }

  emit(event: OutboundEvent<T>): EmissionResult {
    let message: EmittedMessage<T>;
    try {
      assertCausalityInvariant(event);
      const observerPosition = validatedPosition(event.observerPositionAt(event.emissionTime));
      message = { ...event, observerPosition, stalenessMs: event.emissionTime - event.eventTime };
    } catch (error: unknown) {
      const incident = error instanceof CausalityInvariantViolation
        ? error.incident
        : { reason: "invalid-position" as const, provenance: incidentProvenance(event) };
      try {
        this.#recordIncident(incident);
      } catch {
        // Reporting cannot turn a closed gate into a send.
      }
      try {
        this.#incrementCausalityFailure();
      } catch {
        // Alerting cannot turn a closed gate into a send.
      }
      return { sent: false, reason: incident.reason };
    }

    try {
      this.#send(message);
      return { sent: true };
    } catch {
      try {
        this.#recordIncident({ reason: "transport-failure", provenance: incidentProvenance(event) });
      } catch {
        // Transport reporting cannot change the delivery outcome.
      }
      return { sent: false, reason: "transport-failure" };
    }
  }
}
