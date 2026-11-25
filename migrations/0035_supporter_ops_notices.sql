-- 運営向けの Discord 通知（支払い・加入/変更/解約）の記録。同じ id は1回だけ送る。月ごとの件数の集計にも使う。
CREATE TABLE IF NOT EXISTS supporter_ops_notices (
 id TEXT PRIMARY KEY,
 channel TEXT NOT NULL,
 kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS supporter_ops_notices_pending_idx ON supporter_ops_notices(status, created_at);
CREATE INDEX IF NOT EXISTS supporter_ops_notices_kind_idx ON supporter_ops_notices(channel, created_at, kind);
