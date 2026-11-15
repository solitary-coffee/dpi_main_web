CREATE TABLE IF NOT EXISTS supporter_disciplinary_actions (
 request_id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 action TEXT NOT NULL CHECK(action IN ('disciplinary_cancel','ban_account','unban_account')),
 reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
 canceled_subscriptions INTEGER NOT NULL DEFAULT 0,
 confiscated_credits INTEGER NOT NULL DEFAULT 0,
 account_status_after TEXT NOT NULL DEFAULT 'active' CHECK(account_status_after IN ('active','suspended')),
 email_status TEXT NOT NULL DEFAULT 'pending' CHECK(email_status IN ('pending','sent','failed','skipped')),
 last_error TEXT,
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 completed_at INTEGER,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporter_disciplinary_user_created
 ON supporter_disciplinary_actions(discord_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supporter_disciplinary_email_retry
 ON supporter_disciplinary_actions(email_status, updated_at);
