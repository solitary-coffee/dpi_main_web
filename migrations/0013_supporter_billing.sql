CREATE TABLE supporter_billing (
 discord_user_id TEXT PRIMARY KEY REFERENCES supporter_accounts(discord_user_id),
 customer_id TEXT UNIQUE,
 checkout_id TEXT,
 checkout_key TEXT,
 checkout_params TEXT,
 dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE supporter_stripe_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
