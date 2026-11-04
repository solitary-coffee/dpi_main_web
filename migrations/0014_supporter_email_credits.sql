ALTER TABLE supporter_accounts ADD COLUMN billing_email TEXT;

CREATE TABLE IF NOT EXISTS supporter_credit_events (
 id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 credit_delta INTEGER NOT NULL,
 balance_after INTEGER NOT NULL,
 stripe_transaction_id TEXT NOT NULL UNIQUE,
 reason TEXT NOT NULL,
 actor TEXT NOT NULL,
 created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_events_user_created
 ON supporter_credit_events(discord_user_id, created_at DESC);
