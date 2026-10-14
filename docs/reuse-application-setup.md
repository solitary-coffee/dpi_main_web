# 二次利用申請機能の設定

## Discord Developer Portal

既存のDPI-BotアプリケーションのOAuth2 Redirectsへ次を追加します。

`https://dpi-bot.com/api/reuse/oauth/callback`

OAuth2では `identify` と `guilds` のみを要求します。申請者のDiscordアクセストークンは保存しません。チャンネル一覧は、DPI-BotのBot Tokenを使い、Botが参加しているサーバーから取得します。

## Cloudflare ランタイム設定

`DISCORD_CLIENT_ID` は公開識別子のため、`wrangler.jsonc` の `vars` に登録済みです。

次の3項目は値をリポジトリへ保存せず、Cloudflare Worker `main-dpi` の
**プロダクション → ランタイム変数とシークレット**へSecretとして登録します。

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put REUSE_SESSION_SECRET
```

Cloudflareダッシュボードのビルド用「変数とシークレット」ではなく、Worker実行時に
参照できる「ランタイム変数とシークレット」へ登録してください。Secretの値は
`wrangler.jsonc`、GitHub、ビルドログへ記載しません。

`REUSE_SESSION_SECRET`には32バイト以上のランダム値を設定してください。例:

```bash
openssl rand -base64 48
```

既存のメール配信管理と同じ次の設定も使用します。

- `NOTICE_EMAIL` binding
- `NOTICE_FROM_EMAIL`
- `NOTICE_REPLY_TO_EMAIL`
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- `ADMIN_EMAILS` または `MAIL_ADMIN_EMAILS`

## D1 migration

本番適用前に次を実行します。

```bash
npx wrangler d1 migrations apply dpi-newsletter --remote
```

## Cloudflare Access

`/site/reuse-admin/*` を既存の管理者向けAccess Applicationへ追加してください。Worker側でもAccess JWTの署名・Audience・許可メールアドレスを検証するため、Access設定がない場合は管理画面を表示しません。

## 動作確認

1. `/site/reuse/` からDiscordログインできる
2. 管理権限を持つサーバーだけが表示される
3. Botが参加するサーバーのテキスト／アナウンスチャンネルを選択できる
4. 申請後、受付メールと受付番号が届く
5. `/site/reuse-admin/` で許可・却下・再申請依頼を実行できる
6. 結果メールのURLから状態確認でき、不備時のみ再申請できる
