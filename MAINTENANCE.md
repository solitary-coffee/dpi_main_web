# DPI-Bot 公式サイト メンテナンスモード

このPRは `dpi-bot.com` 等を想定した公開ページの HTTP 503 切替機能です。サイトキーは `main`。
**マージだけではサイトは停止しません。** Cloudflare Worker の本番環境に共有 Workers KV Namespace を `DPI_MAINTENANCE_KV` としてBindingし、切替キーを設定する必要があります。既存のD1、Queue、Email、Secretなどを維持してください。

- 一括停止: KV key `maintenance:global` → `{"enabled":true,"message":"セキュリティ点検のため一時的に公開停止しています。"}`
- 一括復旧: 同キー → `{"enabled":false}`
- このサイトのみ停止: `maintenance:site:main` → `{"enabled":true}`
- このサイトのみ復旧: 同キー → `{"enabled":false}`

`/api` と `/api/*` は従来の処理を維持します。Workers Queue や AWS 配信は変更しません。KVがBindingされていなければ公開状態は変更されません。KV障害時は画面のみ503で閉じます。切替反映にはKVキャッシュの伝播遅延があり得ます。

**作業順:** 共有KV作成 → 各Worker/Pagesへ同じBinding追加 → OFFでデプロイ → API/静的資産を検証 → ONで503検証 → 復旧テスト。別のデプロイURL、独立サイト、キャッシュについては別途確認してください。
