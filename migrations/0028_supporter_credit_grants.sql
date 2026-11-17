-- Credit grants are claimed here before Stripe is called, so a retried
-- webhook, a leftover pending top-up or a resumed compensation batch can
-- never create a second Stripe balance credit after the 24h idempotency window.
CREATE TABLE IF NOT EXISTS supporter_credit_grants (
 grant_key TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('credit_topup','compensation')),
 discord_user_id TEXT NOT NULL,
 customer_id TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount > 0),
 status TEXT NOT NULL CHECK(status IN ('claimed','granted')),
 stripe_transaction_id TEXT UNIQUE,
 balance_after INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supporter_credit_grants_user
 ON supporter_credit_grants(discord_user_id, created_at DESC);
