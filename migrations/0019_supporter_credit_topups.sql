CREATE TABLE IF NOT EXISTS supporter_credit_topups (
 request_id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 customer_id TEXT NOT NULL,
 checkout_session_id TEXT UNIQUE,
 payment_intent_id TEXT UNIQUE,
 stripe_balance_transaction_id TEXT UNIQUE,
 amount INTEGER NOT NULL CHECK(amount >= 500 AND amount <= 100000),
 refunded_amount INTEGER NOT NULL DEFAULT 0 CHECK(refunded_amount >= 0 AND refunded_amount <= amount),
 currency TEXT NOT NULL DEFAULT 'jpy',
 status TEXT NOT NULL CHECK(status IN ('pending','credited','failed','expired','refunded','disputed')),
 purchased_at INTEGER,
 expires_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_topups_user_created
 ON supporter_credit_topups(discord_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS supporter_credit_lots (
 id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_accounts(discord_user_id),
 source_type TEXT NOT NULL CHECK(source_type IN ('purchase','admin','legacy')),
 source_id TEXT NOT NULL,
 original_amount INTEGER NOT NULL CHECK(original_amount > 0),
 remaining_amount INTEGER NOT NULL CHECK(remaining_amount >= 0),
 expires_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('active','consumed','expired','revoked')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_lots_user_expiry
 ON supporter_credit_lots(discord_user_id, status, expires_at);
