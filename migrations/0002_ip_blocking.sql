CREATE TABLE IF NOT EXISTS ip_block_rules (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL UNIQUE COLLATE NOCASE,
    reason TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ip_block_rules_enabled_idx
    ON ip_block_rules(enabled, created_at);

CREATE TABLE IF NOT EXISTS ip_block_audit (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
    rule_id TEXT NOT NULL,
    network TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    actor_subject TEXT,
    actor_ip TEXT,
    ray_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ip_block_audit_created_idx
    ON ip_block_audit(created_at DESC);
