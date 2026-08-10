-- The epoch is an immutable replay input for ephemeris-backed resolvers.
-- Existing streams cannot reconstruct an epoch from their durable events, so
-- they remain NULL and Tier 0 resume rejects them rather than guessing.
ALTER TABLE simulation_streams
  ADD COLUMN epoch_ut_days_since_j2000 DOUBLE PRECISION;

ALTER TABLE simulation_streams
  ADD CONSTRAINT simulation_streams_epoch_is_finite CHECK (
    epoch_ut_days_since_j2000 IS NULL
    OR (epoch_ut_days_since_j2000 <> 'Infinity'::double precision
        AND epoch_ut_days_since_j2000 <> '-Infinity'::double precision
        AND epoch_ut_days_since_j2000 = epoch_ut_days_since_j2000)
  );
