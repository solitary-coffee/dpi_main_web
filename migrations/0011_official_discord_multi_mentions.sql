ALTER TABLE newsletter_campaigns
    ADD COLUMN send_registered_webhooks INTEGER NOT NULL DEFAULT 1;

ALTER TABLE newsletter_campaigns
    ADD COLUMN official_mention_role_ids TEXT NOT NULL DEFAULT '';

ALTER TABLE newsletter_campaigns
    ADD COLUMN official_mention_message_id TEXT;

UPDATE newsletter_campaigns
SET official_mention_role_ids = official_mention_role_id
WHERE trim(official_mention_role_ids) = ''
  AND trim(official_mention_role_id) <> '';
