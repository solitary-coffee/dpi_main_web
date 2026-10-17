# 従来どおりブラウザーから本番へ適用する

ローカル端末は使用しない。GitHub、Cloudflare Dashboard、AWS Management Consoleのブラウザー画面だけで適用する。新しいGitHub Actionsのデプロイ基盤は追加しない。

## 1. Cloudflare D1を先に更新

PRをマージする前にCloudflare Dashboardで次を開く。

`Workers & Pages` → `D1 SQL database` → `dpi-newsletter` → `Console`

PR #33の `migrations/0006_admin_center_and_reuse_mail.sql` を開き、SQLを上から順にConsoleへ貼り付けて実行する。すべて追加項目のため、現行Workerの動作には影響しない。

実行後、`newsletter_campaigns` に `recipient_groups`、`delivery_slots`、`target_server_ids`、`newsletter_deliveries` に `recipient_email`、`recipient_kind`、`recipient_reference` があることを確認する。

## 2. CloudflareのSecretを確認

Cloudflare Dashboardで次を開く。

`Workers & Pages` → `main-dpi` → `Settings` → `Variables and Secrets`

次をSecretとして登録または確認する。値をGitHubへ保存しない。

| Secret | 用途 |
|---|---|
| `ADMIN_EMAILS` | 管理を許可するメールアドレス（複数はカンマ区切り） |
| `DISCORD_BOT_TOKEN` | 許可済みサーバーへのお知らせ投稿 |
| `AWS_CHANNEL_DIRECTORY_URL` | AWS配信先・運用情報APIのURL |
| `AWS_CHANNEL_DIRECTORY_TOKEN` | 上記APIのBearer token |

既存の `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`、メール配信、reCAPTCHA、Discord OAuthのSecretもそのまま維持する。

## 3. GitHubでPRをマージ

GitHubでPR #33を開き、変更内容とテスト結果を確認してマージする。

従来のCloudflare Git連携が `main` の更新を検知し、`main-dpi` をデプロイする。Cloudflare DashboardのDeploymentsで成功を確認する。

## 4. AWSをブラウザー内のCloudShellから更新

AWS Management Console右上のCloudShellを開く。CloudShellはブラウザー内で動作するため、ローカル端末は不要。

リポジトリを取得し、PRマージ後の `main` をSAMで更新する。

```bash
git clone https://github.com/solitary-coffee/dpi_main_web.git
cd dpi_main_web/aws/channel-directory-api
sam build
sam deploy --guided
```

既存スタックを更新するため、次を既存設定に合わせる。

| 項目 | 値 |
|---|---|
| Stack Name | 既存のチャンネル検索APIスタック |
| Region | 既存スタックと同じリージョン |
| `DirectoryApiToken` | 現在使用中のtoken |
| `TableName` | 現在の配信先テーブル |
| `MonitoredTableNames` | 管理画面で監視するDynamoDBテーブル名（カンマ区切り） |
| `HomeServerTableName` | 自宅サーバーのハートビートテーブル。未使用なら空欄 |

CloudFormationの変更セットを確認し、既存スタックの更新として実行する。新規スタックを作らない。

## 5. ブラウザーで動作確認

Cloudflare Accessでログインし、次を確認する。

1. `https://dpi-bot.com/site/admin-center/` でCloudflare、AWS、自宅サーバー、件数、ログを確認
2. `https://dpi-bot.com/site/reuse-admin/` で申請の閲覧・編集・審査を確認
3. `https://dpi-bot.com/site/mail-admin/` でメール、二次利用者、Discordサーバー、配信枠、対象サーバーを選択
4. 対象件数とプレビューを確認して下書きを保存
5. 最初は管理用のテスト対象だけを選び、配信後の送信数・失敗数・ログを確認

管理操作はすべて上記Web画面から行う。日常運用でCloudflareやAWSのコンソールを開く必要はない。
