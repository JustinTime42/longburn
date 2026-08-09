import type { ObserverPositionAt, PositionMeters } from "../sim/causality.js";
import type { SimTimeMs } from "../sim/clock.js";
import type { BurnNode } from "../sim/event-log.js";
import { deriveLastRevisionWarnings, deriveLocalNotifications, type NotificationMoment } from "../sim/notification-derivation.js";

/**
 * The HQ-local paper worldline, constructed from command echoes and received
 * outcome reports only. It deliberately cannot expose authoritative state:
 * recalculating a warning after an unknown refusal must not leak that refusal.
 */
export interface PaperProjectionProvider {
  shipPositionAt: ObserverPositionAt;
}

/** Narrow queue input so plan-change derivation stays independent of transport. */
export interface NotificationMomentSink {
  reconcilePendingLastRevisionWarnings(warnings: readonly NotificationMoment[]): Promise<void>;
}

export interface PlanChangeNotificationOptions {
  readonly sink: NotificationMomentSink;
  readonly hqPositionAt: (timeMs: SimTimeMs) => PositionMeters;
  readonly paperProjection: PaperProjectionProvider;
}

/**
 * Invoke only after a plan-change event. It recomputes the planner-local
 * warnings then, never on host ticks; `nowMs` removes deadlines already past.
 */
export const enqueuePlanChangeWarnings = async (
  nodes: readonly BurnNode[],
  nowMs: SimTimeMs,
  { sink, hqPositionAt, paperProjection }: PlanChangeNotificationOptions
): Promise<void> => {
  const warnings = deriveLastRevisionWarnings(nodes, {
    nowMs,
    hqPositionAt,
    shipPositionAt: paperProjection.shipPositionAt
  });
  await sink.reconcilePendingLastRevisionWarnings(deriveLocalNotifications([], warnings));
};
