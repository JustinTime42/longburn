-- Applied by deployment/CI, never by simulation code. The database is the
-- durable append-only record; stream seed is stored with its event history.
CREATE TABLE simulation_streams (
  stream_id TEXT PRIMARY KEY,
  seed BIGINT NOT NULL CHECK (seed >= 0 AND seed <= 4294967295),
  initial_time_ms BIGINT NOT NULL CHECK (initial_time_ms >= 0)
);

CREATE TABLE simulation_events (
  stream_id TEXT NOT NULL REFERENCES simulation_streams(stream_id),
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_time_ms BIGINT NOT NULL CHECK (event_time_ms >= 0),
  event_position JSONB NOT NULL,
  event JSONB NOT NULL,
  CHECK (jsonb_typeof(event_position) = 'object'),
  CHECK (jsonb_typeof(event) = 'object')
);

CREATE INDEX simulation_events_stream_sequence_idx ON simulation_events (stream_id, sequence);

CREATE FUNCTION reject_simulation_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'simulation event store is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER simulation_streams_no_update
  BEFORE UPDATE ON simulation_streams FOR EACH ROW EXECUTE FUNCTION reject_simulation_event_mutation();
CREATE TRIGGER simulation_streams_no_delete
  BEFORE DELETE ON simulation_streams FOR EACH ROW EXECUTE FUNCTION reject_simulation_event_mutation();
CREATE TRIGGER simulation_events_no_update
  BEFORE UPDATE ON simulation_events FOR EACH ROW EXECUTE FUNCTION reject_simulation_event_mutation();
CREATE TRIGGER simulation_events_no_delete
  BEFORE DELETE ON simulation_events FOR EACH ROW EXECUTE FUNCTION reject_simulation_event_mutation();
