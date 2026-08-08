-- Durable acknowledgement watermarks for light-lagged outbound messages.
-- Applied by deployment/CI, never by simulation code.
CREATE TABLE delivery_cursors (
  observer_id TEXT PRIMARY KEY CHECK (length(observer_id) > 0),
  global_position BIGINT NOT NULL CHECK (global_position > 0),
  message_id TEXT NOT NULL CHECK (length(message_id) > 0)
);
