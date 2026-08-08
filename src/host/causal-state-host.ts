import type { ObserverPositionAt } from "../sim/causality.js";
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
 * events have no player-visible projection; a command outcome without its
 * durable command identity is rejected rather than emitted ambiguously.
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
        return { ...base, class: "commandEcho" as const, payload: { commandId: stored.event.event.commandId }, observerPositionAt };
      case "planRevisionApplied":
        if (stored.event.event.commandId === undefined) throw new RangeError("Projected command outcomes require a durable command ID.");
        return { ...base, class: "commandOutcomeReport" as const, payload: { outcome: "applied" as const, commandId: stored.event.event.commandId }, observerPositionAt };
      case "planRevisionRefused":
        if (stored.event.event.commandId === undefined) throw new RangeError("Projected command outcomes require a durable command ID.");
        return {
          ...base,
          class: "commandOutcomeReport" as const,
          payload: { outcome: "refused" as const, commandId: stored.event.event.commandId, reason: stored.event.event.reason },
          observerPositionAt
        };
      case "clockAdvanced":
      case "randomValueRequested":
        return undefined;
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

  constructor({ cursors, observerId, observerPositionAt, socket, recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression }: CausalStateHostOptions) {
    const egress = new CausalStateEgress({ recordIncident, incrementCausalityFailure });
    const subscription = egress.subscribe(observerId, socket);
    this.#observerId = observerId;
    this.#observerPositionAt = observerPositionAt;
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

  run(now: SimTimeMs, storedEvents: readonly StoredEventForEmission[]): Promise<SchedulerRunResult> {
    const scheduled = storedEvents.flatMap((stored) => {
      const projected = projectStoredEvent(this.#observerId, this.#observerPositionAt, stored);
      return projected === undefined ? [] : [projected];
    });
    return this.#scheduler.run(this.#observerId, now, scheduled);
  }
}
