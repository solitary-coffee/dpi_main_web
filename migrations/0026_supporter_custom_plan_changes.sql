-- Pending price changes are independent from the active paid entitlement.
-- The price/limits in supporter_custom_plans are only replaced after Stripe
-- confirms the one-off difference payment and the recurring price is updated.
CREATE TABLE IF NOT EXISTS supporter_custom_plan_changes (
 request_id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL REFERENCES supporter_custom_plans(discord_user_id),
 custom_plan_id TEXT NOT NULL,
 stripe_customer_id TEXT NOT NULL,
 stripe_subscription_id TEXT NOT NULL,
 old_revision INTEGER NOT NULL,
 next_revision INTEGER NOT NULL,
 old_monthly_yen INTEGER NOT NULL,
 next_monthly_yen INTEGER NOT NULL,
 amount_due_yen INTEGER NOT NULL CHECK (amount_due_yen >= 0),
 next_plan_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','paid','applied','canceled','failed')),
 checkout_session_id TEXT UNIQUE,
 checkout_expires_at INTEGER,
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 applied_at TEXT,
 last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_change_inflight
 ON supporter_custom_plan_changes(discord_user_id) WHERE status IN ('pending','paid');
CREATE INDEX IF NOT EXISTS idx_custom_change_retry
 ON supporter_custom_plan_changes(status,updated_at);
