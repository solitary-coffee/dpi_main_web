-- 返金・支払異議・不正の警告（Stripe Webhook）の記録。管理画面に表示し、契約の扱いは管理者が判断する。
CREATE TABLE IF NOT EXISTS supporter_payment_alerts (
 event_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 outcome TEXT NOT NULL DEFAULT '',
 payment_intent_id TEXT NOT NULL DEFAULT '',
 customer_id TEXT NOT NULL DEFAULT '',
 discord_user_id TEXT NOT NULL DEFAULT '',
 amount INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS supporter_payment_alerts_created_idx
 ON supporter_payment_alerts(created_at DESC);
