# DPI-Bot 有料機能・EEW テスト環境検証記録（2026-11-16）

## 実施範囲

Stripe接続先は**DPI-Bot / test mode（livemode=false）**に限定し、実ユーザーのサブスクリプション・決済・残高は変更しない。自宅Windows本番配信、AWS本番送信先へのテスト電文は発火しない。

| 対象 | 検証方法 | 結果 |
| --- | --- | --- |
| Basic 300円 | StripeテストPriceの有効性・JPY月額・都度決済Checkout生成を実APIで確認 | 成功（未決済） |
| Plus 800円 | 同上 | 成功（未決済） |
| Pro 1,280円 | 同上 | 成功（未決済） |
| 追加オプション200円 | StripeテストPriceの有効性・JPY月額を実APIで確認 | 成功 |
| クレジットチャージ500円 | テストCheckoutの金額とモードを実APIで確認 | 成功（未決済・DB反映未確認） |
| カスタム月額1,000円・初回 | 当初のsubscription-mode Checkoutで26日アンカー日割り326円を確認 | 仕様不一致、Issue #129 |
| カスタム初回の修正案 | payment-mode Checkoutで満額1,000円を実APIで確認。決済後に初めて月額Subscriptionを作るよう変更 | Checkout生成成功（未決済） |
| カスタム増額・減額・同額 | Stripeモック＋D1モックで追加請求額、次回月額、旧権限維持、再送冪等、障害復旧をテスト | GitHub Actions成功 |
| Basic / Plus / Pro / クレジット残高処理 | 既存のNode単体・異常系・Webhookモックテストを継続 | GitHub Actions成功 |
| GitHub版EEW配信初報修正 | 条件判定の修正、初報・上昇・非上昇・地域未確定テスト | dpi_codeの6系列CI成功／PR #169・#171マージ |
| AWSの現行ルール | DynamoDB ACTIVE→S3のスナップショットを**読み取り専用**で検証 | 現行schemaVersion=1、EEW intensityMode=increase、計3ルール |
| AWS本番・自宅本番への反映 | 自宅Windows接続・EC2ローカル変更の衝突を安全に処理する必要あり | **未完了** |

## 詳細と区別すべき事実

- StripeのテストSession作成成功は、**実際のカード決済、Webhook到達、D1契約有効化、Discord配信成功を証明しない**。
- Stripeサブスクリプション初回の26日アンカーは、標準動作では日割りになる。通常プランに合わせるため、カスタムも満額都度決済→入金確認→`proration_behavior=none`で毎月26日の月額Subscription作成に改修（Issue #129）。
- 契約中の増額は当月分差額だけのCheckoutとし、支払い確認前に新権限を付与しない。減額は返金なしで次回請求額を変更。
- 購入クレジットの残高、期間後の失効、没収、返金とチャージ履歴は、既存の単体・モックテストに加え**実決済済みテストWebhookとテストD1の統合テストが未実施**。
- 実StripeテストCheckoutは決済を行っておらず、24時間等の有効期限で自動失効する。リリース時にはテストで作成した既存セッションを本番URLとして提示しない。
- AWS東京・大阪の有料配信Lambdaプールは存在しているが、**GitHub側のPRマージのみではLambdaコードや自宅側プロセスは更新されない**。
- AWS大阪の気象EC2には稼働用の追跡外ファイル・ローカル修正があり、`git pull --reset`等の強制更新は実施しない。
- Webの`main`へのPRマージはGitHub ActionsによるCloudflare D1 migration・Worker本番デプロイを起動するため、**自宅・AWSルール受信の互換性と決済を確認する前にWeb PR #127/#128をマージしない**。

## 本番相当E2Eの残作業

1. テスト環境にD1 migrations 0025/0026を適用し、Basic/Plus/Pro/Customの契約DBと通知スナップショットを試験する。
2. Stripeテストカードで実際に各Checkoutを完了し、署名検証済みWebhookで請求・契約・クレジット残高・明細を照合する。
3. タイムトラベルテスト（テストクロック等）で毎月26日の請求、26～31日の二か月初回、ダウングレード、未払い後の再請求・停止を検証する。
4. 自宅Windowsの未コミット変更をバックアップ・差分確認してからGitHub `dpi_code` mainを更新、必要な受信・送信プロセスを再起動する。
5. AWS `dpi-channel-directory-api` のschemaVersion 3互換と東京・大阪の専用Lambda・Dispatcher設定を確認し、既存コードZIPの保全とロールバック計画の後に必要分だけ更新する。
6. 実配信とは別の専用WebhookでEEW（初報・第2報・最終報）を発火し、正常配信、二重抑止、プラン権限、遅延を確認。
7. 互換性が確認できてからWeb PR #127→#128を依存順にマージし、Cloudflareデプロイ・D1適用ログ・実環境の配信結果を確認する。

## GitHub

- [EEW Issue #172](https://github.com/solitary-coffee/dpi_code/issues/172)
- [自宅側地域条件 PR #169](https://github.com/solitary-coffee/dpi_code/pull/169)（マージ済み）
- [自宅側EEW修正 PR #171](https://github.com/solitary-coffee/dpi_code/pull/171)（マージ済み）
- [Web地域条件 PR #127](https://github.com/solitary-coffee/dpi_main_web/pull/127)（未マージ）
- [Webカスタム・請求 PR #128](https://github.com/solitary-coffee/dpi_main_web/pull/128)（未マージ）
- [初回料金 Issue #129](https://github.com/solitary-coffee/dpi_main_web/issues/129)
