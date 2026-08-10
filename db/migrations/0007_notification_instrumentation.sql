-- Host-side product telemetry. These records are not simulation events.
CREATE TABLE notification_instrumentation (
  record_type TEXT NOT NULL CHECK (record_type IN ('notificationDelivered', 'notificationOpened')),
  notification_id TEXT NOT NULL CHECK (length(notification_id) > 0),
  trigger_class TEXT NOT NULL CHECK (trigger_class IN ('N1', 'N2', 'N3', 'N4', 'N5', 'N6')),
  channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'in-app')),
  underlying_event_time_ms BIGINT NOT NULL CHECK (underlying_event_time_ms >= 0),
  earliest_permissible_instant_ms BIGINT NOT NULL CHECK (earliest_permissible_instant_ms >= 0),
  wall_clock_ms BIGINT NOT NULL CHECK (wall_clock_ms >= 0),
  PRIMARY KEY (record_type, notification_id)
);

CREATE INDEX notification_instrumentation_open_idx
  ON notification_instrumentation (trigger_class, record_type, wall_clock_ms);
