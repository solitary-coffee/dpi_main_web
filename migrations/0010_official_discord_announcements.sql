ALTER TABLE newsletter_campaigns
    ADD COLUMN send_official_support INTEGER NOT NULL DEFAULT 0;

ALTER TABLE newsletter_campaigns
    ADD COLUMN official_mention_role_id TEXT NOT NULL DEFAULT '';

ALTER TABLE newsletter_campaigns
    ADD COLUMN official_message_id TEXT;
