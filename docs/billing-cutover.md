# 有料プランの本番切替の手順

テスト用（`STRIPE_*`）と本番用（`STRIPE_LIVE_*`）の設定を両方登録しておき、`SUPPORTER_BILLING_MODE` だけで切り替える。
本番用が 1 つでも欠けているとき・キーの種類が違うときは、決済は無効になる（テスト用で代用しない）。

main へのマージで、GitHub Actions と Cloudflare の自動ビルドが本番へ配備する。

## 1. 通し試験（Stripe のテストモード）

```
node scripts/stripe-e2e.mjs --shared            … 今のサンドボックスで行う（試験の間だけ Webhook 送信先を止め、終わったら戻す）
node scripts/stripe-e2e.mjs --shared --browser  … 支払い画面（Stripe Checkout）の実操作も行う
```

- キーは、この PC だけで読める形（DPAPI）で登録したテストキーを使う（`scripts/e2e-key.mjs`）。
- 手元の D1 で Worker の処理をそのまま動かす。本番の Worker・D1・Discord・AWS にはつながらない。
- 時間はテストクロックで進める。終わると、作った顧客はテストクロックと一緒に消える。
- 全部を実行したときの結果は `%LOCALAPPDATA%\\dpi-bot\\stripe-e2e-report.json` に残り、`billing-cutover.mjs status` が確認する。

- `STRIPE_E2E_PROXY`（この PC の中継）を指定すると、キーを手元に置かずに実行できる。中継は、登録済みのテストキーを持つ Worker の開発用プレビュー（`wrangler dev --remote`）で動かし、テストキー以外では動かないようにする。

## 1.5 運営向けの通知（Discord）

`worker/supporter-ops-notice.js` が、Worker Secrets の `BILLING_NOTICE_WEBHOOK`（支払い）・`MEMBERSHIP_NOTICE_WEBHOOK`（加入・変更・解約）へ送る。チャンネルの作成と登録は dpi_code の `tools/billing_notice_channels.py`。

| チャンネル | 内容 |
|---|---|
| 支払い | 26 日 0 時の請求の開始、12 時の結果、月末日 12 時の再請求の開始と結果、1 日 0 時の停止・自動解約の件数と前月の集計、返金・支払異議・不正の警告、クレジットチャージ |
| 加入・変更・解約 | 新規加入（再加入）、プラン変更、変更の予約、解約の予約と取り消し、解約（自動解約を含む） |

同じ出来事は 1 回だけ送り、Discord に届かないときは次の機会に送り直す。メールアドレスや Stripe の ID は載せない。テストモードでは題名に「【テスト】」が付く。

## 2. 本番用の Stripe 設定（何度でも・切替前に行える）

ダッシュボードで行うもの:
- 支払い方法（カード、PayPay など）、明細書の表記、領収書メール
- 「サブスクリプションとメール」の自動再試行。再試行と停止は Worker が行うため、未払いの契約を自動で解約・未払い扱いにする設定は使わない
- 運用用の制限付きキー（rk_live_）。書き込み: Customers・Customer balance・Checkout Sessions・PaymentIntents（読み取り）・Subscriptions・Subscription Schedules・Invoices・Refunds・Products・Prices・Customer portal。読み取り: Charges・Disputes

```
node scripts/stripe-live-setup.mjs
```

料金・ポータル・Webhook を作り、運用用キーの読み取りを確かめ、Worker Secrets と `wrangler.jsonc` の `STRIPE_LIVE_*` を登録する。モードは変えない。`wrangler.jsonc` の変更は PR にしてマージする。

## 3. 点検と削除

```
node scripts/billing-cutover.mjs status    … 準備がそろっているか
node scripts/billing-cutover.mjs backup    … 控え（個人情報を含む。共有しない）
node scripts/billing-cutover.mjs purge     … 控えを取ってから、サイトから申し込んだデバッグ分を消す（切替時に 1 回）
```

`purge` は受付停止中・テストモードのときだけ動く。管理操作の監査ログ・二次利用の申請・デバッグ配信の設定は消さない。

## 4. 切替

```
node scripts/billing-cutover.mjs switch live      … 点検に通ったときだけ wrangler.jsonc を本番にする → PR をマージ
node scripts/billing-cutover.mjs stage invite     … 許可リスト（SUPPORTER_TEST_USER_IDS）の人だけ受付 → PR をマージ
```

許可リストの本人で、少額の実決済 → 契約 → 配信 → 解約 → 返金を確かめる。問題がなければ次へ進む。

```
node scripts/billing-cutover.mjs stage public     … 一般公開（人数の上限は SUPPORTER_SUBSCRIBER_LIMIT）→ PR をマージ
```

切替後は、最初の 26 日（請求）・月末日 12:00（再決済）・翌月 1 日 0:00（停止）を確認する。

## 5. 止める・戻す

- 非公開にする: `SUPPORTER_PREVIEW_OPEN=false`・`SUPPORTER_PUBLIC_ENABLED=false`・`SUPPORTER_REVIEW_ENABLED=false`（2026-11-25〜。許可リストの人と管理者以外には 404。審査用のパスワードは登録したまま止めている）
- もう一度テスト公開するとき: `SUPPORTER_PREVIEW_OPEN=true`。審査担当者にだけ見せるとき: `SUPPORTER_REVIEW_ENABLED=true`
- 正式公開のとき: 「開発者紹介」の案内（有料プランで応援する）を戻す

- 新しい受付だけを止める: `node scripts/billing-cutover.mjs stage pause`（契約者の解約・支払い方法の変更・配信は続く）
- 契約者がいる間は、モードをテストに戻さない（配信の設定が更新されなくなる）
