import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import type { EmissionCandidate } from "../sim/emitted-message.js";
import { CausalStateEgress } from "./causal-state-egress.js";

const candidate = (emissionTimeMs: number, observerId = "player-1"): EmissionCandidate => ({
  messageId: "message-1",
  observerId,
  class: "shipReport",
  payload: { event: "departureRecorded" },
  eventTimeMs: simTimeMs(0),
  emissionTimeMs: simTimeMs(emissionTimeMs),
  eventPosition: { x: 0, y: 0, z: 0 },
  observerPositionAt: () => ({ x: 299_792_458, y: 0, z: 0 })
});

describe("causal state egress", () => {
  it("releases WebSocket subscription state only through CausalEmissionGate", () => {
    const writeText = vi.fn();
    const egress = new CausalStateEgress({ recordIncident: vi.fn(), incrementCausalityFailure: vi.fn() });
    const subscription = egress.subscribe("player-1", { writeText });

    expect(subscription.emit(candidate(999))).toEqual({ sent: false, reason: "early-emission" });
    expect(writeText).not.toHaveBeenCalled();
    expect(subscription.emit(candidate(1_000))).toEqual({ sent: true });
    expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      messageId: "message-1", observerId: "player-1", stalenessMs: 1_000
    });
  });

  it("refuses an envelope addressed to a different observer before it reaches the socket", () => {
    const writeText = vi.fn();
    const egress = new CausalStateEgress({ recordIncident: vi.fn(), incrementCausalityFailure: vi.fn() });
    const subscription = egress.subscribe("player-2", { writeText });

    expect(subscription.emit(candidate(1_000, "player-1"))).toEqual({ sent: false, reason: "observer-mismatch" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("requires a non-empty observer identity when creating a subscription", () => {
    const egress = new CausalStateEgress({ recordIncident: vi.fn(), incrementCausalityFailure: vi.fn() });

    expect(() => egress.subscribe("", { writeText: vi.fn() })).toThrow("non-empty observer ID");
  });

  it("releases a REST snapshot only through CausalEmissionGate", () => {
    const writeJson = vi.fn();
    const egress = new CausalStateEgress({ recordIncident: vi.fn(), incrementCausalityFailure: vi.fn() });

    expect(egress.snapshot({ writeJson }, candidate(999))).toEqual({ sent: false, reason: "early-emission" });
    expect(writeJson).not.toHaveBeenCalled();
    expect(egress.snapshot({ writeJson }, candidate(1_000))).toEqual({ sent: true });
    expect(writeJson).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message-1", observerId: "player-1", stalenessMs: 1_000
    }));
  });
});
