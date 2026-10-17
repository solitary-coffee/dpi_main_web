# 統合管理センターと二次利用者向けメール

本番適用は、従来どおりGitHub、Cloudflare Dashboard、AWS Management Console（CloudShellを含む）のブラウザー画面だけで行える。手順は `docs/browser-production-deploy.md` を参照する。

## 追加される管理機能

- `/site/admin-center/`
  - Cloudflare Worker、D1、Queue、Email Routing、Accessの設定状態
  - 二次利用申請、購読者、メール配信、IP遮断、管理操作履歴
  - AWS Lambda、API Gateway、SQS/DLQ、DynamoDB、CloudWatch Alarm/Logs、CloudFormation、バックアップEC2
  - DynamoDBのハートビートテーブルを設定した場合の自宅サーバー状態
- `/site/mail-admin/`（お知らせ一括配信）
  - 購読者と許可済み二次利用者を個別または同時に選択
  - 許可済み二次利用申請のDiscordサーバーを選択し、登録チャンネルへ一括配信
  - 現在の配信枠一覧から複数選択
  - 選択した配信枠を申請中の `delivery_types` に含む許可済み二次利用者だけを配信対象にする
  - `DPI_Bot通知`（運営からのお知らせ）は許可済み二次利用者全体を対象にする
  - 送信前に重複除外後の実際の対象件数を再計算
  - Discord送信時はメンションを無効化し、Queueで1チャンネルずつ送信

## データベース移行

Workerを切り替える前にD1マイグレーションを適用する。
その前に、管理者のメールアドレスをカンマ区切りで `ADMIN_EMAILS` Secretへ登録する。
許可リストをリポジトリの `vars` に保存しない。

```bash
npx wrangler secret put ADMIN_EMAILS
```

```bash
npx wrangler d1 migrations apply dpi-newsletter --remote
```

`0006_admin_center_and_reuse_mail.sql` はキャンペーンの送信先種別・配信枠、送信先メール、管理監査ログを追加する。

## AWS運用API

`aws/channel-directory-api/template.yaml` をSAMで更新する。既存のBearer tokenとFunction URLはそのまま使用し、`?view=system` で読み取り専用サマリーを返す。

| パラメータ | 用途 |
|---|---|
| `MonitoredTableNames` | 管理画面に表示するDynamoDBテーブル名をカンマ区切りで指定 |
| `HomeServerTableName` | 任意。自宅サーバーのハートビートテーブル |

ハートビートは `status` が `healthy` / `ok` / `online` / `running` のいずれかで、`lastHeartbeat`、`last_heartbeat`、`updatedAt`、`updated_at`、`time` のいずれかが5分以内のレコードを正常と判定する。

## 配信上の安全性

- 二次利用者は `reuse_applications.status = 'approved'` の連絡先だけを使用する。
- Queue実行時にも許可状態を再確認し、取消・停止後の対象はスキップする。
- 購読者と二次利用者で同じメールアドレスが登録されている場合は1通に重複除外する。
- 二次利用者向けメールには購読解除トークンを発行せず、二次利用申請の確認・利用停止導線を表示する。
- 管理APIはCloudflare Access認証と管理者メールアドレスの許可リストを引き続き必須とする。
