ALTER TABLE newsletter_campaigns
    ADD COLUMN delivery_format TEXT NOT NULL DEFAULT 'message';

ALTER TABLE newsletter_campaigns
    ADD COLUMN embed_color INTEGER NOT NULL DEFAULT 5793266;

ALTER TABLE newsletter_campaigns
    ADD COLUMN image_url TEXT;

ALTER TABLE newsletter_campaigns
    ADD COLUMN image_name TEXT;

ALTER TABLE newsletter_campaigns
    ADD COLUMN image_type TEXT;

ALTER TABLE newsletter_campaigns
    ADD COLUMN image_data BLOB;

ALTER TABLE newsletter_campaigns
    ADD COLUMN image_alt TEXT;
