# Stripeテスト決済

配信は未接続。本実装はsk_test_キー限定で、本番課金はできません。

適用順序: D1 migrations 0012,0013 → Worker Secrets/vars → Workerデプロイ → StripeテストWebhook登録 → E2E確認。

Secrets: STRIPE_SECRET_KEY（テスト用）、STRIPE_WEBHOOK_SECRET。秘密値をGitやチャットへ貼らないこと。

vars: SUPPORTER_BILLING_MODE=test、SUPPORTER_PUBLIC_ORIGIN=https://dpi-bot.com、STRIPE_PRICE_SUPPORTER、STRIPE_PRICE_PLUS、STRIPE_PRICE_ADDON、STRIPE_PORTAL_CONFIG。

価格はJPY/月額300円、800円、追加パック200円。追加パック数量0〜2、Plusは追加不可。税込総額として価格を登録し、追加税を自動加算する設定は使用しない。Portalは支払方法変更、請求履歴、期間末解約を有効にし、プラン・数量変更は現段階では無効にする。

Webhook: /api/supporter/stripe/webhook。対象はcheckout.session.completed/expired、customer.subscription.created/updated/deleted、invoice.paid/payment_failed。raw body署名検証、5分の許容差、テストイベント限定。メンテナンス・ブラウザCSRFから独立して受信。

契約状態はStripeから都度取得し、順不同Webhookの内容で状態を上書きしない。イベントIDを保存。現時点では配信権限への接続なし。

POST /api/supporter/billing/checkout: {plan:"supporter"|"plus",packs:0|1|2}。
POST /api/supporter/billing/portal: {}。
GET /api/supporter/billing/status: 現在の契約状態。
POSTはDiscordセッション、同一Origin、x-reuse-csrfが必要。

決済作成前にD1へ固定パラメータと冪等キーを保存し、同時クリックは同じCheckoutを再利用。契約存在時は新規決済を拒否。別条件での再作成は既存Sessionの期限切れ後。通信断で作成結果不明のまま期限が過ぎた場合は自動再課金をせず管理者確認を要求。

未完: 既存契約のプラン/追加パック変更と日割り見積、解約後の再契約、Webhookイベント保持期限、ブラウザE2E、実環境Secrets/価格/Portal/Webhook設定。現段階で本番公開・課金開始しない。
