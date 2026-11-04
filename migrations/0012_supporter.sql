CREATE TABLE IF NOT EXISTS supporter_accounts (
 discord_user_id TEXT PRIMARY KEY,
 registered_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 settings_json TEXT NOT NULL DEFAULT '{"rules":[]}',
 revision INTEGER NOT NULL DEFAULT 0
);
