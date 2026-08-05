-- `sequence` remains the global, physical identity used for subscriptions.
-- `stream_sequence` is the contiguous one-based logical ordering for replay.
ALTER TABLE simulation_events ADD COLUMN stream_sequence BIGINT;

-- This is an upgrade migration: the append-only trigger protects application
-- traffic, while this one-time migration derives the immutable logical order
-- for rows that predate the column. Migration runners execute this atomically.
ALTER TABLE simulation_events DISABLE TRIGGER simulation_events_no_update;
WITH numbered_events AS (
  SELECT ctid,
         ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence) AS stream_sequence
  FROM simulation_events
)
UPDATE simulation_events
SET stream_sequence = numbered_events.stream_sequence
FROM numbered_events
WHERE simulation_events.ctid = numbered_events.ctid;
ALTER TABLE simulation_events ENABLE TRIGGER simulation_events_no_update;

ALTER TABLE simulation_events ALTER COLUMN stream_sequence SET NOT NULL;
ALTER TABLE simulation_events
  ADD CONSTRAINT simulation_events_stream_sequence_unique UNIQUE (stream_id, stream_sequence);
