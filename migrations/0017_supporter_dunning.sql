CREATE TABLE IF NOT EXISTS supporter_dunning (
 invoice_id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL,
 subscription_id TEXT,
 amount_due INTEGER NOT NULL DEFAULT 0,
 currency TEXT NOT NULL DEFAULT 'jpy',
 status TEXT NOT NULL,
 initial_failed_at INTEGER NOT NULL,
 retry_at INTEGER NOT NULL,
 retry_attempted_at INTEGER,
 suspend_at INTEGER NOT NULL,
 paid_at INTEGER,
 suspended_at INTEGER,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS supporter_dunning_due_idx
 ON supporter_dunning(status, retry_at, suspend_at);

CREATE INDEX IF NOT EXISTS supporter_dunning_customer_idx
 ON supporter_dunning(customer_id, status);

CREATE TABLE IF NOT EXISTS supporter_billing_notifications (
 invoice_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 sent_at INTEGER,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(invoice_id, kind)
);
