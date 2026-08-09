-- Browser capabilities only. VAPID private material and SMTP credentials stay in deny-listed host configuration.
CREATE TABLE notification_push_subscriptions (
  observer_id TEXT NOT NULL CHECK (length(observer_id) > 0),
  endpoint TEXT PRIMARY KEY CHECK (length(endpoint) > 0),
  p256dh TEXT NOT NULL CHECK (length(p256dh) > 0),
  auth TEXT NOT NULL CHECK (length(auth) > 0)
);

CREATE INDEX notification_push_subscriptions_observer_idx
  ON notification_push_subscriptions (observer_id, endpoint);
