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

/** A live subscription has no raw socket capability, only the causal gate. */
export interface CausalStateSubscription {
  emit(candidate: EmissionCandidate): EmissionResult;
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

  subscribe(socket: WebSocketStateConnection): CausalStateSubscription {
    const gate = new CausalEmissionGate({
      ...this.#hooks,
      send: (message) => socket.writeText(JSON.stringify(message))
    });
    return { emit: (candidate) => gate.emit(candidate) };
  }

  snapshot(response: RestSnapshotResponse, candidate: EmissionCandidate): EmissionResult {
    return new CausalEmissionGate({
      ...this.#hooks,
      send: (message) => response.writeJson(message)
    }).emit(candidate);
  }
}
