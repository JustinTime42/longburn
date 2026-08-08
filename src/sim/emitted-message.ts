import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { ObserverPositionAt, PositionMeters } from "./causality.js";
import type { PlanRevisionRefusalReason } from "./event-log.js";

/** The catalog's seven classes. The last three have no T0 message payload yet. */
export type EmittedMessageClass =
  | "shipReport"
  | "commandOutcomeReport"
  | "commandEcho"
  | "marketEvent"
  | "simClock"
  | "bodyEphemerides"
  | "liveShipPosition";

export type ShipReportPayload =
  | { readonly event: "burnStarted"; readonly nodeId: string }
  | { readonly event: "burnEnded"; readonly nodeId: string }
  | { readonly event: "arrivalRecorded"; readonly destination: "earth" | "moon" | "mars" }
  | { readonly event: "departureRecorded" };

export type CommandOutcomeReportPayload =
  | { readonly outcome: "applied"; readonly commandId: string }
  | { readonly outcome: "refused"; readonly commandId: string; readonly reason: PlanRevisionRefusalReason };

export interface CommandEchoPayload {
  readonly commandId: string;
}

export interface SimClockPayload {
  readonly currentTimeMs: SimTimeMs;
}

export interface EmittedMessagePayloads {
  readonly shipReport: ShipReportPayload;
  readonly commandOutcomeReport: CommandOutcomeReportPayload;
  readonly commandEcho: CommandEchoPayload;
  /** Reserved for din.6. The T0 schema deliberately cannot construct one. */
  readonly marketEvent: never;
  readonly simClock: SimClockPayload;
  /** Public deterministic client math, never an emitted message. */
  readonly bodyEphemerides: never;
  /** T0 intentionally has no live telemetry channel. */
  readonly liveShipPosition: never;
}

interface EmittedMessageBase {
  /** Stable idempotence key; emission time is deliberately not part of it. */
  readonly messageId: string;
  /** Authoritative recipient identity, used by per-observer delivery cursors. */
  readonly observerId: string;
  /** Youngest constituent stored event's virtual-clock time. */
  readonly eventTimeMs: SimTimeMs;
  /** Gate release time, supplied by the later scheduler/gate integration. */
  readonly emissionTimeMs: SimTimeMs;
  /** Copy of the event record's position, never a resolver result. */
  readonly eventPosition: PositionMeters;
  /** Observer worldline sampled at emissionTimeMs by the authoritative server. */
  readonly observerPosition: PositionMeters;
  /** Authoritative age, rendered but never calculated by the client. */
  readonly stalenessMs: number;
}

/**
 * A real discriminated union: narrowing `class` also narrows `payload`.
 * Reserved catalog classes retain `never` payloads, so T0 cannot construct one.
 */
export type EmittedMessage = {
  readonly [C in EmittedMessageClass]: EmittedMessageBase & {
    readonly class: C;
    readonly payload: EmittedMessagePayloads[C];
  };
}[EmittedMessageClass];

export type EmittableMessageClass = Exclude<EmittedMessageClass, "marketEvent" | "bodyEphemerides" | "liveShipPosition">;

/** The four catalog classes that Tier 0 can construct and send. */
export type EmittableMessage = Extract<EmittedMessage, { readonly class: EmittableMessageClass }>;

export type EmissionCandidate = {
  readonly [C in EmittableMessageClass]: Omit<Extract<EmittedMessage, { readonly class: C }>, "observerPosition" | "stalenessMs"> & {
    readonly observerPositionAt: ObserverPositionAt;
  };
}[EmittableMessageClass];

/** Minimal persisted-event shape needed to construct an emitted envelope. */
export interface StoredEmissionEvent {
  readonly streamId: string;
  readonly streamSequence: number;
  /** Global physical log order, used to break equal virtual-clock times. */
  readonly globalPosition: number;
  readonly eventTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
}

export type BuildEmittedMessage = {
  readonly [C in EmittableMessageClass]: {
    readonly observerId: string;
    readonly event: StoredEmissionEvent;
    readonly class: C;
    readonly payload: EmittedMessagePayloads[C];
    readonly emissionTimeMs: SimTimeMs;
    readonly observerPositionAt: ObserverPositionAt;
  };
}[EmittableMessageClass];

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isSimTime = (value: unknown): value is SimTimeMs => Number.isSafeInteger(value) && (value as number) >= 0;

const copiedPosition = (position: unknown): PositionMeters => {
  if (typeof position !== "object" || position === null) throw new RangeError("Message positions must be finite Cartesian coordinates.");
  const { x, y, z } = position as PositionMeters;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new RangeError("Message positions must be finite Cartesian coordinates.");
  }
  return { x, y, z };
};

const objectPayload = (payload: unknown, message: string): Record<string, unknown> => {
  if (typeof payload !== "object" || payload === null) throw new RangeError(message);
  return payload as Record<string, unknown>;
};

const shipReportPayload = (payload: unknown): ShipReportPayload => {
  const report = objectPayload(payload, "Ship reports require a payload.");
  if ((report.event === "burnStarted" || report.event === "burnEnded") && isNonEmptyString(report.nodeId)) return { event: report.event, nodeId: report.nodeId };
  if (report.event === "arrivalRecorded" && (report.destination === "earth" || report.destination === "moon" || report.destination === "mars")) return { event: report.event, destination: report.destination };
  if (report.event === "departureRecorded") return { event: report.event };
  throw new RangeError("Ship reports require a catalog event payload.");
};

const commandOutcomePayload = (payload: unknown): CommandOutcomeReportPayload => {
  const outcome = objectPayload(payload, "Command outcome reports require a payload.");
  if (outcome.outcome === "applied" && isNonEmptyString(outcome.commandId)) return { outcome: outcome.outcome, commandId: outcome.commandId };
  if (outcome.outcome === "refused" && isNonEmptyString(outcome.commandId) &&
    (outcome.reason === "executed-burn-conflict" || outcome.reason === "invalid-plan" || outcome.reason === "insufficient-propellant")) {
    return { outcome: outcome.outcome, commandId: outcome.commandId, reason: outcome.reason };
  }
  throw new RangeError("Command outcome reports require a catalog outcome payload.");
};

const commandEchoPayload = (payload: unknown): CommandEchoPayload => {
  const echo = objectPayload(payload, "Command echoes require a command ID.");
  if (!isNonEmptyString(echo.commandId)) throw new RangeError("Command echoes require a command ID.");
  return { commandId: echo.commandId };
};

const simClockPayload = (payload: unknown): SimClockPayload => {
  const clock = objectPayload(payload, "Sim-clock messages require a safe-integer current time.");
  if (!isSimTime(clock.currentTimeMs)) throw new RangeError("Sim-clock messages require a safe-integer current time.");
  return { currentTimeMs: simTimeMs(clock.currentTimeMs) };
};

/**
 * The idempotence key scheme is observer + stream + youngest event + class.
 * It is stable when a scheduler retries at a later emission tick.
 */
export const emittedMessageId = (
  observerId: string,
  event: Pick<StoredEmissionEvent, "streamId" | "streamSequence">,
  messageClass: EmittedMessageClass
): string => {
  if (!isNonEmptyString(observerId) || !isNonEmptyString(event.streamId) || !Number.isSafeInteger(event.streamSequence) || event.streamSequence < 1) {
    throw new RangeError("Message IDs require non-empty observer/stream IDs and a positive stream sequence.");
  }
  return `observer:${encodeURIComponent(observerId)}/stream:${encodeURIComponent(event.streamId)}/event:${event.streamSequence}/class:${messageClass}`;
};

/** Runtime boundary for decoded or unsafe-cast envelope data. */
export const validateEmittedMessage = (message: unknown): EmittableMessage => {
  if (typeof message !== "object" || message === null) throw new RangeError("An emitted message must be an object.");
  const candidate = message as Partial<EmittedMessage>;
  const messageClass = candidate.class;
  if (messageClass !== "shipReport" && messageClass !== "commandOutcomeReport" && messageClass !== "commandEcho" &&
    messageClass !== "marketEvent" && messageClass !== "simClock" && messageClass !== "bodyEphemerides" && messageClass !== "liveShipPosition") {
    throw new RangeError("Emitted messages require a known catalog class.");
  }
  if (!isNonEmptyString(candidate.messageId) || !isNonEmptyString(candidate.observerId)) throw new RangeError("Emitted messages require message and observer IDs.");
  if (!isSimTime(candidate.eventTimeMs) || !isSimTime(candidate.emissionTimeMs) || candidate.emissionTimeMs < candidate.eventTimeMs) {
    throw new RangeError("Message provenance times must be non-negative safe-integer sim milliseconds.");
  }
  if (!Number.isSafeInteger(candidate.stalenessMs) || candidate.stalenessMs !== candidate.emissionTimeMs - candidate.eventTimeMs) {
    throw new RangeError("Message staleness must be the server-computed provenance difference.");
  }
  if ((messageClass === "commandEcho" || messageClass === "simClock") && candidate.emissionTimeMs !== candidate.eventTimeMs) {
    throw new RangeError(`${messageClass} is observer-local and must have zero staleness.`);
  }
  const base = {
    messageId: candidate.messageId,
    observerId: candidate.observerId,
    eventTimeMs: simTimeMs(candidate.eventTimeMs),
    emissionTimeMs: simTimeMs(candidate.emissionTimeMs),
    eventPosition: copiedPosition(candidate.eventPosition),
    observerPosition: copiedPosition(candidate.observerPosition),
    stalenessMs: candidate.stalenessMs
  };
  switch (messageClass) {
    case "shipReport": return { ...base, class: messageClass, payload: shipReportPayload(candidate.payload) };
    case "commandOutcomeReport": return { ...base, class: messageClass, payload: commandOutcomePayload(candidate.payload) };
    case "commandEcho": return { ...base, class: messageClass, payload: commandEchoPayload(candidate.payload) };
    case "simClock": {
      const payload = simClockPayload(candidate.payload);
      if (payload.currentTimeMs !== candidate.eventTimeMs) throw new RangeError("Sim-clock payload time must equal its provenance event time.");
      return { ...base, class: messageClass, payload };
    }
    case "marketEvent":
    case "bodyEphemerides":
    case "liveShipPosition":
      throw new RangeError(`${messageClass} is not an emitted T0 message class.`);
  }
};

/** Creates gate input by copying provenance from a stored event, never a resolver. */
export const buildEmittedMessage = (input: BuildEmittedMessage): EmissionCandidate => {
  const base = {
    messageId: emittedMessageId(input.observerId, input.event, input.class),
    observerId: input.observerId,
    eventTimeMs: input.event.eventTime,
    emissionTimeMs: input.emissionTimeMs,
    eventPosition: copiedPosition(input.event.eventPosition),
    observerPositionAt: input.observerPositionAt
  };
  switch (input.class) {
    case "shipReport": return { ...base, class: input.class, payload: input.payload };
    case "commandOutcomeReport": return { ...base, class: input.class, payload: input.payload };
    case "commandEcho": return { ...base, class: input.class, payload: input.payload };
    case "simClock": return { ...base, class: input.class, payload: input.payload };
    default: {
      const unhandled: never = input;
      const unhandledClass = (unhandled as { readonly class: unknown }).class;
      throw new RangeError(`Cannot build an emitted message from class ${String(unhandledClass)}.`);
    }
  }
};

/** Selects aggregate provenance from its youngest stored event, with log order breaking ties. */
export const youngestStoredEmissionEvent = (events: readonly StoredEmissionEvent[]): StoredEmissionEvent => {
  if (events.length === 0) throw new RangeError("An aggregate requires at least one stored event.");
  return events.reduce((youngest, event) =>
    event.eventTime > youngest.eventTime || (event.eventTime === youngest.eventTime && event.globalPosition > youngest.globalPosition)
      ? event
      : youngest
  );
};
