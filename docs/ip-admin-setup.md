# IP遮断管理画面・Cloudflare Access OTP設定

管理画面URLは `https://dpi-bot.com/site/ip-admin/` です。IP遮断管理画面とAPIは、静的ファイルを返す前にWorkerでもCloudflare Access JWTを検証します。

## 1. D1マイグレーション

本番データベースへテーブルを追加します。

```bash
npx wrangler d1 migrations apply dpi-newsletter --remote
```

追加されるテーブル:

- `ip_block_rules`: 有効なIP・CIDRと遮断理由
- `ip_block_audit`: 追加・削除した管理者、接続元IP、Ray ID、操作日時

Workerにはテーブルの自動作成処理もありますが、本番適用前にマイグレーションを明示的に実行してください。

## 2. Cloudflare Accessへ管理画面を追加

既存のメール管理画面と同じAccessアプリケーションへ、次のパスを追加します。同じアプリケーションへ追加すればAudience (`ACCESS_AUD`) を共有できます。

```text
dpi-bot.com/site/ip-admin/*
```

ルートへのアクセスも保護するため、設定画面の仕様に応じて次も対象へ含めます。

```text
dpi-bot.com/site/ip-admin
```

## 3. ワンタイムPINを必須化

Cloudflare Zero Trustで次を設定します。

1. `Zero Trust` → `Integrations` → `Identity providers` → `Add new identity provider` で `One-time PIN` を追加します。
2. 対象Accessポリシーの `Include` は、管理を許可するメールアドレスだけにします。
3. `Require` に `Login methods` → `One-time PIN` を追加します。
4. ポリシーのSession Durationは15分を推奨します。
5. `Include: Login Methods = One-time PIN` だけの設定にはしないでください。メールアドレス制限がないと、任意のメール利用者を許可する構成になります。

OTPは1回限りで、Cloudflareによる発行から10分で失効します。WorkerコードはOTPそのものを扱わず、Accessが発行したアプリケーションJWTの署名、期限、発行者、Audience、管理者メールを再検証します。

## 4. Worker側の許可メール

既存の `MAIL_ADMIN_EMAILS` をそのまま利用できます。今後共通名称へ移行する場合は `ADMIN_EMAILS` をSecretとして登録すると、こちらが優先されます。

```bash
npx wrangler secret put ADMIN_EMAILS
```

入力例:

```text
admin@example.com,operator@example.com
```

## 5. デプロイと確認

```bash
npx wrangler deploy
```

確認項目:

1. 未認証状態で管理画面を開くとAccessログインへ移動する。
2. 許可メールへ届くOTPでのみログインできる。
3. 許可していないメールにはOTPが送信されない。
4. IPルールを追加すると、別回線から403専用画面が返る。
5. ルール削除後、最大約30秒で通常アクセスへ戻る。
6. 操作履歴に管理者、接続元IP、Ray IDが残る。

## 緊急解除

遮断済みIPでも、Cloudflare Access認証を通過した管理者は `/site/ip-admin/` へ到達できます。Access設定自体に問題がある場合は、Cloudflare DashboardまたはWranglerからD1の対象ルールを削除してください。

Secretの `BLOCKED_IPS` はD1ルールとは別に評価されます。管理画面にはSecretの内容を表示しないため、Secret側のルールは次のコマンドで更新または全解除します。

```bash
npx wrangler secret put BLOCKED_IPS
npx wrangler secret delete BLOCKED_IPS
```
