# お問い合わせフォーム設定

お問い合わせは同一オリジンの `POST /api/contact` で受け付け、Cloudflare Worker内で検証した後、Cloudflare Email Serviceからメール送信します。FormSubmit等の外部フォームサービスは使用しません。

## 1. Google reCAPTCHA v2

1. Google reCAPTCHA管理画面で「チャレンジ（v2）」「チェックボックス」を作成します。
2. 本番用ドメインに `dpi-bot.com` を登録します。プレビュー環境でも試す場合は、そのホスト名も登録します。
3. CloudflareのWorker `main-dpi` に次の値を設定します。
   - `RECAPTCHA_SITE_KEY`: サイトキー（Secretとして設定）
   - `RECAPTCHA_SECRET_KEY`: シークレットキー（必ずSecretとして設定）
4. 許可ホストを変更する場合は、`wrangler.jsonc` の `RECAPTCHA_ALLOWED_HOSTS` をカンマ区切りで更新します。

CLIで設定する場合は次のコマンドを使用できます。

```bash
npx wrangler secret put RECAPTCHA_SITE_KEY
npx wrangler secret put RECAPTCHA_SECRET_KEY
```

キーが未設定の間はフォームを有効化せず、メールでの問い合わせ案内を表示します（安全のためフェイルクローズ）。

## 2. Cloudflare Email Service

1. Cloudflareの「Email Service」→「Email Routing」で `dpi-bot.com` を登録し、表示されるDNS設定を完了します。
2. 「Destination Addresses」に実際に受信するメールアドレスを追加し、確認メールから認証を完了します。
3. `support@dpi-bot.com` 宛ての通常メールも受信する場合は、`support` から手順2の認証済みアドレスへ転送するRouting Ruleを作成します。
4. `noreply@dpi-bot.com` をWorkerの送信元として利用します。

`CONTACT_EMAIL` のSend Emailバインディングは `wrangler.jsonc` に定義済みです。

お問い合わせの実受信先は、Cloudflare Worker `main-dpi` のSecretとして次の名前で登録します。

- 名前: `CONTACT_TO_EMAIL`
- 値: 手順2で認証した実際の受信先メールアドレス

Cloudflareダッシュボードでは「Workers & Pages」→ `main-dpi` →「Settings」→「Variables and Secrets」→「Add」から、種類を `Secret` にして登録します。CLIを使用する場合は次のコマンドです。

```bash
npx wrangler secret put CONTACT_TO_EMAIL
```

`CONTACT_TO_EMAIL` は平文の `vars` には保存せず、Cloudflare上のSecretだけで管理します。Workerは送信処理の開始前にこの値を確認し、未設定なら `503 service_not_configured` で拒否するフェイルクローズ構成です。

`wrangler.jsonc` の `secrets.required` には、次の3件を宣言しています。

- `CONTACT_TO_EMAIL`
- `RECAPTCHA_SECRET_KEY`
- `RECAPTCHA_SITE_KEY`

これにより、いずれかが対象Worker版へ関連付いていない場合は `wrangler deploy` と `wrangler versions upload` を失敗させ、設定不足の版が成功扱いで配信されることを防ぎます。Secretの値自体はリポジトリ、Wrangler設定、ビルドログへ保存しません。

Secretを登録した後にコードをデプロイしてフォームが `service_not_configured` になった場合は、現在の本番版へSecretが関連付いていない可能性があります。「Workers & Pages」→ `main-dpi` →「Settings」→「Variables and Secrets」で上記3件を再入力し、必ず「Deploy」を押してください。その後、失敗したGit連携ビルドを再試行します。

Secretを追加・更新しても、すでに失敗したGit連携ビルドは自動では再実行されません。登録後にCloudflareのビルド画面から再試行するか、新しいコミットでビルドを起動してください。

Workers Freeプランで「確認済み送信先」だけへ送信する場合、`CONTACT_TO_EMAIL` には `support@dpi-bot.com` のような転送元アドレスではなく、Cloudflare上で認証済みの実受信先アドレスを設定してください。

## 3. デプロイ前確認

```bash
npm test
npm run check
npx wrangler deploy --dry-run
npx wrangler deploy
```

ローカルで確認する場合は、Git管理対象外の `.dev.vars` に必要なSecretを設定します。

```dotenv
CONTACT_TO_EMAIL="認証済みの実受信先メールアドレス"
RECAPTCHA_SITE_KEY="reCAPTCHAのサイトキー"
RECAPTCHA_SECRET_KEY="reCAPTCHAのシークレットキー"
```

デプロイ後は次を確認します。

- `GET /api/contact/config` がHTTP 200で `configured: true` を返す
- reCAPTCHA未完了の送信が拒否される
- PNG、JPEG、TXTまたはLOGを添付して受信できる
- SVG、PDF、Office文書、ZIP、実行ファイルが拒否される
- メールの返信先がフォームに入力したアドレスになる
- 本文に `<script>` を入力しても、プレーンテキストとして表示され実行されない

## セキュリティ上の制限

- 添付は最大3個、1個2MB、合計3MBです。
- PNGはチャンク構造とCRCを検査してメタデータを除去します。
- JPEGは構造と寸法を検査してAPP/コメントメタデータを除去します。
- TXT/LOGはUTF-8で再生成し、MIMEタイプとファイル名を安全な値へ固定します。
- メールはHTMLを生成せずプレーンテキストだけで作成します。
- 添付はサイト上へ保存・公開・実行しません。
- さらに送信回数を制限する場合は、Cloudflare WAFで `/api/contact` のPOSTにIP単位のレート制限ルールを追加してください。
