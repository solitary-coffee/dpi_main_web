# DPI-Bot 公式サイト メンテナンスモード

このPRは `dpi-bot.com` 等を想定した公開ページの HTTP 503 切替機能です。サイトキーは `main`。
**マージだけではサイトは停止しません。** Cloudflare Worker の本番環境に共有 Workers KV Namespace を `DPI_MAINTENANCE_KV` としてBindingし、切替キーを設定する必要があります。既存のD1、Queue、Email、Secretなどを維持してください。

- 一括停止: KV key `maintenance:global` → `{"enabled":true,"message":"セキュリティ点検のため一時的に公開停止しています。"}`
- 一括復旧: 同キー → `{"enabled":false}`
- このサイトのみ停止: `maintenance:site:main` → `{"enabled":true}`
- このサイトのみ復旧: 同キー → `{"enabled":false}`

`/api` と `/api/*` は従来の処理を維持します。Workers Queue や AWS 配信は変更しません。KVがBindingされていなければ公開状態は変更されません。KV障害時は画面のみ503で閉じます。切替反映にはKVキャッシュの伝播遅延があり得ます。

**作業順:** 共有KV作成 → 各Worker/Pagesへ同じBinding追加 → OFFでデプロイ → API/静的資産を検証 → ONで503検証 → 復旧テスト。別のデプロイURL、独立サイト、キャッシュについては別途確認してください。


## 共通KV Namespaceの確定設定（2026-10-21）

このPRのWrangler設定ファイルへ共通Namespace ID `2dbad207714d49a5b03f9fc4ceb7b293` をBinding名 `DPI_MAINTENANCE_KV` として設定済みです。別のNamespaceを新規に作成しないでください。

- 共通停止キー: `maintenance:global` （初期状態は `{"enabled":false}` を推奨）
- このサイトだけ停止: `maintenance:site:main`
- マージ前に**元のKV Namespace IDを実際のCloudflareアカウントで再確認**し、Wranglerが本番の設定・既存Bindingを上書きしないことを確認してください。
- マージだけで停止するわけではありません。デプロイ後に各サイトの正常動作を検証してからKVへ `{"enabled":true}` を書き込みます。
- `me.dpi-bot.com` など未確認の独立デプロイ/旧プレビューURLはこの4つのPRでは停止保証できません。

