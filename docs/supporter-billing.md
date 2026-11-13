# Stripeテスト決済

配信は未接続。本実装はテスト用の `sk_test_` または権限を限定できる `rk_test_` キーだけを受け付け、本番課金はできません。運用には `rk_test_` を推奨します。

適用順序: D1 migrations 0012〜0019 → Worker Secrets/vars → Workerデプロイ → StripeテストWebhook登録 → E2E確認。

Secrets: STRIPE_SECRET_KEY（テスト用）、STRIPE_WEBHOOK_SECRET。秘密値をGitやチャットへ貼らないこと。

vars: SUPPORTER_BILLING_MODE=test、SUPPORTER_PUBLIC_ORIGIN=https://dpi-bot.com、SUPPORTER_CONSENT_VERSION=<同意文書の改定日>、STRIPE_PRICE_SUPPORTER、STRIPE_PRICE_PLUS、STRIPE_PRICE_PRO、STRIPE_PRICE_ADDON、STRIPE_PORTAL_CONFIG、SUPPORTER_PUBLIC_ENABLED=false、SUPPORTER_TEST_USER_IDS=<許可するDiscordユーザーIDをカンマ区切り>。

`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、全Price ID、Portal設定ID、テストモード指定がそろったときだけ決済を有効にする。不足時は申込ボタンを無効にして不足理由を表示し、APIも503を返す。秘密値はCloudflare Worker `main-dpi` のSecretsへ登録し、通常のvarsやGitには保存しない。

限定公開中は `/site/supporter/` とサポーターAPIをDiscordユーザーIDの許可リストで保護する。未認証・未許可ユーザーには一律404を返し、画面レスポンスには `X-Robots-Tag: noindex, nofollow, noarchive` を付与する。Cloudflare Access認証済み管理者は画面資産のみ確認できるが、ユーザー操作にはDiscordログインも必要。`SUPPORTER_PUBLIC_ENABLED=true` は一般公開時だけ設定する。空値や未設定は閉鎖扱い。

価格はJPYで、BASIC月額300円、Plus月額800円、Pro月額1,280円。追加チャンネル3件または追加サーバー1件につき月額200円。税込総額として価格を登録し、追加税を自動加算する設定は使用しない。Portalは支払方法変更、請求履歴、期間末解約を有効にし、プラン・数量変更はDPI-Bot側の確認画面から行う。

アップグレード前は `POST /v1/invoices/create_preview` で基本プランの差額だけを見積もり、同じ `proration_date` を確定時のSubscription更新に使用する。確認画面では旧プランの未使用分（返金相当額）、新プランの残期間分、その差額を分けて表示する。ダウングレードまたは利用枠の削減はSubscription Scheduleへ予約し、返金・日割り精算を行わず、現在の契約期間終了後の26日から適用する。追加オプションの即時変更は `proration_behavior=none` とする。

`GET /api/supporter/billing/status` は最大12件の請求明細を返す。ユーザー画面からStripeの `hosted_invoice_url` と `invoice_pdf` を開けるが、`invoice.stripe.com` または `pay.stripe.com` のHTTPS URLのみを許可する。

Webhook: /api/supporter/stripe/webhook。対象はcheckout.session.completed/expired、checkout.session.async_payment_succeeded/failed、customer.subscription.created/updated/deleted、invoice.paid/payment_failed。raw body署名検証、5分の許容差、テストイベント限定。メンテナンス・ブラウザCSRFから独立して受信。

契約状態はStripeから都度取得し、順不同Webhookの内容で状態を上書きしない。イベントIDを保存。通知設定は有効な契約を確認したユーザーのみ保存可能で、Proは1ルール最大8件の追加条件を持てる。現時点では保存内容と配信プログラムの接続なし。

POST /api/supporter/billing/checkout: {plan:"supporter"|"plus"|"pro",channelPacks:0..5,serverPacks:0..5,legalConsent:true}。申込画面で料金・支払時期・提供時期・解約条件を確認し、利用規約、プライバシーポリシー、特定商取引法に基づく表記への同意を必須とする。同意日時と `SUPPORTER_CONSENT_VERSION` をD1およびStripe metadataへ記録する。
POST /api/supporter/billing/preview-update: 契約変更の料金・利用枠プレビュー。
POST /api/supporter/billing/update: プレビューの `prorationDate` と同じ選択内容を確定。
POST /api/supporter/billing/portal: {}。
POST /api/supporter/billing/topup: {amount:500..100000,email,legalConsent:true,requestId:<UUID v4>}。1円を1クレジットとしてStripeの都度払いCheckout URLを利用者・金額ごとに発行する。チャージはサブスクリプションではない。決済成功Webhookの署名とCustomer・Discordユーザー・金額・PaymentIntentを照合してから、Stripe Customer Balanceへ1度だけ反映する。
GET /api/supporter/billing/status: 現在の契約状態。
POSTはDiscordセッション、同一Origin、x-reuse-csrfが必要。

決済作成前にD1へ固定パラメータと冪等キーを保存し、同時クリックは同じCheckoutを再利用。契約存在時は新規決済を拒否。別条件での再作成は既存Sessionの期限切れ後。通信断で作成結果不明のまま期限が過ぎた場合は自動再課金をせず管理者確認を要求。

購入クレジットはチャージ単位のロットとしてD1へ保存し、購入日時の1年後（うるう日の場合は翌年2月末）に未使用分を失効する。定期処理はStripe残高とロット残高を照合し、利用済み分を期限の近い購入ロットから減算する。管理者が臨時付与したクレジットは購入ロットと区別し、この1年失効処理の対象外とする。利用者画面には総残高、購入分残高、最も近い有効期限、直近20件のチャージ履歴を表示する。

未完: 解約後の再契約、Webhookイベント保持期限、ブラウザE2E、配信プログラムへの権限接続。現段階で本番公開・課金開始しない。
