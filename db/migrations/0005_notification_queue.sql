-- Durable host-side notification queue. Applied by deployment/CI, never by simulation code.
-- Delivered rows are retained until din.11 decides the cadence/retention policy.
CREATE TABLE notification_queue (
  notification_id TEXT PRIMARY KEY CHECK (length(notification_id) > 0),
  deliver_at_sim_ms BIGINT NOT NULL CHECK (deliver_at_sim_ms >= 0),
  notification JSONB NOT NULL CHECK (jsonb_typeof(notification) = 'object'),
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at_wall_clock_ms BIGINT CHECK (delivered_at_wall_clock_ms >= 0)
);

CREATE INDEX notification_queue_due_idx
  ON notification_queue (deliver_at_sim_ms, notification_id)
  WHERE delivered_at_wall_clock_ms IS NULL;
