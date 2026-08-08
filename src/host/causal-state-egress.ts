import {
  CausalEmissionGate,
  type CausalEmissionGateOptions,
  type EmissionResult
} from "../sim/causality.js";
import type { EmissionCandidate, EmittableMessage } from "../sim/emitted-message.js";

/** Raw WebSocket surface accepted only while a subscription is created. */
export interface WebSocketStateConnection {
  writeText(payload: string): void;
}

/** Raw REST response surface accepted only while a snapshot is released. */
export interface RestSnapshotResponse {
  writeJson(body: EmittableMessage): void;
}

export type CausalEgressHooks = Pick<
  CausalEmissionGateOptions,
  "recordIncident" | "incrementCausalityFailure"
>;

/** A refusal made by the egress boundary before a candidate reaches its gate. */
export type CausalStateEgressEmissionResult =
  | EmissionResult
  | { readonly sent: false; readonly reason: "observer-mismatch" };

/** A live subscription has no raw socket capability, only the causal gate. */
export interface CausalStateSubscription {
  emit(candidate: EmissionCandidate): CausalStateEgressEmissionResult;
}

/**
 * Tier 0's complete server egress boundary. Raw socket/response capabilities
 * are captured only by a CausalEmissionGate callback. Every public egress
 * operation accepts a candidate, so each attempted write rechecks provenance.
 */
export class CausalStateEgress {
  readonly #hooks: CausalEgressHooks;

  constructor(hooks: CausalEgressHooks) {
    this.#hooks = hooks;
  }

  subscribe(observerId: string, socket: WebSocketStateConnection): CausalStateSubscription {
    if (observerId.length === 0) throw new RangeError("Subscriptions require a non-empty observer ID.");
    const gate = new CausalEmissionGate({
      ...this.#hooks,
      send: (message) => socket.writeText(JSON.stringify(message))
    });
    return {
      emit: (candidate) => candidate.observerId === observerId
        ? gate.emit(candidate)
        : { sent: false, reason: "observer-mismatch" }
    };
  }

  snapshot(response: RestSnapshotResponse, candidate: EmissionCandidate): EmissionResult {
    return new CausalEmissionGate({
      ...this.#hooks,
      send: (message) => response.writeJson(message)
    }).emit(candidate);
  }
}
