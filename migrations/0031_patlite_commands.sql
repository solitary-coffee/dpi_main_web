-- 積層灯の遠隔操作（操作盤ページ /site/control-deck/ などから）: 確認・強制停止・イルミネーション試験の依頼。
-- Arduino をつないだ PC / Chromebook の積層灯ページが受け取って実行し、done_at を入れる（先に取ったページだけが実行）。
-- 2 分を過ぎた未実行の依頼は期限切れとして扱う（実行しない）。
CREATE TABLE IF NOT EXISTS patlite_commands (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    created_by TEXT,
    done_at REAL,
    done_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_patlite_commands_pending ON patlite_commands (done_at, created_at);
