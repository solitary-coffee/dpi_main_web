# Stripeテスト決済

配信は未接続。本実装はテスト用の `sk_test_` または権限を限定できる `rk_test_` キーだけを受け付け、本番課金はできません。運用には `rk_test_` を推奨します。

適用順序: D1 migrations 0012〜0019 → Worker Secrets/vars → Workerデプロイ → StripeテストWebhook登録 → E2E確認。

Secrets: STRIPE_SECRET_KEY（テスト用）、STRIPE_WEBHOOK_SECRET。秘密値をGitやチャットへ貼らないこと。

vars: SUPPORTER_BILLING_MODE=test、SUPPORTER_PUBLIC_ORIGIN=https://dpi-bot.com、SUPPORTER_CONSENT_VERSION=<同意文書の改定日>、STRIPE_PRICE_SUPPORTER、STRIPE_PRICE_PLUS、STRIPE_PRICE_PRO、STRIPE_PRICE_ADDON、STRIPE_PORTAL_CONFIG、SUPPORTER_PUBLIC_ENABLED=false、SUPPORTER_TEST_USER_IDS=<許可するDiscordユーザーIDをカンマ区切り>。

画像配信ルール（schemaVersion 4）は `SUPPORTER_IMAGE_RULES_ENABLED=1` のときだけ有効（既定オフ）。デプロイ順序とスキーマは [supporter-image-rules.md](supporter-image-rules.md) を参照。

`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、全Price ID、Portal設定ID、テストモード指定がそろったときだけ決済を有効にする。不足時は申込ボタンを無効にして不足理由を表示し、APIも503を返す。秘密値はCloudflare Worker `main-dpi` のSecretsへ登録し、通常のvarsやGitには保存しない。

限定公開中は `/site/supporter/` とサポーターAPIをDiscordユーザーIDの許可リストで保護する。未認証・未許可ユーザーには一律404を返し、画面レスポンスには `X-Robots-Tag: noindex, nofollow, noarchive` を付与する。Cloudflare Access認証済み管理者は画面資産のみ確認できるが、ユーザー操作にはDiscordログインも必要。`SUPPORTER_PUBLIC_ENABLED=true` は一般公開時だけ設定する。空値や未設定は閉鎖扱い。

**非公開での運用（2026-11-25〜）**

決済サービスの審査を通過したため、テスト公開（2026-11-19〜25）を終えた。画面・API は許可リスト（`SUPPORTER_TEST_USER_IDS`）の利用者と管理者だけが使え、それ以外には 404 を返す。画面の表記と機能は本番と同じで、決済だけ Stripe のテストモード。ログイン不要のテスト支払いは廃止した（遅れて届いた `preview_demo` の通知は何も反映しない）。

決済サービスの審査など、許可リスト外の人に画面を見せる場合は、Worker Secrets の `SUPPORTER_REVIEW_USER` と `SUPPORTER_REVIEW_PASSWORD` を設定する。

- パスワードは12文字以上にする。2つがそろったときだけ有効になる。
- 有効なときは、未許可の閲覧者に404ではなくユーザー名・パスワードの入力（HTTP Basic 認証）を求める。
- 認証に成功したブラウザには12時間有効な署名付きCookieを発行する。その間は、Discordログイン後のサポーターAPIも許可リスト外のユーザーで利用できる（決済はテストモードのまま）。
- 審査が終わったら `npx wrangler secret delete SUPPORTER_REVIEW_PASSWORD` で無効化する。パスワードを変えると、発行済みのCookieも無効になる。

価格はJPYで、BASIC月額300円、Plus月額800円、Pro月額1,280円。追加チャンネル3件・追加サーバー2件・追加通知ルール3件の各パックにつき月額200円。税込総額として価格を登録し、追加税を自動加算する設定は使用しない。Portalは支払方法変更、請求履歴、期間末解約を有効にし、プラン・数量変更はDPI-Bot側の確認画面から行う。

アップグレード前は `POST /v1/invoices/create_preview` で基本プランの差額だけを見積もり、同じ `proration_date` を確定時のSubscription更新に使用する。確認画面では旧プランの未使用分（返金相当額）、新プランの残期間分、その差額を分けて表示する。ダウングレードまたは利用枠の削減はSubscription Scheduleへ予約し、返金・日割り精算を行わず、現在の契約期間終了後の26日から適用する。追加オプションの即時変更は `proration_behavior=none` とする。

`GET /api/supporter/billing/status` は最大12件の請求明細を返す。ユーザー画面からStripeの `hosted_invoice_url` と `invoice_pdf` を開けるが、`invoice.stripe.com` または `pay.stripe.com` のHTTPS URLのみを許可する。

Webhook: /api/supporter/stripe/webhook。対象はcheckout.session.completed/expired、checkout.session.async_payment_succeeded/failed、customer.subscription.created/updated/deleted、invoice.paid/payment_failed。raw body署名検証、5分の許容差、テストイベント限定。メンテナンス・ブラウザCSRFから独立して受信。

契約状態はStripeから都度取得し、順不同Webhookの内容で状態を上書きしない。イベントIDを保存。通知設定は有効な契約を確認したユーザーのみ保存可能で、Proは1ルール最大8件の追加条件を持てる。現時点では保存内容と配信プログラムの接続なし。

POST /api/supporter/billing/checkout: {plan:"supporter"|"plus"|"pro",channelPacks:0..5,serverPacks:0..5,rulePacks:0..5,legalConsent:true}。申込画面で料金・支払時期・提供時期・解約条件を確認し、利用規約、プライバシーポリシー、特定商取引法に基づく表記への同意を必須とする。同意日時と `SUPPORTER_CONSENT_VERSION` をD1およびStripe metadataへ記録する。
POST /api/supporter/billing/preview-update: 契約変更の料金・利用枠プレビュー。
POST /api/supporter/billing/update: プレビューの `prorationDate` と同じ選択内容を確定。
POST /api/supporter/billing/portal: {}。
POST /api/supporter/billing/topup: {amount:500..100000,email,legalConsent:true,requestId:<UUID v4>}。1円を1クレジットとしてStripeの都度払いCheckout URLを利用者・金額ごとに発行する。チャージはサブスクリプションではない。決済成功Webhookの署名とCustomer・Discordユーザー・金額・PaymentIntentを照合してから、Stripe Customer Balanceへ1度だけ反映する。

クレジットチャージは有料プラン未契約でも利用できる。チャージと有料プラン申込みは `supporter_accounts.billing_email` を共通の連絡先として使用し、どちらかで登録済みなら画面へ自動入力する。新しいメールアドレスを入力した場合はD1と同じStripe Customerを同時に更新するため、チャージ用と契約用の連絡先は分離しない。

新規申込時にチャージ済み残高が初回利用料以上あり、利用者がクレジット全額払いを選択した場合は、Customer Balanceから初回利用料を消費して固定26日更新のSubscriptionを直接作成する。この経路ではカード情報を要求せず、残高不足時は消費前に停止する。残高消費後にSubscription作成が失敗した場合は同額を自動で戻し、`supporter_credit_signups` とStripe冪等キーで二重消費・二重契約を防ぐ。次回26日の請求は残クレジットを優先し、不足時は登録済み支払方法を使用する。支払方法も残高も不足する場合は通常の支払い失敗・月末再試行フローへ進む。
GET /api/supporter/billing/status: 現在の契約状態。
POSTはDiscordセッション、同一Origin、x-reuse-csrfが必要。

決済作成前にD1へ固定パラメータと冪等キーを保存し、同時クリックは同じCheckoutを再利用。契約存在時は新規決済を拒否。別条件での再作成は既存Sessionの期限切れ後。通信断で作成結果不明のまま期限が過ぎた場合は自動再課金をせず管理者確認を要求。

購入クレジットはチャージ単位のロットとしてD1へ保存し、購入日時の1年後（うるう日の場合は翌年2月末）に未使用分を失効する。定期処理はStripe残高とロット残高を照合し、利用済み分を期限の近い購入ロットから減算する。管理者が臨時付与したクレジットは購入ロットと区別し、この1年失効処理の対象外とする。利用者画面には総残高、購入分残高、最も近い有効期限、直近20件のチャージ履歴を表示する。

`NOTICE_EMAIL`からは、通常請求の成功、26日の支払い失敗、月末再決済の成功・最終失敗に加え、クレジットチャージ成功、非同期決済失敗、クレジット全額払いによるプラン申込み完了、購入クレジット失効を登録メールアドレスへ通知する。同じStripeセッション・請求書・クレジット申込・失効ロットと通知種別の組み合わせは `supporter_billing_notifications` で冪等化し、重複送信しない。

管理者画面では、Stripeの全利用可能残高を基準に総合クレジット数と残高保有者数を表示し、D1の購入ロットから購入クレジット残高、購入者数、累計チャージ額、30日以内の失効予定、累計失効額を表示する。総残高から購入ロット残高を差し引いた値は「管理者付与等」として区別する。有償未使用残高は1,000万円を基準に割合を表示し、80%・90%・95%・100%で段階的に警告する。これは運用監視であり、届出要否の最終判断を自動化するものではない。

未完: 解約後の再契約、Webhookイベント保持期限、ブラウザE2E、配信プログラムへの権限接続。現段階で本番公開・課金開始しない。


## ユーザー別カスタムプラン：契約中の変更（migration 0025 / 0026）

管理者画面 `/site/supporter-admin/` から、指定した Discord ID の契約中カスタムプランを編集できます。
利用者から通常の Basic / Plus / Pro へ変更する経路は従来どおりブロックします。

### 変更時の精算ルール（税・割引の自動調整なし）

| ケース | 当月の追加決済 | 次回以降の月額 | 配信権限 |
| --- | --- | --- | --- |
| 1,000 円 → 1,600 円 | **600 円（旧月額との差額、日割りなし）** | 1,600 円 | 差額の支払い完了後に新条件を有効化 |
| 1,600 円 → 1,000 円 | 0 円、既払分の返金なし | 1,000 円 | Stripe契約変更を確認してから有効化 |
| 1,000 円 → 1,000 円（利用枠変更） | 0 円 | 1,000 円 | StripeメタデータとD1が一致してから有効化 |

「来月からの新料金」は、Stripeサブスクリプションの**次回請求（通常は毎月26日）**から適用します。過去の請求済みInvoiceは自動変更しません。26日以降など翌月分がすでに請求済みのケースは、請求済み分の補正や返金を管理者が個別に確認してください。

Stripe Checkoutの日本円最低決済額は50円のため、増額差額が1〜49円の変更は自動決済を拒否します。別の差額で設定するか、請求方法を個別に検討してください。

### 安全な適用順序

1. **プレビュー：** 現在のD1契約とStripeの顧客・サブスクリプション・1種類の月額Price・直近の支払済みInvoiceを照合し、差額・次回月額を表示。複数アイテム、割引、Stripe Schedule、未払いや中断のある契約は自動変更しません。
2. **増額の場合：** `supporter_custom_plan_changes` に旧契約改訂番号・新設定・差額を保存し、対象DiscordユーザーのStripe Customerと紐づいた**都度払いCheckout**を発行。旧契約はそのまま維持し、期限内（24時間）の支払いを待ちます。
3. **決済確認：** Stripe署名付きWebhook、利用者の契約確認、定期処理のいずれかでStripe APIを再照会。支払いが`paid`かつ金額・Customer・Discord ID・変更IDがすべて一致する場合にだけ、Stripe月額Priceを変更します。
4. **新料金への切替：** `proration_behavior=none`・`billing_cycle_anchor=unchanged`で価格変更。日割り請求や請求日のリセットを禁止します。Stripeの契約改訂番号とD1の月額・権限更新をそろえます。
5. **減額・同額の場合：** Checkoutを作成せず、Stripeの月額・メタデータ変更を検証してから新設定を確定します。当月の返金・請求は発生しません。
6. **失敗・再送：** 変更IDに対するユニーク制約・Stripe冪等キーを使用。支払完了後にDB更新などが失敗しても`paid`のまま保持し、自動リトライします。決済前の変更は管理者が取り消せますが、支払い済みの変更は取消せません。

### デプロイ時の注意

- `migrations/0025_supporter_custom_plans.sql` **と** `migrations/0026_supporter_custom_plan_changes.sql` の両方を適用してからWorkerを公開してください。
- Stripeは`SUPPORTER_BILLING_MODE=test`のままです。テスト環境で実際の Checkout・subscription更新・Webhook署名照合・翌月Invoiceを確認し、本番決済が不要に動作しないことを確認してください。
- Stripe制限付きキーは、サブスクリプション読み取り・更新、Checkout作成・照会、Invoice照会、顧客照会が必要です。
- 管理者が契約上の二次利用権限を設定しても、既存の二次利用申請・審査は別途必要です。

## 追加ルールパック・サーバー上限（2026年11月）

- 新規パックの価格：月額200円でチャンネル＋3件、サーバー＋2件、通知ルール＋3件。基本プラン価格は据え置き。
- Stripeの既存 `STRIPE_PRICE_ADDON`（単価200円）を使用。Subscriptionの追加オプション数量 = `dpi_channel_packs` + `dpi_server_packs` + `dpi_rule_packs`。新しくStripe商品・価格IDを作る必要はありません。
- 古い契約に `dpi_rule_packs` が存在しない場合は **0** として解釈し、金額を変更しません。サーバー追加1パックについては契約価格を据え置いたまま「2サーバー追加」として上限を増やします。
- 初回Stripe Checkout（新規カード決済）、クレジット全額払い、ユーザー/管理者による変更・変更予約のすべてに `rulePacks` と `dpi_rule_packs` を引き継ぎます。
- `migrations/0027_supporter_rule_packs.sql` は **Workerの新コードを公開する前に必ずD1に適用**してください。既存のクレジット払い申込行にはrule_packs=0が入ります。
- 雨雲レーダーの **1時間降水量0.1～20mm/hの閾値**はPlus・Proまたは有効なカスタム契約に限定。Basicの既存閾値ルールは自動で定時更新へ変更せず、配信スナップショットから除外します。
- 定時更新と降雨検知、および1/2/3/6/12/24時間の配信頻度はBasicでも利用できます。
- **ロールアウト時の検証**：Stripeの契約 metadata/追加オプション数量と請求額、D1の0027マイグレーション、Basic既存ルールの停止件数、予約変更とクレジット申込みのリカバリーを確認してから運用してください。
