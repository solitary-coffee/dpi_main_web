ALTER TABLE ip_block_rules
    ADD COLUMN block_level TEXT NOT NULL DEFAULT 'suspected'
    CHECK (block_level IN ('suspected', 'confirmed'));

ALTER TABLE ip_block_audit
    ADD COLUMN block_level TEXT NOT NULL DEFAULT 'suspected'
    CHECK (block_level IN ('suspected', 'confirmed'));
