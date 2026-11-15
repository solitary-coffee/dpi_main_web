CREATE TABLE IF NOT EXISTS supporter_credit_campaigns (
 id TEXT PRIMARY KEY,
 target_type TEXT NOT NULL CHECK(target_type IN ('all','user','plan')),
 target_value TEXT,
 amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 1000000),
 reason TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','partial','failed')),
 recipient_count INTEGER NOT NULL DEFAULT 0,
 credited_count INTEGER NOT NULL DEFAULT 0,
 failed_count INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS supporter_credit_campaign_recipients (
 campaign_id TEXT NOT NULL REFERENCES supporter_credit_campaigns(id),
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 request_id TEXT NOT NULL UNIQUE,
 lot_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','credited','failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0,
 stripe_transaction_id TEXT UNIQUE,
 balance_after INTEGER,
 error_message TEXT,
 credited_at INTEGER,
 PRIMARY KEY(campaign_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_campaigns_created
 ON supporter_credit_campaigns(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_campaign_recipients_status
 ON supporter_credit_campaign_recipients(campaign_id, status, discord_user_id);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_campaign_recipients_user
 ON supporter_credit_campaign_recipients(discord_user_id, credited_at DESC);
