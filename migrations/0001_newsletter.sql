CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'pending',
    categories TEXT NOT NULL DEFAULT '',
    pending_categories TEXT,
    consent_version TEXT,
    pending_consent_version TEXT,
    consent_at TEXT,
    confirmed_at TEXT,
    unsubscribed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmation_token_hash TEXT,
    confirmation_expires_at TEXT,
    last_confirmation_sent_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_confirmation_token_idx
    ON newsletter_subscribers(confirmation_token_hash)
    WHERE confirmation_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS newsletter_subscriber_status_idx
    ON newsletter_subscribers(status);

CREATE TABLE IF NOT EXISTS newsletter_rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS newsletter_rate_events_lookup_idx
    ON newsletter_rate_events(key_hash, event_type, created_at);

CREATE TABLE IF NOT EXISTS newsletter_campaigns (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS newsletter_campaign_status_idx
    ON newsletter_campaigns(status, created_at);

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    message_id TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    queued_at TEXT,
    sent_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(campaign_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS newsletter_delivery_campaign_idx
    ON newsletter_deliveries(campaign_id, status);

CREATE INDEX IF NOT EXISTS newsletter_delivery_subscriber_idx
    ON newsletter_deliveries(subscriber_id);
