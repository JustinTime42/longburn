-- Supersede 0003's single-watermark cursor before durable deployments exist.
-- Re-runnable by design: no production cursor data exists to preserve yet.
DROP TABLE IF EXISTS delivery_acknowledgements;
DROP TABLE IF EXISTS delivery_cursors;

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
