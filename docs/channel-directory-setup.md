# 配信先検索の設定

管理画面 `/site/channel-admin/` は、次の2つの情報源を同じ形式で検索します。

- D1の二次利用申請データ
- AWS DynamoDB `EarthquakeData` の保存データ

AWS側の検索APIはWebhook URLを返しません。Lambdaは `id`、`Ch_Name`、`app`、時刻、動的なサーバーID・サーバー名だけを検索結果へ変換します。

## AWS検索APIのデプロイ

`aws/channel-directory-api` をCloudShellへアップロードし、東京リージョンで実行します。

```bash
cd aws/channel-directory-api
TOKEN="$(openssl rand -hex 32)"
sam build
sam deploy \
  --stack-name dpi-channel-directory-api \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides "DirectoryApiToken=$TOKEN" "TableName=EarthquakeData"
aws cloudformation describe-stacks \
  --stack-name dpi-channel-directory-api \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ChannelDirectoryUrl'].OutputValue" \
  --output text
```

`TOKEN` はCloudShellのセッションが終了すると確認できません。続けてCloudflare WorkerのSecret `AWS_CHANNEL_DIRECTORY_TOKEN` に同じ値を登録してください。Function URLは `AWS_CHANNEL_DIRECTORY_URL` に登録します。どちらもGitHubへ保存しません。

## Cloudflare側の設定

```bash
npx wrangler secret put AWS_CHANNEL_DIRECTORY_URL
npx wrangler secret put AWS_CHANNEL_DIRECTORY_TOKEN
```

設定後にWorkerを再デプロイします。AWS連携が未設定または一時的に失敗している場合も、二次利用申請の保存データだけで検索画面を利用できます。

## 現在取得できる項目

| 項目 | 二次利用申請 | AWS `EarthquakeData` |
| --- | --- | --- |
| サーバー名・ID | 取得 | 取得 |
| チャンネル名・ID | 取得 | 取得 |
| 配信名 | 取得 | 取得 |
| アナウンスチャンネル | 取得 | 現行データには未保存。Discordから個別取得可能 |
| 閲覧範囲 | 申請内容から取得 | 現行データには未保存 |
| ユーザー数 | Discordから個別取得可能 | Discordから個別取得可能 |
| Discord権限詳細 | Discordから個別取得可能 | Discordから個別取得可能 |

未保存の項目は画面上で「未取得」と表示します。検索結果の「Discord情報を取得」を押すと、既存の `DISCORD_BOT_TOKEN` を使って、そのサーバーの概算ユーザー数、チャンネル種別、主要な権限上書きを取得して表示します。Botが参加していないサーバーや参照権限がないチャンネルは取得できません。
