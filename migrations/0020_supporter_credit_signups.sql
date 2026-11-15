CREATE TABLE IF NOT EXISTS supporter_credit_signups (
 request_id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 customer_id TEXT NOT NULL,
 plan_id TEXT NOT NULL CHECK(plan_id IN ('supporter','plus','pro')),
 channel_packs INTEGER NOT NULL CHECK(channel_packs BETWEEN 0 AND 5),
 server_packs INTEGER NOT NULL CHECK(server_packs BETWEEN 0 AND 5),
 amount INTEGER NOT NULL CHECK(amount > 0),
 billing_anchor INTEGER NOT NULL,
 balance_transaction_id TEXT UNIQUE,
 subscription_id TEXT UNIQUE,
 legal_consent_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','debited','provisioned','failed','refunded')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_signups_user_created
 ON supporter_credit_signups(discord_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_credit_signups_active_user
 ON supporter_credit_signups(discord_user_id)
 WHERE status IN ('pending','debited');
