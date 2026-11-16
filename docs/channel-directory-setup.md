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
  --parameter-overrides \
    "DirectoryApiToken=$TOKEN" \
    "TableName=EarthquakeData" \
    "SupporterRouteTableName=DPI-SupporterRouteSnapshot-ap-northeast-1" \
    "SupporterRouteBucketName=dpi-supporter-delivery-supporterroutesnapshotbucke-1kg0cw6aw6lh"
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

## 有料プラン配信設定の同期

同じFunction URLとBearer tokenは、有料プランの配信設定スナップショットの公開にも使用します。Workerは次のタイミングで、契約が有効な利用者のルールだけを個人情報とStripe識別子を除いて公開します。

- ルール保存後
- Stripeの契約状態変更後
- 管理者による契約解除・アカウント停止後
- 定期請求処理の実行後

Lambdaは暗号化したJSONを `SupporterRouteBucketName` の `snapshots/` に保存し、`SupporterRouteTableName` の `ACTIVE` ポインタを新しい版にだけ更新します。自宅側受信プログラムはこのポインタを読み、ローカルの `data/supporter_delivery_rules.json` を原子的に更新します。Webhook URLはAWSへ送らず、従来どおり自宅側の `disco/info.data.json` からチャンネルIDで解決します。

`SupporterRouteTableName` と `SupporterRouteBucketName` は `dpi-supporter-delivery` スタックの実リソース名と一致させてください。スタック再作成で物理名が変わった場合は、上記の固定値をそのまま使用せず、CloudFormation Outputs/Resourcesで確認した値へ更新します。

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


## 有料配信スナップショットv3のAWS先行適用（Issue #131）

地域別の判定条件はv2、EEWの`sendFinalReport=false`を含むルールはv3のスナップショットになります。**DPI-BotのWeb側PR #127/#128をマージする前に、AWS東京の公開APIがv1/v2/v3をすべて受け付ける状態であることを確認してください。** 大阪の専用配信Lambdaの更新とは別の処理です。

AWS東京のCloudShellに本リポジトリの`aws/channel-directory-api/deploy_schema_v3.py`を配置して、以下の順に実行します。

```bash
python3 aws/channel-directory-api/deploy_schema_v3.py --check
# 元のZIPのCodeSha256、保持するモジュール、v1/v2/v3受付・v4拒否を確認
python3 aws/channel-directory-api/deploy_schema_v3.py --apply
# Lambdaコードのみを更新。S3 ACTIVEやDynamoDBルール、EC2、運用モードは変更しない
```

このスクリプトは**実際に稼働するLambda ZIPをGetFunctionで取得し、元のZIPをCloudShellへ保存してから、`_validate_supporter_snapshot`関数内のスキーマ判定の2箇所だけを更新します**。コードが想定と異なる場合は中止します。元のZIPは`~/dpi-snapshot-v3-rollback/original.zip`に保管されます。Lambda更新には`lambda:GetFunction`、`lambda:UpdateFunctionCode`などの適切な権限が必要です。

万一問題が起きた際は、同じCloudShellで

```bash
python3 aws/channel-directory-api/deploy_schema_v3.py --rollback
```

を使用します。ロールバックは**更新後のコードSHAが予定どおりである場合だけ**実行します。CloudShellの保存フォルダーを消去しないでください。

```bash
python3 -m unittest tests/test_aws_supporter_snapshot_v3.py -v
```

でもAWSを一切変更しないオフラインテストが可能です。**AWSの更新・自宅側の受信機構検証を完了するまで、v3スナップショットを本番公開しないでください。** Web側のmainへのマージではCloudflare D1マイグレーション・Workerデプロイが自動起動するため、#127→#128の順でマージし、Cloudflare Actionsの結果を確認します。
