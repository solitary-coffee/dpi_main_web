-- 積層灯（PATLITE）管理ページ用: 自宅の積層灯ブリッジ（dpi_code Di/dpi_patlite_bridge.py）が送る
-- 「いま起きていること」の一覧を 1 行だけ保存する（変化時と 60 秒ごとに上書き）。
CREATE TABLE IF NOT EXISTS patlite_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL,
    generated_at REAL,
    received_at REAL NOT NULL
);
