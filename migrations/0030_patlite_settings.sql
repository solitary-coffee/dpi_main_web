-- 積層灯（PATLITE）管理ページの設定: 一時停止（何時間か全部消す）・夜間モード（重大だけ表示）・イルミネーション試験。
-- 1 行だけ保存する。どの PC・Chromebook で開いても同じ設定になる。
CREATE TABLE IF NOT EXISTS patlite_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL,
    updated_at REAL NOT NULL,
    updated_by TEXT
);
