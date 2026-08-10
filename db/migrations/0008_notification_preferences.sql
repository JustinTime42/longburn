-- Per-tester product choices. Defaults are applied by the host when no row exists.
CREATE TABLE notification_preferences (
  observer_id TEXT PRIMARY KEY CHECK (length(observer_id) > 0),
  preferences JSONB NOT NULL CHECK (jsonb_typeof(preferences) = 'object')
);
