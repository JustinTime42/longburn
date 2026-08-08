import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
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

export interface EmittedMessage<C extends EmittedMessageClass = EmittedMessageClass> {
  /** Stable idempotence key; emission time is deliberately not part of it. */
  readonly messageId: string;
  readonly class: C;
  readonly payload: EmittedMessagePayloads[C];
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

/** Minimal persisted-event shape needed to construct an emitted envelope. */
export interface StoredEmissionEvent {
  readonly streamId: string;
  readonly streamSequence: number;
  readonly eventTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
}

export interface BuildEmittedMessage<C extends Exclude<EmittedMessageClass, "marketEvent" | "bodyEphemerides" | "liveShipPosition">> {
  readonly observerId: string;
  readonly event: StoredEmissionEvent;
  readonly class: C;
  readonly payload: EmittedMessagePayloads[C];
  readonly emissionTimeMs: SimTimeMs;
  readonly observerPosition: PositionMeters;
}

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

const assertPayload = (messageClass: EmittedMessageClass, payload: unknown): void => {
  if (messageClass === "shipReport") {
    if (typeof payload !== "object" || payload === null) throw new RangeError("Ship reports require a payload.");
    const report = payload as Partial<ShipReportPayload>;
    if ((report.event === "burnStarted" || report.event === "burnEnded") && isNonEmptyString(report.nodeId)) return;
    if (report.event === "arrivalRecorded" && (report.destination === "earth" || report.destination === "moon" || report.destination === "mars")) return;
    if (report.event === "departureRecorded") return;
    throw new RangeError("Ship reports require a catalog event payload.");
  }
  if (messageClass === "commandOutcomeReport") {
    if (typeof payload !== "object" || payload === null) throw new RangeError("Command outcome reports require a payload.");
    const outcome = payload as Partial<CommandOutcomeReportPayload>;
    if (outcome.outcome === "applied" && isNonEmptyString(outcome.commandId)) return;
    if (outcome.outcome === "refused" && isNonEmptyString(outcome.commandId) &&
      (outcome.reason === "executed-burn-conflict" || outcome.reason === "invalid-plan" || outcome.reason === "insufficient-propellant")) return;
    throw new RangeError("Command outcome reports require a catalog outcome payload.");
  }
  if (messageClass === "commandEcho") {
    if (typeof payload === "object" && payload !== null && isNonEmptyString((payload as CommandEchoPayload).commandId)) return;
    throw new RangeError("Command echoes require a command ID.");
  }
  if (messageClass === "simClock") {
    if (typeof payload === "object" && payload !== null && isSimTime((payload as SimClockPayload).currentTimeMs)) return;
    throw new RangeError("Sim-clock messages require a safe-integer current time.");
  }
  throw new RangeError(`${messageClass} is not an emitted T0 message class.`);
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
export const validateEmittedMessage = (message: unknown): EmittedMessage => {
  if (typeof message !== "object" || message === null) throw new RangeError("An emitted message must be an object.");
  const candidate = message as Partial<EmittedMessage>;
  const messageClass = candidate.class;
  if (messageClass !== "shipReport" && messageClass !== "commandOutcomeReport" && messageClass !== "commandEcho" &&
    messageClass !== "marketEvent" && messageClass !== "simClock" && messageClass !== "bodyEphemerides" && messageClass !== "liveShipPosition") {
    throw new RangeError("Emitted messages require a known catalog class.");
  }
  if (!isNonEmptyString(candidate.messageId)) throw new RangeError("Emitted messages require a message ID.");
  if (!isSimTime(candidate.eventTimeMs) || !isSimTime(candidate.emissionTimeMs) || candidate.emissionTimeMs < candidate.eventTimeMs) {
    throw new RangeError("Message provenance times must be non-negative safe-integer sim milliseconds.");
  }
  if (!Number.isSafeInteger(candidate.stalenessMs) || candidate.stalenessMs !== candidate.emissionTimeMs - candidate.eventTimeMs) {
    throw new RangeError("Message staleness must be the server-computed provenance difference.");
  }
  assertPayload(messageClass, candidate.payload);
  if ((messageClass === "commandEcho" || messageClass === "simClock") && candidate.emissionTimeMs !== candidate.eventTimeMs) {
    throw new RangeError(`${messageClass} is observer-local and must have zero staleness.`);
  }
  if (messageClass === "simClock" && (candidate.payload as SimClockPayload).currentTimeMs !== candidate.eventTimeMs) {
    throw new RangeError("Sim-clock payload time must equal its provenance event time.");
  }
  return {
    messageId: candidate.messageId,
    class: messageClass,
    payload: candidate.payload as never,
    eventTimeMs: simTimeMs(candidate.eventTimeMs),
    emissionTimeMs: simTimeMs(candidate.emissionTimeMs),
    eventPosition: copiedPosition(candidate.eventPosition),
    observerPosition: copiedPosition(candidate.observerPosition),
    stalenessMs: candidate.stalenessMs
  };
};

/** Creates an envelope by copying provenance from a stored event, never a resolver. */
export const buildEmittedMessage = <C extends Exclude<EmittedMessageClass, "marketEvent" | "bodyEphemerides" | "liveShipPosition">>(
  input: BuildEmittedMessage<C>
): EmittedMessage<C> => validateEmittedMessage({
  messageId: emittedMessageId(input.observerId, input.event, input.class),
  class: input.class,
  payload: input.payload,
  eventTimeMs: input.event.eventTime,
  emissionTimeMs: input.emissionTimeMs,
  eventPosition: copiedPosition(input.event.eventPosition),
  observerPosition: copiedPosition(input.observerPosition),
  stalenessMs: input.emissionTimeMs - input.event.eventTime
}) as EmittedMessage<C>;

/** Selects aggregate provenance from its youngest stored event, with log order breaking ties. */
export const youngestStoredEmissionEvent = (events: readonly StoredEmissionEvent[]): StoredEmissionEvent => {
  if (events.length === 0) throw new RangeError("An aggregate requires at least one stored event.");
  return events.reduce((youngest, event) =>
    event.eventTime > youngest.eventTime || (event.eventTime === youngest.eventTime && event.streamSequence > youngest.streamSequence)
      ? event
      : youngest
  );
};
