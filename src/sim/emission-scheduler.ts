import { CausalityInvariantViolation, earliestLegalEmissionTimeMs, type CausalityIncident, type EmissionResult } from "./causality.js";
import type { SimTimeMs } from "./clock.js";
import { hasAcknowledged, type DeliveryAcknowledgement, type DeliveryCursorStore } from "./delivery-cursor.js";
import { buildEmittedMessage, type BuildEmittedMessage, type EmissionCandidate } from "./emitted-message.js";

export type LightLaggedMessageClass = "shipReport" | "commandOutcomeReport" | "marketEvent";

export const isLightLaggedMessageClass = (messageClass: string): messageClass is LightLaggedMessageClass =>
  messageClass === "shipReport" || messageClass === "commandOutcomeReport" || messageClass === "marketEvent";

/** A scheduled envelope is rooted in a stored physical-log position. */
export interface ScheduledEmission {
  readonly sourceGlobalPosition: number;
  readonly message: Omit<BuildEmittedMessage, "emissionTimeMs">;
}

/**
 * Dependencies for one scheduler writer. The host must serialize `run` calls
 * per observer; acknowledgement persistence is not a transport lock.
 */
export interface EmissionSchedulerOptions {
  readonly cursors: DeliveryCursorStore;
  /** E3 supplies the causal gate plus real transport acknowledgement here. */
  readonly emit: (candidate: EmissionCandidate) => Promise<EmissionResult>;
  /** Scheduler-side failures happen before the gate, but are equally closed. */
  readonly recordIncident: (incident: CausalityIncident) => void;
  readonly incrementCausalityFailure: () => void;
  /** Records every light-lagged emission suppressed by an acknowledgement. */
  readonly incrementBelowCursorSuppression: () => void;
}

export interface SchedulerRunResult {
  readonly emitted: readonly string[];
  readonly deferred: readonly string[];
  readonly blocked: readonly string[];
}

const validSourcePosition = (emission: ScheduledEmission): void => {
  if (!Number.isSafeInteger(emission.sourceGlobalPosition) || emission.sourceGlobalPosition < 1 ||
    emission.sourceGlobalPosition !== emission.message.event.globalPosition) {
    throw new RangeError("Scheduled emissions require their stored event's positive global position.");
  }
};

/**
 * Per-observer scheduler. It deliberately accepts simulation time as input,
 * never a wall clock. Cursor writes happen only after emit acknowledges.
 *
 * A caller must serialize `run` calls for each observer. Concurrent calls can
 * both emit before either observes the other's acknowledgement, so persistence
 * cannot make transport single-writer.
 */
export class EmissionScheduler {
  readonly #cursors: DeliveryCursorStore;
  readonly #emit: (candidate: EmissionCandidate) => Promise<EmissionResult>;
  readonly #recordIncident: (incident: CausalityIncident) => void;
  readonly #incrementCausalityFailure: () => void;
  readonly #incrementBelowCursorSuppression: () => void;

  constructor({ cursors, emit, recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression }: EmissionSchedulerOptions) {
    this.#cursors = cursors;
    this.#emit = emit;
    this.#recordIncident = recordIncident;
    this.#incrementCausalityFailure = incrementCausalityFailure;
    this.#incrementBelowCursorSuppression = incrementBelowCursorSuppression;
  }

  /**
   * Runs one serialized delivery pass for an observer.
   *
   * The caller must supply every unacknowledged light-lagged emission for the
   * observer on every pass. Presentation order is not a delivery dependency:
   * each event is independently released at its own earliest legal tick. When
   * two are first releasable on the same tick, globalPosition breaks the tie.
   * Re-presenting an acknowledged message increments the delivery-integrity
   * counter so duplicate suppression remains structured and observable.
   */
  async run(observerId: string, now: SimTimeMs, scheduled: readonly ScheduledEmission[]): Promise<SchedulerRunResult> {
    const lightLaggedPositions = new Set<number>();
    for (const emission of scheduled) {
      validSourcePosition(emission);
      if (emission.message.observerId !== observerId) throw new RangeError("Scheduled emission observer does not match scheduler observer.");
      if (isLightLaggedMessageClass(emission.message.class)) {
        if (lightLaggedPositions.has(emission.sourceGlobalPosition)) {
          throw new RangeError("One stored event cannot advance a delivery cursor more than once.");
        }
        lightLaggedPositions.add(emission.sourceGlobalPosition);
      }
    }
    let cursor = await this.#cursors.read(observerId);
    const emitted: string[] = [];
    const deferred: string[] = [];
    const blocked: string[] = [];

    const prepared = scheduled.map((emission) => {
      let candidate: EmissionCandidate | undefined;
      let earliest: number | undefined;
      let incident: CausalityIncident | undefined;
      try {
        candidate = buildEmittedMessage({ ...emission.message, emissionTimeMs: now } as BuildEmittedMessage);
        earliest = isLightLaggedMessageClass(emission.message.class)
          ? earliestLegalEmissionTimeMs({ eventTime: candidate.eventTimeMs, emissionTime: candidate.emissionTimeMs, eventPosition: candidate.eventPosition, observerPositionAt: candidate.observerPositionAt })
          : candidate.eventTimeMs;
      } catch (error: unknown) {
        incident = error instanceof CausalityInvariantViolation
          ? error.incident
          : { reason: "invalid-position" as const, provenance: { eventTime: emission.message.event.eventTime, eventPosition: emission.message.event.eventPosition } };
      }
      return { emission, candidate, earliest, incident };
    }).sort((left, right) => (left.earliest ?? Number.POSITIVE_INFINITY) - (right.earliest ?? Number.POSITIVE_INFINITY) ||
      left.emission.sourceGlobalPosition - right.emission.sourceGlobalPosition);

    for (const { emission, candidate, earliest, incident } of prepared) {
      const local = !isLightLaggedMessageClass(emission.message.class);
      const acknowledgement: DeliveryAcknowledgement = { globalPosition: emission.sourceGlobalPosition, messageId: candidate?.messageId ?? `position:${emission.sourceGlobalPosition}` };
      if (!local && hasAcknowledged(cursor, acknowledgement)) {
        this.#incrementBelowCursorSuppression();
        continue;
      }
      if (incident !== undefined) {
        try { this.#recordIncident(incident); } catch { /* closed even if reporting fails */ }
        try { this.#incrementCausalityFailure(); } catch { /* closed even if alerting fails */ }
        blocked.push(`position:${emission.sourceGlobalPosition}`);
        continue;
      }
      if (candidate === undefined || earliest === undefined) throw new Error("Prepared scheduler entry is incomplete.");
      // Observer-local messages are live-only: a missed zero-staleness echo is
      // rebuilt by H1 snapshot, never resent stale by this scheduler.
      if (local ? now !== candidate.eventTimeMs : now < earliest) {
        deferred.push(candidate.messageId);
        continue;
      }
      const result = await this.#emit(candidate);
      if (!result.sent) {
        blocked.push(candidate.messageId);
        continue;
      }
      emitted.push(candidate.messageId);
      if (!local) {
        cursor = await this.#cursors.acknowledge(observerId, acknowledgement);
      }
    }
    return { emitted, deferred, blocked };
  }
}
