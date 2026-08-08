import { earliestLegalEmissionTimeMs, type ObserverPositionAt, type PositionMeters } from "./causality.js";
import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { BurnNode } from "./event-log.js";
import type { StoredSimEvent } from "./event-store.js";

/**
 * A notification-worthy sim fact, deliberately before queueing, transport, or
 * product copy. `deliverAtMs` is the earliest instant the later delivery
 * system may act; it is always a simulation-clock instant.
 */
export type NotificationMoment =
  | {
    readonly id: string;
    readonly kind: "burnExecuted";
    readonly deliverAtMs: SimTimeMs;
    readonly sourceGlobalPosition: number;
    readonly eventTimeMs: SimTimeMs;
  }
  | {
    readonly id: string;
    readonly kind: "revisionApplied" | "revisionRefused";
    readonly commandId: string;
    readonly deliverAtMs: SimTimeMs;
    readonly sourceGlobalPosition: number;
    readonly eventTimeMs: SimTimeMs;
  }
  | {
    readonly id: string;
    readonly kind: "arrival";
    readonly destination: "earth" | "moon" | "mars";
    readonly deliverAtMs: SimTimeMs;
    readonly sourceGlobalPosition: number;
    readonly eventTimeMs: SimTimeMs;
  }
  | {
    readonly id: string;
    readonly kind: "transferWindowOpened";
    readonly windowId: string;
    readonly deliverAtMs: SimTimeMs;
  }
  | {
    readonly id: string;
    readonly kind: "lastRevisionInstant";
    readonly nodeId: string;
    readonly deliverAtMs: SimTimeMs;
  };

/** Stored-event identity plus the observer worldline required by the gate. */
export interface NotificationStoredEvent {
  readonly streamId: string;
  readonly event: StoredSimEvent;
}

/** Planner knowledge is local to HQ and therefore has no light lag. */
export interface TransferWindowOpening {
  readonly windowId: string;
  readonly opensAtMs: SimTimeMs;
}

/** A warning is local even though its subject is a remote command's light lag. */
export interface LastRevisionWarning {
  readonly nodeId: string;
  readonly lastRevisionAtMs: SimTimeMs;
}

export interface LastRevisionInstantInput {
  readonly executeAtMs: SimTimeMs;
  readonly hqPositionAt: (timeMs: SimTimeMs) => PositionMeters;
  readonly shipPositionAt: ObserverPositionAt;
}

const nonEmpty = (value: string, label: string): string => {
  if (value.length === 0) throw new RangeError(`${label} must be non-empty.`);
  return value;
};

const storedId = (stored: NotificationStoredEvent, kind: string): string => {
  nonEmpty(stored.streamId, "Notification stream ID");
  return `notification:stream:${encodeURIComponent(stored.streamId)}/event:${stored.event.streamSequence}/kind:${kind}`;
};

/**
 * Derives only remote report notifications. Its delivery instants are computed
 * by the causal emission gate's solver, against the stored event position.
 */
export const deriveReportNotifications = (
  storedEvents: readonly NotificationStoredEvent[],
  observerPositionAt: ObserverPositionAt
): NotificationMoment[] => storedEvents.flatMap<NotificationMoment>((stored) => {
  const { event } = stored;
  const deliverAtMs = (): SimTimeMs => simTimeMs(earliestLegalEmissionTimeMs({
    eventTime: event.eventTime,
    emissionTime: event.eventTime,
    eventPosition: event.eventPosition,
    observerPositionAt
  }));
  switch (event.event.type) {
    case "burnStarted":
      return [{ id: storedId(stored, "burnExecuted"), kind: "burnExecuted" as const, deliverAtMs: deliverAtMs(), sourceGlobalPosition: event.globalPosition, eventTimeMs: event.eventTime }];
    case "planRevisionApplied":
      return [{ id: storedId(stored, "revisionApplied"), kind: "revisionApplied" as const, commandId: event.event.commandId, deliverAtMs: deliverAtMs(), sourceGlobalPosition: event.globalPosition, eventTimeMs: event.eventTime }];
    case "planRevisionRefused":
      return [{ id: storedId(stored, "revisionRefused"), kind: "revisionRefused" as const, commandId: event.event.commandId, deliverAtMs: deliverAtMs(), sourceGlobalPosition: event.globalPosition, eventTimeMs: event.eventTime }];
    case "arrivalRecorded":
      return [{ id: storedId(stored, "arrival"), kind: "arrival" as const, destination: event.event.arrivalState.destination, deliverAtMs: deliverAtMs(), sourceGlobalPosition: event.globalPosition, eventTimeMs: event.eventTime }];
    default:
      return [];
  }
});

/** Observer-local triggers are due at their own HQ-known simulation instant. */
export const deriveLocalNotifications = (
  transferWindows: readonly TransferWindowOpening[],
  revisionWarnings: readonly LastRevisionWarning[]
): NotificationMoment[] => [
  ...transferWindows.map(({ windowId, opensAtMs }) => ({
    id: `notification:transfer-window:${encodeURIComponent(nonEmpty(windowId, "Transfer window ID"))}`,
    kind: "transferWindowOpened" as const,
    windowId,
    deliverAtMs: simTimeMs(opensAtMs)
  })),
  ...revisionWarnings.map(({ nodeId, lastRevisionAtMs }) => ({
    id: `notification:last-revision:${encodeURIComponent(nonEmpty(nodeId, "Burn node ID"))}`,
    kind: "lastRevisionInstant" as const,
    nodeId,
    deliverAtMs: simTimeMs(lastRevisionAtMs)
  }))
];

/**
 * Finds the final HQ instant at which a revision can reach a burn before it
 * executes. The inbound signal uses the same moving-receiver light-cone solve
 * as emissions, merely with HQ as the event source and the ship as receiver.
 * `undefined` means the burn is already causally unreachable from the start
 * of this simulation timeline.
 */
export const lastRevisionInstantMs = ({ executeAtMs, hqPositionAt, shipPositionAt }: LastRevisionInstantInput): SimTimeMs | undefined => {
  const reachesBeforeBurn = (issuedAtMs: number): boolean => {
    const issue = simTimeMs(issuedAtMs);
    return earliestLegalEmissionTimeMs({
      eventTime: issue,
      emissionTime: issue,
      eventPosition: hqPositionAt(issue),
      observerPositionAt: shipPositionAt
    }) < executeAtMs;
  };
  if (!reachesBeforeBurn(0)) return undefined;

  let lower: number = 0;
  let upper: number = executeAtMs;
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper + 1) / 2);
    if (reachesBeforeBurn(midpoint)) lower = midpoint;
    else upper = midpoint - 1;
  }
  return simTimeMs(lower);
};

/** Computes one local warning per pending burn that remains revisable. */
export const deriveLastRevisionWarnings = (
  nodes: readonly BurnNode[],
  input: Omit<LastRevisionInstantInput, "executeAtMs">
): LastRevisionWarning[] => nodes.flatMap((node) => {
  const lastRevisionAtMs = lastRevisionInstantMs({ ...input, executeAtMs: node.executeAtMs });
  return lastRevisionAtMs === undefined ? [] : [{ nodeId: node.nodeId, lastRevisionAtMs }];
});
