ALTER TABLE newsletter_campaigns
    ADD COLUMN recipient_groups TEXT NOT NULL DEFAULT 'subscribers';

ALTER TABLE newsletter_campaigns
    ADD COLUMN delivery_slots TEXT NOT NULL DEFAULT 'DPI_Bot通知';

ALTER TABLE newsletter_campaigns
    ADD COLUMN target_server_ids TEXT NOT NULL DEFAULT '';

ALTER TABLE newsletter_deliveries
    ADD COLUMN recipient_email TEXT;

ALTER TABLE newsletter_deliveries
    ADD COLUMN recipient_kind TEXT NOT NULL DEFAULT 'subscriber';

ALTER TABLE newsletter_deliveries
    ADD COLUMN recipient_reference TEXT;

UPDATE newsletter_deliveries
SET recipient_email = (
    SELECT email
    FROM newsletter_subscribers
    WHERE newsletter_subscribers.id = newsletter_deliveries.subscriber_id
)
WHERE recipient_email IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_delivery_recipient_email_idx
    ON newsletter_deliveries(campaign_id, lower(recipient_email))
    WHERE recipient_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_audit_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
    ON admin_audit_events(created_at DESC);
