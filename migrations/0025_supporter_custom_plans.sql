-- Discord user-specific paid plans. D1 is never authoritative for payments.
-- An offered plan locks self-service changes, but is NOT a delivery entitlement.
CREATE TABLE IF NOT EXISTS supporter_custom_plans (
 discord_user_id TEXT PRIMARY KEY REFERENCES supporter_accounts(discord_user_id),
 id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL DEFAULT 'カスタムプラン',
 status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','active','canceled')),
 channel_limit INTEGER NOT NULL CHECK(channel_limit BETWEEN 1 AND 200),
 server_limit INTEGER NOT NULL CHECK(server_limit BETWEEN 1 AND 50),
 rule_limit INTEGER NOT NULL CHECK(rule_limit BETWEEN 1 AND 500),
 complex_conditions INTEGER NOT NULL DEFAULT 0 CHECK(complex_conditions IN (0,1)),
 municipality_branching INTEGER NOT NULL DEFAULT 0 CHECK(municipality_branching IN (0,1)),
 content_extraction INTEGER NOT NULL DEFAULT 0 CHECK(content_extraction IN (0,1)),
 multi_destination INTEGER NOT NULL DEFAULT 0 CHECK(multi_destination IN (0,1)),
 secondary_reuse INTEGER NOT NULL DEFAULT 0 CHECK(secondary_reuse IN (0,1)),
 estimated_yen INTEGER NOT NULL,
 confirmed_yen INTEGER NOT NULL CHECK(confirmed_yen BETWEEN 100 AND 1000000),
 revision INTEGER NOT NULL DEFAULT 1,
 stripe_subscription_id TEXT,
 stripe_checkout_id TEXT,
 checkout_expires_at INTEGER,
 reason TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 activated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_supporter_custom_plans_status ON supporter_custom_plans(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_custom_plans_subscription ON supporter_custom_plans(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
