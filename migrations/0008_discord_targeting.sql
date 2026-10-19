ALTER TABLE newsletter_campaigns
    ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'delivery_slots';

ALTER TABLE newsletter_campaigns
    ADD COLUMN deduplicate_channels INTEGER NOT NULL DEFAULT 1;

UPDATE newsletter_campaigns
SET target_mode = 'intersection'
WHERE trim(target_server_ids) <> '';
