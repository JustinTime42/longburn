-- Durable per-message acknowledgements for light-lagged outbound messages.
-- Applied by deployment/CI, never by simulation code. This supersedes the
-- pre-durability single-watermark design; no production data migration exists.
CREATE TABLE delivery_cursors (
  observer_id TEXT PRIMARY KEY CHECK (length(observer_id) > 0),
  low_watermark BIGINT NOT NULL DEFAULT 0 CHECK (low_watermark >= 0)
);

CREATE TABLE delivery_acknowledgements (
  observer_id TEXT NOT NULL,
  global_position BIGINT NOT NULL CHECK (global_position > 0),
  message_id TEXT NOT NULL CHECK (length(message_id) > 0),
  PRIMARY KEY (observer_id, global_position),
  UNIQUE (observer_id, message_id)
);
