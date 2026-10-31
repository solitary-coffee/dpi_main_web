# お知らせメール配信システム設定

この機能は、Cloudflare Workers、Email Service、D1、Queues、Accessと既存のGoogle reCAPTCHAを使用します。外部のメールマガジン／フォームサービスは使用しません。

公開ページは `/site/mail/`、管理画面は `/site/mail-admin/` です。公開登録は二重オプトインで、確認メールのURLを開いた後に確認画面のボタンを押すまで購読は有効になりません。

Discordのお知らせ管理画面は `/site/discord-admin/` です。許可済み二次利用申請のチャンネルから、選択したサーバーと配信枠に一致する送信先だけへ配信します。

## 構成

- D1: 購読者、同意履歴、下書き、配信状況を保存
- Queues: 1受信者につき1メッセージへ分割し、同時実行数1で送信
- Email Service: `notice@dpi-bot.com` から個別送信
- Cloudflare Access: 管理画面と同じパス配下の管理APIを保護
- Worker: Access JWTを再検証し、署名、発行元、AUD、管理者メールのすべてを確認
- reCAPTCHA: 第三者による確認メールの大量送信を抑止

1回の配信上限は1,000件です。To/Cc/Bccで受信者をまとめず、各受信者へ個別に送るため、他の購読者のメールアドレスは表示されません。

## 管理画面の配信機能

- 配信カテゴリは「メンテナンス情報」「障害・重要情報」「アップデート情報」のチップから1つ以上選択できます。
- 複数カテゴリを選ぶと、いずれかを購読している利用者が対象になります。複数カテゴリを購読している同一利用者へ重複送信はしません。
- 各カテゴリのテンプレートを選ぶと、対応するカテゴリ、件名、Markdown本文のひな形が入力されます。入力済みの内容を上書きする場合は確認を表示します。
- 本文は見出し、太字、斜体、箇条書き、番号付きリスト、引用、インラインコード、区切り線、HTTPSリンクのMarkdownに対応します。
- 「メールプレビュー」には、サーバー側の送信処理と同じ変換結果を隔離されたフレームで表示します。配信前に件名、カテゴリ、本文の見た目を確認できます。

Markdown内の生HTML、画像埋め込み、JavaScript URLは使用できません。HTMLタグは文字として扱い、リンクは認証情報を含まないHTTPS URLだけを有効にします。

### Discordお知らせ

- メンテナンス、障害・重要情報、アップデートの3テンプレートを利用できます。
- 通常メッセージまたはEmbedを選択できます。Embedは色も指定できます。
- Discord Markdownをそのまま使用でき、プレビューでは主要な見出し、太字、斜体、リスト、引用、コード、HTTPSリンクを安全なDOMで再現します。
- HTTPS画像URL、またはPNG・JPEG・GIF・WebP画像を1ファイル添付できます。画像ファイルは最大1.25MBで、MIME形式とマジックバイトの両方を検査します。
- 画像ファイルはキャンペーン下書きと一緒にD1へ保存し、Queue処理時にDiscord APIへmultipartで直接送信します。R2や追加Secretは不要です。
- `allowed_mentions` を空にして送信するため、本文に `@everyone` などが含まれてもメンションは発火しません。
- Discordお知らせ管理では、公式サポートサーバーのお知らせチャンネル（`1020702978426028104`）への同時送信を任意で選べます。メンションは画面に登録した3つの公式ロールだけを許可し、本文内のその他のメンションは発火しません。この送信にも既存の `DISCORD_BOT_TOKEN` を使用します。

## 1. D1とQueues

`wrangler.jsonc` には次のバインディングを定義済みです。

- D1: `NEWSLETTER_DB`（データベース名 `dpi-newsletter`）
- Queue producer: `NEWSLETTER_QUEUE`（Queue名 `dpi-newsletter-delivery`）
- Queue consumer: 同時実行数1、最大5回再試行、Dead Letter Queueあり

リポジトリにはD1の `database_id` を保存していません。Wranglerの[自動プロビジョニング](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)により、GitHub連携から初めてデプロイしたときにD1とQueueが自動作成されます。GitHub経由で作られたIDはダッシュボードに表示され、リポジトリへ書き戻されない仕様です。

Workerは初回利用時にもテーブル作成と不足列の追加を行うため、デプロイ直後から使用できます。再現用のマイグレーションは `migrations/0001_newsletter.sql` から `migrations/0008_discord_targeting.sql` にあります。手動適用する場合は次を実行します。

```bash
npx wrangler d1 migrations apply NEWSLETTER_DB --remote
```

## 2. Email Service

`NOTICE_EMAIL` Send Emailバインディングを定義済みで、送信元を `notice@dpi-bot.com` のみに制限しています。Email Sending用のDNS設定が完了していれば、個別の送信元メールボックスを作る必要はありません。

通常の返信を受け取るため、Reply-Toは `support@dpi-bot.com` にしています。変更する場合は `NOTICE_REPLY_TO_EMAIL` を変更してください。送信元を変更する場合は、`NOTICE_FROM_EMAIL` と `allowed_sender_addresses` の両方を同じアドレスへ変更します。

任意の外部宛先への送信にはWorkers Paidが必要です。Cloudflare Email Serviceの現行料金では月3,000通までが含まれ、それを超える分は1,000通当たり課金されます。確認メールも1通として数えられます。最新条件は[公式料金ページ](https://developers.cloudflare.com/email-service/platform/pricing/)を確認してください。

## 3. Secretの登録

Cloudflareダッシュボードで「Workers & Pages」→ `main-dpi` →「Settings」→「Variables and Secrets」から、次をすべて `Secret` として追加します。

| 名前 | 値 |
|---|---|
| `NEWSLETTER_TOKEN_SECRET` | 32バイト以上の推測不能なランダム値 |
| `ACCESS_TEAM_DOMAIN` | `https://チーム名.cloudflareaccess.com` |
| `ACCESS_AUD` | 手順4で作成するAccessアプリのApplication Audience (AUD) Tag |
| `MAIL_ADMIN_EMAILS` | 管理を許可するメールアドレス。複数はカンマ区切り |

`NEWSLETTER_TOKEN_SECRET` は、例えば次のコマンドで生成できます。

```bash
openssl rand -base64 48
```

既存の次のSecretも引き続き必要です。

- `CONTACT_TO_EMAIL`
- `RECAPTCHA_SITE_KEY`
- `RECAPTCHA_SECRET_KEY`

CLIで設定する場合の例です。入力値は画面へ貼り付け、リポジトリやログには保存しないでください。

```bash
npx wrangler secret put NEWSLETTER_TOKEN_SECRET
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
npx wrangler secret put MAIL_ADMIN_EMAILS
```

本プロジェクトは、Git連携の `wrangler versions upload` がダッシュボード登録済みSecretを未設定と誤判定する問題を避けるため、`secrets.required` を使用していません。Workerが処理開始前に実行時検査を行い、未設定時はフェイルクローズします。

## 4. Cloudflare Access

1. Zero Trustダッシュボードで「Access controls」→「Applications」→「Create new application」を開きます。
2. 「Self-hosted and private」を選びます。
3. Public hostnameを `dpi-bot.com`、Pathを `site/mail-admin/*` にします。
4. Allowポリシーを作成し、管理者本人のメールアドレスだけを許可します。可能であればMFAも必須にします。
5. Session Durationは短め（例: 8時間）にします。
6. 作成後、「Additional settings」に表示されるApplication Audience (AUD) Tagを `ACCESS_AUD` へ登録します。
7. Zero Trustのチームドメインを `ACCESS_TEAM_DOMAIN` へ登録します。末尾にパスは付けません。
8. Allowポリシーで許可したメールアドレスと同じ値を `MAIL_ADMIN_EMAILS` へ登録します。

管理UIと管理APIはともに `site/mail-admin/*` の配下にあるため、同じAccessアプリと同じAUDで保護されます。AccessのJWTヘッダーがない、署名が不正、発行元またはAUDが異なる、管理者メールが許可リストにない場合、Workerは管理画面・管理APIの両方を拒否します。

CloudflareはWorkerの前にAccessを置いた場合もWorker内でJWTを検証するよう案内しています。実装は `Cf-Access-Jwt-Assertion` を使用し、チームの公開鍵を自動取得します。詳細は[公式JWT検証ガイド](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)を参照してください。

## 5. デプロイ後の確認

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```

本番では次の順に確認します。

1. `https://dpi-bot.com/api/newsletter/config` が `configured: true` を返す。
2. `https://dpi-bot.com/site/mail/` から自分のメールアドレスを登録する。
3. 確認メールのURLを開くだけでは登録されず、「登録を確定する」を押すと完了する。
4. `https://dpi-bot.com/site/mail-admin/` を開くとCloudflare Accessの認証が要求される。
5. 管理画面で小さな下書きを作成し、対象件数を確認してから配信する。
6. テンプレートを選び、件名と本文が反映され、メールプレビューが表示される。
7. 複数カテゴリを選んだ場合、表示対象件数と実際の個別送信件数が一致し、重複送信されない。
8. 受信メールに、通常の配信停止リンクとワンクリック配信用の `List-Unsubscribe` ヘッダーがある。
9. 配信停止後、管理画面の有効な購読者数が減る。

Secretを追加・更新しても、すでに失敗したGit連携ビルドは自動再実行されません。Cloudflareのビルド画面から再試行するか、新しいコミットでビルドを起動してください。

## セキュリティ仕様

- 公開登録はreCAPTCHA、同一オリジン検査、ハニーポット、送信時間検査、IP単位のレート制限を行います。
- レート制限用IPは生の値で保存せず、Secret鍵付きHMACへ不可逆化します。
- 確認トークンは32バイトの乱数で、D1にはSHA-256ハッシュだけを保存し、24時間で無効になります。
- メール内の配信停止トークンはHMAC署名し、メールアドレス自体をURLへ含めません。
- 確認用URLのGETでは状態を変更しません。メールセキュリティ製品によるリンク自動巡回で誤登録されることを防ぎます。
- 管理者が入力する件名と本文は長さ・制御文字を検査し、HTMLとして直接保存・実行しません。
- Markdownは独自の許可リスト方式で変換し、HTMLを先に解析しません。JavaScript、HTMLタグ、イベント属性、画像埋め込みは実行できません。
- Markdownリンクは認証情報を含まないHTTPS URLだけを有効にし、その他のURLは文字列のまま表示します。
- メールプレビューは同じサーバー側レンダラーを使用し、権限を与えない `sandbox` iframeと管理画面のCSPで隔離します。
- メール配信には添付ファイルを付けません。Discord画像は許可形式、容量、ファイル署名を検査してD1の2MB行サイズを超えない上限で保存します。
- Queueメッセージには配信IDだけを入れ、メールアドレスや本文は入れません。
- 各メールは個別送信し、`List-Unsubscribe`、RFC 8058のワンクリック停止、`List-Id`を付けます。
- Cloudflare Email Serviceが宛先を抑止している場合、購読者を送信抑止状態へ変更します。
- 管理画面では購読者のメールアドレス一覧を表示しません。

## 運用上の注意

- 「配信を開始」を押した後、すでに送られたメールは取り消せません。「取り消す」はQueue内の未送信分だけを停止します。
- Queue登録中に通信が切れた場合は、30秒以上待って履歴の「Queue登録を再開」を使用します。配信IDによる重複抑止があります。
- Queueはat-least-once配信です。送信API成功直後かつD1記録前に実行が中断した極めてまれな場合、同じメールが再送される可能性があります。
- 障害・重要情報カテゴリであっても、災害情報のリアルタイム通知には使用しないでください。
