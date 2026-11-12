# 利用者アンケート連携

## 構成

1. `/site/survey/` で既存のDiscord OAuthセッションを確認します。
2. DiscordユーザーIDに対する回答者UUIDをD1で初回発行し、以後は同じUUIDを使用します。
3. 回答開始時に30分有効のワンタイムトークンを発行し、回答者UUIDを内包した1つの回答アクセストークンとしてGoogleフォームへ事前入力します。
4. Google Apps Scriptが送信時に署名付きでWorkerへ照会し、回答アクセストークンから復元したUUIDとトークンが一致する回答だけを有効化します。
5. 回答編集URLはAES-GCMで暗号化してD1に保存し、回答済みユーザーは公式サイトから編集画面へ戻れます。

GoogleフォームのURLはブラウザーで開いた時点で回答者本人には見えます。完全な秘匿はできないため、URL自体ではなく、短時間トークンと送信後検証で漏えい時の不正回答を防ぎます。

## Cloudflare設定

次の値はリポジトリやログへ保存せず、Worker Secretとして設定します。

```sh
npx wrangler secret put SURVEY_FORM_URL
npx wrangler secret put SURVEY_SUBMISSION_SECRET
npx wrangler secret put SURVEY_DATA_SECRET
```

- `SURVEY_FORM_URL`: Googleフォームの回答用URL
- `SURVEY_SUBMISSION_SECRET`: Apps ScriptとのHMAC署名に使用する32バイト以上のランダム値
- `SURVEY_DATA_SECRET`: 回答編集URLの暗号化に使用する別の32バイト以上のランダム値

`SURVEY_TOKEN_ENTRY_ID` は公開用の項目識別子であり、`wrangler.jsonc` に設定します。フォームURLとSecretは公開設定へ入れません。

## Google Apps Script

フォームに `google-apps-script/survey/Code.gs` を紐付けます。Script Propertiesへ次を設定します。

- `SURVEY_CALLBACK_URL`: `https://dpi-bot.com/api/survey/google-submit`
- `SURVEY_SUBMISSION_SECRET`: Workerと同じ値

`setupSurveyForm` を1回実行し、メール収集、回答編集、項目検証、送信トリガーを設定します。

## D1とデプロイ

```sh
npx wrangler d1 migrations apply REUSE_DB --remote
npm run check
npm test
npx wrangler deploy
```

本番フォームの公開は、Worker Secret、D1 migration、Apps Scriptトリガー、Discordログインからの新規回答・編集の確認後に行います。
