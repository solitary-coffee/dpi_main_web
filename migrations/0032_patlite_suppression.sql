-- 積層灯の履歴に「積層灯に出さなかった理由」（無連動の理由）を残す。
-- 例: 「一時停止により無連動」「無期限停止により無連動」「強制停止により無連動」
--     「時間帯設定（重大のみ）により無連動」「一時的な絞り込み（中以上）により無連動」。積層灯に出したときは NULL。
ALTER TABLE patlite_history ADD COLUMN suppressed TEXT;

-- Arduino の強制停止の状態: Arduino をつないだ積層灯ページが、変わったときと 5 分ごとに知らせる（1 行だけ）。
-- 15 分より古い値は使わない（ページを閉じたときに「強制停止中」のまま残らないように）。
CREATE TABLE IF NOT EXISTS patlite_device (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    full_stop INTEGER NOT NULL DEFAULT 0,
    reported_at REAL NOT NULL,
    reported_by TEXT
);
