import { CausalityInvariantViolation, earliestLegalEmissionTimeMs, type CausalityIncident, type EmissionResult } from "./causality.js";
import type { SimTimeMs } from "./clock.js";
import type { DeliveryCursorStore } from "./delivery-cursor.js";
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
 * per observer; cursor compare-and-advance is conflict detection, not a lock.
 */
export interface EmissionSchedulerOptions {
  readonly cursors: DeliveryCursorStore;
  /** E3 supplies the causal gate plus real transport acknowledgement here. */
  readonly emit: (candidate: EmissionCandidate) => Promise<EmissionResult>;
  /** Scheduler-side failures happen before the gate, but are equally closed. */
  readonly recordIncident: (incident: CausalityIncident) => void;
  readonly incrementCausalityFailure: () => void;
  /**
   * Records every light-lagged emission suppressed by an existing delivery
   * cursor. This is a delivery-integrity counter, not a causality failure:
   * increments expose a caller that presented already-acknowledged work.
   */
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
 * both emit before either observes the other's cursor advance; the Postgres
 * cursor detects the losing advance, but does not make emission single-writer.
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
   * observer on every pass, in strictly ascending sourceGlobalPosition order.
   * The scheduler cannot infer an omitted event because global positions may
   * legitimately have gaps. A later presentation below the cursor is counted
   * by incrementBelowCursorSuppression so that such a precondition violation
   * cannot remain indistinguishable from ordinary duplicate suppression.
   */
  async run(observerId: string, now: SimTimeMs, scheduled: readonly ScheduledEmission[]): Promise<SchedulerRunResult> {
    const lightLaggedPositions = new Set<number>();
    let previousSourceGlobalPosition: number | undefined;
    for (const emission of scheduled) {
      validSourcePosition(emission);
      if (emission.message.observerId !== observerId) throw new RangeError("Scheduled emission observer does not match scheduler observer.");
      if (previousSourceGlobalPosition !== undefined && emission.sourceGlobalPosition <= previousSourceGlobalPosition) {
        throw new RangeError("Scheduled emissions must be strictly ascending by source global position.");
      }
      previousSourceGlobalPosition = emission.sourceGlobalPosition;
      if (isLightLaggedMessageClass(emission.message.class)) {
        if (lightLaggedPositions.has(emission.sourceGlobalPosition)) {
          throw new RangeError("One stored event cannot advance a delivery cursor more than once.");
        }
        lightLaggedPositions.add(emission.sourceGlobalPosition);
      }
    }
    const cursor = await this.#cursors.read(observerId);
    const emitted: string[] = [];
    const deferred: string[] = [];
    const blocked: string[] = [];

    for (const emission of scheduled) {
      const local = !isLightLaggedMessageClass(emission.message.class);
      if (!local && cursor !== undefined && emission.sourceGlobalPosition <= cursor.globalPosition) {
        this.#incrementBelowCursorSuppression();
        continue;
      }
      let candidate: EmissionCandidate;
      let earliest: number;
      try {
        candidate = buildEmittedMessage({ ...emission.message, emissionTimeMs: now } as BuildEmittedMessage);
        earliest = earliestLegalEmissionTimeMs({
          eventTime: candidate.eventTimeMs,
          emissionTime: candidate.emissionTimeMs,
          eventPosition: candidate.eventPosition,
          observerPositionAt: candidate.observerPositionAt
        });
      } catch (error: unknown) {
        const incident = error instanceof CausalityInvariantViolation
          ? error.incident
          : { reason: "invalid-position" as const, provenance: { eventTime: emission.message.event.eventTime, eventPosition: emission.message.event.eventPosition } };
        try { this.#recordIncident(incident); } catch { /* closed even if reporting fails */ }
        try { this.#incrementCausalityFailure(); } catch { /* closed even if alerting fails */ }
        blocked.push(`position:${emission.sourceGlobalPosition}`);
        if (!local) break;
        continue;
      }
      // Observer-local messages are live-only: a missed zero-staleness echo is
      // rebuilt by H1 snapshot, never resent stale by this scheduler.
      if (local ? now !== candidate.eventTimeMs : now < earliest) {
        deferred.push(candidate.messageId);
        if (!local) break;
        continue;
      }
      const result = await this.#emit(candidate);
      if (!result.sent) {
        blocked.push(candidate.messageId);
        if (!local) break;
        continue;
      }
      emitted.push(candidate.messageId);
      if (!local) {
        await this.#cursors.advance({ observerId, globalPosition: emission.sourceGlobalPosition, messageId: candidate.messageId });
      }
    }
    return { emitted, deferred, blocked };
  }
}
