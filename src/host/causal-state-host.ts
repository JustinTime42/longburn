import type { CausalityIncident, ObserverPositionAt } from "../sim/causality.js";
import type { SimTimeMs } from "../sim/clock.js";
import type { DeliveryCursorStore } from "../sim/delivery-cursor.js";
import type { StoredSimEvent } from "../sim/event-store.js";
import type { BuildEmittedMessage } from "../sim/emitted-message.js";
import { EmissionScheduler, type SchedulerRunResult, type ScheduledEmission } from "../sim/emission-scheduler.js";
import { CausalStateEgress, type CausalEgressHooks, type WebSocketStateConnection } from "./causal-state-egress.js";

/** A persisted event paired with its stream identity, which the event row does not repeat. */
export interface StoredEventForEmission {
  readonly streamId: string;
  readonly event: StoredSimEvent;
}

export interface CausalStateHostOptions extends CausalEgressHooks {
  readonly cursors: DeliveryCursorStore;
  readonly observerId: string;
  readonly observerPositionAt: ObserverPositionAt;
  /** Captured only while the observer-bound egress subscription is created. */
  readonly socket: WebSocketStateConnection;
  readonly incrementBelowCursorSuppression: () => void;
}

const storedEnvelope = (observerId: string, stored: StoredEventForEmission): Omit<BuildEmittedMessage, "class" | "payload" | "emissionTimeMs" | "observerPositionAt"> => ({
  observerId,
  event: {
    streamId: stored.streamId,
    streamSequence: stored.event.streamSequence,
    globalPosition: stored.event.globalPosition,
    eventTime: stored.event.eventTime,
    eventPosition: stored.event.eventPosition
  }
});

/**
 * Projects T0's catalog-backed stored facts into scheduler input. Unsupported
 * events have no player-visible projection. Command echoes are observer-local
 * state rebuilt by H1's reconnect snapshot, so durable replay omits them.
 */
export const projectStoredEvent = (
  observerId: string,
  observerPositionAt: ObserverPositionAt,
  stored: StoredEventForEmission
): ScheduledEmission | undefined => {
  if (stored.streamId.length === 0) throw new RangeError("Stored emission events require a non-empty stream ID.");
  const base = storedEnvelope(observerId, stored);
  const message = (() => {
    switch (stored.event.event.type) {
      case "departureRecorded":
        return { ...base, class: "shipReport" as const, payload: { event: "departureRecorded" as const }, observerPositionAt };
      case "arrivalRecorded":
        return {
          ...base,
          class: "shipReport" as const,
          payload: { event: "arrivalRecorded" as const, destination: stored.event.event.arrivalState.destination },
          observerPositionAt
        };
      case "burnStarted":
        return { ...base, class: "shipReport" as const, payload: { event: "burnStarted" as const, nodeId: stored.event.event.node.nodeId }, observerPositionAt };
      case "burnEnded":
        return { ...base, class: "shipReport" as const, payload: { event: "burnEnded" as const, nodeId: stored.event.event.nodeId }, observerPositionAt };
      case "commandIssued":
        return undefined;
      case "planRevisionApplied":
        return { ...base, class: "commandOutcomeReport" as const, payload: { outcome: "applied" as const, commandId: stored.event.event.commandId }, observerPositionAt };
      case "planRevisionRefused":
        return {
          ...base,
          class: "commandOutcomeReport" as const,
          payload: { outcome: "refused" as const, commandId: stored.event.event.commandId, reason: stored.event.event.reason },
          observerPositionAt
        };
      case "clockAdvanced":
      case "randomValueRequested":
        return undefined;
      default: {
        const unhandled: never = stored.event.event;
        const unhandledType = (unhandled as { readonly type: unknown }).type;
        throw new RangeError(`Cannot project stored event ${String(unhandledType)}.`);
      }
    }
  })();
  return message === undefined ? undefined : { sourceGlobalPosition: stored.event.globalPosition, message };
};

/**
 * Production host-side composition for one observer. Stored event facts are
 * projected once, scheduled with explicit sim time, then delivered through an
 * observer-bound causal egress. The adapter narrows the egress-only mismatch
 * refusal before it reaches EmissionScheduler's gate-result contract.
 */
export class CausalStateHost {
  readonly #observerId: string;
  readonly #observerPositionAt: ObserverPositionAt;
  readonly #scheduler: EmissionScheduler;
  readonly #recordIncident: (incident: CausalityIncident) => void;
  readonly #incrementCausalityFailure: () => void;

  constructor({ cursors, observerId, observerPositionAt, socket, recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression }: CausalStateHostOptions) {
    const egress = new CausalStateEgress({ recordIncident, incrementCausalityFailure });
    const subscription = egress.subscribe(observerId, socket);
    this.#observerId = observerId;
    this.#observerPositionAt = observerPositionAt;
    this.#recordIncident = recordIncident;
    this.#incrementCausalityFailure = incrementCausalityFailure;
    this.#scheduler = new EmissionScheduler({
      cursors,
      emit: async (candidate) => {
        const result = subscription.emit(candidate);
        if (!result.sent && result.reason === "observer-mismatch") {
          throw new Error("Causal state host projected an emission for the wrong observer.");
        }
        return result;
      },
      recordIncident,
      incrementCausalityFailure,
      incrementBelowCursorSuppression
    });
  }

  async run(now: SimTimeMs, storedEvents: readonly StoredEventForEmission[]): Promise<SchedulerRunResult> {
    const scheduled: ScheduledEmission[] = [];
    const blocked: string[] = [];
    for (const [index, stored] of storedEvents.entries()) {
      try {
        const projected = projectStoredEvent(this.#observerId, this.#observerPositionAt, stored);
        if (projected !== undefined) scheduled.push(projected);
      } catch {
        const globalPosition = this.#projectionPosition(stored, index);
        this.#recordProjectionFailure(stored);
        blocked.push(`position:${globalPosition}`);
      }
    }
    const result = await this.#scheduler.run(this.#observerId, now, scheduled);
    return { ...result, blocked: [...blocked, ...result.blocked] };
  }

  #projectionPosition(stored: StoredEventForEmission, index: number): number | string {
    try {
      const position = stored.event.globalPosition;
      return Number.isSafeInteger(position) && position > 0 ? position : `projection:${index}`;
    } catch {
      return `projection:${index}`;
    }
  }

  #recordProjectionFailure(stored: StoredEventForEmission): void {
    let eventTime: unknown;
    let eventPosition: CausalityIncident["provenance"]["eventPosition"];
    try {
      eventTime = stored.event.eventTime;
      const storedPosition = stored.event.eventPosition;
      if (storedPosition !== undefined && Number.isFinite(storedPosition.x) && Number.isFinite(storedPosition.y) && Number.isFinite(storedPosition.z)) {
        eventPosition = { x: storedPosition.x, y: storedPosition.y, z: storedPosition.z };
      }
    } catch { /* malformed records must not make reporting unsafe */ }
    const provenance: CausalityIncident["provenance"] = {
      ...(eventTime === undefined ? {} : { eventTime }),
      ...(eventPosition === undefined ? {} : { eventPosition })
    };
    try { this.#recordIncident({ reason: "invalid-envelope", provenance }); } catch { /* closed even if reporting fails */ }
    try { this.#incrementCausalityFailure(); } catch { /* closed even if alerting fails */ }
  }
}
