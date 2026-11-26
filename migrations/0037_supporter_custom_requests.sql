-- カスタムプランの要望、運営回答、利用者の最終決定を一つの履歴として管理する。
CREATE TABLE IF NOT EXISTS supporter_custom_requests (
 id TEXT PRIMARY KEY,
 discord_user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('submitted','estimating','answered','accepted','consulting','objected','withdrawn','closed')),
 request_json TEXT NOT NULL,
 answer_json TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 answered_at INTEGER,
 decided_at INTEGER,
 decision_message TEXT,
 revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS supporter_custom_requests_user_idx
 ON supporter_custom_requests(discord_user_id, updated_at DESC);
