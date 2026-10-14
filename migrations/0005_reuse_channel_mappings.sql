ALTER TABLE reuse_applications
ADD COLUMN channel_mappings TEXT NOT NULL DEFAULT '[]';
