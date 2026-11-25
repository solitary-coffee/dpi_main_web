CREATE TABLE IF NOT EXISTS supporter_discord_roles (
 discord_user_id TEXT NOT NULL,
 role_id TEXT NOT NULL,
 status TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 last_error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (discord_user_id, role_id),
 FOREIGN KEY (discord_user_id) REFERENCES supporter_accounts(discord_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS supporter_discord_roles_status_idx ON supporter_discord_roles(status, updated_at);
