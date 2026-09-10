# サブスク管理サイト（開発用）

ページ：`/site/subscriptions/`。ご支援ページからアクセスできます。
前回納品の `DPI-Bot_Subscriptions_DEV.zip` に含まれるサイトを本リポジトリへ移植しています。
自宅Bot側の変更は https://github.com/solitary-coffee/dpi_code/pull/79 です。

## 接続構成

ブラウザー → 当サイトの `/api/subscriptions-dev/*` → 開発専用AWS API。
Discordログイン・Stripe Checkout・Webhook・DynamoDBの処理は前回のAWSコードが担当します。
Web側だけで加入済みや管理者権限を判定しません。
StripeのWebhookはAWSの `/webhooks/stripe` に直接設定します。

既定では無効です。Cloudflareの開発用Workerにだけ以下を設定してください。
本番Workerへの設定・デプロイ、本番データの移行は本PRでは行いません。

| 変数 | 設定 |
|---|---|
| SUBSCRIPTIONS_DEV_ENABLED | `true` |
| SUBSCRIPTIONS_DEV_PUBLIC_ORIGIN | 開発用サイトのHTTPS origin（末尾スラッシュなし） |
| SUBSCRIPTIONS_DEV_API_ORIGIN | 開発用AWS HTTP APIのHTTPS origin（末尾スラッシュなし） |

東京／大阪の `*.execute-api.ap-northeast-1.amazonaws.com` / `ap-northeast-3` 形式の固定接続先のみ許可します。
Originにポート・パス・クエリ・ユーザー情報を含められません。
開発用サイトのOriginが完全一致しないと接続できないため、設定が別のプレビューに引き継がれても有効になりません。
StripeやDiscordの秘密値をCloudflareの公開JSやこのリポジトリに追加しないでください。

## AWS／Discordの接続設定

前回ZIPの `configure.py` はAWS URLを `origin` として保存します。
今回はWeb側が入口になるため、CloudShellで設定後、SSM `/dpi-subscriptions/dev/config` のJSONの
`origin` を **SUBSCRIPTIONS_DEV_PUBLIC_ORIGIN と同じ開発用サイトorigin** に変更してください。
それ以外の秘密値・environment=devは維持します。

CloudShell上の例（秘密値は出力しません）：

```python
import boto3, json, time
origin = input('開発用サイトのHTTPS origin: ').strip().rstrip('/')
from urllib.parse import urlsplit
u = urlsplit(origin)
assert u.scheme == 'https' and u.hostname and not u.path and not u.query and not u.fragment and not u.username and not u.password and not u.port
ssm = boto3.client('ssm', region_name='ap-northeast-1')
name = '/dpi-subscriptions/dev/config'
data = json.loads(ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value'])
assert data['environment'] == 'dev' and data['stripe_secret_key'].startswith('sk_test_')
data['origin'] = origin
ssm.put_parameter(Name=name, Value=json.dumps(data), Type='SecureString', Overwrite=True)
cf = boto3.client('cloudformation', region_name='ap-northeast-1')
outputs = cf.describe_stacks(StackName='dpi-subscriptions-dev')['Stacks'][0]['Outputs']
function = next(x['OutputValue'] for x in outputs if x['OutputKey'] == 'FunctionName')
boto3.client('lambda', region_name='ap-northeast-1').update_function_configuration(FunctionName=function, Description='DPI dev site origin ' + str(int(time.time())))
```

`configure.py` を再実行した場合はoriginを再設定してください。
DiscordのOAuth2 Redirect URLは **開発用サイトorigin + `/auth/callback`** に設定します。
StripeのテストWebhookは引き続き **AWS API origin + `/webhooks/stripe`** です。

Bot側PR #79の `DPI_SUBSCRIPTION_PORTAL_DEV_URL` は開発用サイトのoriginに設定してください。
明示的に有効化した開発用ホストに限り、ルート `/` は管理画面へリダイレクトします。
通常の本番サイトではこの設定を有効にせず、従来どおりトップページを表示します。
AWS URLをBotのリンクに使うとOAuth state Cookieのドメインが一致しないため、必ずサイトのoriginを使用してください。

## 動作

- 応援プラン、専用配信設定、契約状況、開発者の既存加入者紐付け機能を移植。
- ID・権限・サブスク判定、CSRFとOriginの検証はAWS側でも実施。
- 別サイトのCookieはAWSへ転送せず、`dpi_session` / `dpi_oauth` のみ転送。
- OAuth後は管理画面に戻り、決済後の `/?checkout=success` / `cancel` も管理画面に移動。
- 旧設定API、本番Stripe Payment Link、既存の寄付ボタン・お問い合わせ・メール配信は変更しない。
- 設定がない場合は準備中表示で、AWSへ通信しない。
- 専用配信は設定JSONの保存までで実配信しない。

## 検証

`npm test` とJavaScriptの構文確認を実施します。
追加テストは通信をモックし、APIの分離、Cookie制限、同一Origin、無効時の拒否、認証と決済の戻り先を確認します。
実Discordログイン・Stripeテスト決済・AWS接続・ブラウザー表示の確認は未実施です。
認証情報設定後に開発用サイトで通し確認してください。
