-- 積層灯（PATLITE）管理ページの設定: 一時停止（何時間か全部消す）・夜間モード（重大だけ表示）・イルミネーション試験。
-- 1 行だけ保存する。どの PC・Chromebook で開いても同じ設定になる。
CREATE TABLE IF NOT EXISTS patlite_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL,
    updated_at REAL NOT NULL,
    updated_by TEXT
);

-- 積層灯の履歴: 項目（障害・防災情報）が出た時刻と消えた（復帰した）時刻。ブリッジからの送信が途切れた時間帯も
-- kind = 'link_lost' として残す。変化したときだけ書く（90 日より古いものは時々消す）。
CREATE TABLE IF NOT EXISTS patlite_history (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cid TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    started_at REAL NOT NULL,
    ended_at REAL
);
CREATE INDEX IF NOT EXISTS idx_patlite_history_open ON patlite_history (ended_at, cid);
CREATE INDEX IF NOT EXISTS idx_patlite_history_started ON patlite_history (started_at);
