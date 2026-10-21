# XML Embedプレビューと稼働モードの適用

PRには管理画面、管理API、配信ランタイムの更新スクリプトとテストを含む。
マージと本番ランタイム更新は別作業。マージだけで全配信元が対応済みになるわけではない。
全7構成要素（自宅、EC2 4台、東京/大阪のAWS配信段）の更新証跡が揃うまで、新モードの操作はAPI側でも拒否する。
既存の通常・バックアップ固定・自動監視は、更新証跡が揃うまでは従来の制御を使用する。

## 変更内容

- XML管理配信で実際に送るDiscord JSONを共通レンダラーで生成し、Embedプレビューと送信で共有する。
  本文は省略せず分割し、40メッセージを超える場合は拒否する。
  XML・配信枠・経路・レンダラーバージョンのダイジェストを送信時に再検証する。
  自動配信の種別別レンダラーの移植ではなく、XML管理配信の共通形式。
- モード要求、各ノードの設定、更新証跡、最新の反映確認を別々に表示する。
  休止中・未確認ノードを「反映済み」とは表示しない。
- 自宅中央送信・直接フォールバック・直接Discord・訓練・避難情報、EEW/気象EC2、
  AWS受付と最終workerへ停止/待機制御を接続する。高速・SQS・リージョン内/相互バックアップも最終workerで確認する。
- 管理操作と自動監視のEC2操作を東京の同一DynamoDBレコードで排他制御する。
  固定モードでも死活監視を継続し、自動的なEC2状態変更を抑止する。
- 緊急停止時と解除時の破棄境界より古い電文、および境界設定後の時刻不明電文を拒否する。
  SQSの一括削除は行わない。拒否後の再試行/DLQ遷移は既存キュー設定に従う。

| モード | 自宅 | EC2 |
|---|---|---|
| 自動監視 | 既存動作 | 既存の死活・復旧判定 |
| 通常 | 即時 | 基本2台は3秒待機、残り2台は停止配置。既存EEW高速条件を維持 |
| スタンバイ | 即時 | 基本2台即時、補助2台3秒待機 |
| バックアップ | 稼働時は即時 | 全台待機なし |
| 手動 | 即時/待機/配信停止 | 4台を個別指定。配信停止指定では不要な起動をしない |
| メンテナンス | 即時/待機/配信停止を個別指定 | 4台を個別指定。高速・SQS・リージョン内・相互バックアップも有効/停止/優先順位を指定 |
| 緊急 | 即時 | 自宅の生死に関わらず待機なし。EC2の起動時間は別途必要 |
| 緊急停止 | 配信停止 | 配信停止。稼働中の制御エージェントは維持 |

二重配信防止は維持する。既に送信中のHTTP要求や送信済み通知は撤回できない。
稼働モードで止めるのは電文/通知の送信。監視・ハートビートなどの制御通信は継続する。

## 更新順序

1. PRをマージする。Cloudflareへのログイン・Git連携のデプロイ確認は管理者が行う。
2. AWS CloudShellで管理APIとAWS配信ランタイムを更新する。
3. 各EC2と自宅の既存コードへランタイム更新を適用し、対象サービスを再起動する。
4. 管理画面で7要素の更新証跡と、稼働中ノードの反映確認を確認する。

AWSのコード更新は秘密情報を取得・表示する必要がない。ダウンロードした本番ZIPと更新計画は
復旧用の非公開ディレクトリに保管し、GitHubへ追加しない。
以下のシェルコマンドはCloudShell/サーバーのシェル用。D1のSQL Consoleへ貼り付けない。

### AWS配信ランタイム（CloudShell）

マージ後のリポジトリで実行する。最初のコマンドは読み取りのみで更新計画を作成し、
次のコマンドでその計画を適用する。既存のレイヤー、環境変数、設定を維持する。

```bash
git clone https://github.com/solitary-coffee/dpi_main_web.git
cd dpi_main_web
python3 scripts/deploy-mode-aws.py --directory "$HOME/dpi-mode-rollout-v2"
python3 scripts/deploy-mode-aws.py --directory "$HOME/dpi-mode-rollout-v2" --apply
```

既存のチェックアウトでは、変更を退避したうえで `git switch main` / `git pull --ff-only origin main` を行う。
同じ計画の `--apply` は途中から再実行できる。準備後にコード/ハンドラー/ロールが外部変更された場合は拒否する。
失敗した関数は元ZIP/ハンドラーへ復元し、それまでの検証済み関数は維持する。
全関数の無送信プローブが成功するまでAWSの更新証跡を発行しない。
配信workerが予約同時実行数0で意図的に停止されている場合は有効化せず中断する。
旧手動制御で0になっている監視Lambdaのみ、一時的に1で検証し元へ戻す。

実行者には対象Lambdaの取得・更新・InvokeFunction・同時実行数管理、対象IAMロールの
PutRolePolicy、状態テーブルの更新が必要。スクリプトは既存実行ロールに状態テーブル限定の権限を追加する。
本番通知、モード切替、EC2起動/停止はこのスクリプトでは行わない。

管理APIは [既存のブラウザー適用手順](browser-production-deploy.md) の既存SAMスタックを更新する。
`aws/channel-directory-api` 内の全Pythonモジュールを含めて `sam build` / `sam deploy` を行う。
管理書き込みリージョンは東京（`MODE_AUTHORITY_REGION` の既定値）。両リージョンから同時に管理書き込みを行わない。

### EC2と自宅

`install-mode-runtime.py` は既存ソースの挿入点を厳密に検証する。
V1適用済み環境から更新する場合だけ `--upgrade-v2` を付ける。未適用ソースへこの指定は使えず、
ソースの版やV1マーカーが一致しない場合は推測で書き換えず停止する。
本番の私有ソースは公開リポジトリへ含めない。

| 対象 | kind | node | root | 再起動サービス |
|---|---|---|---|---|
| 東京EEW | eew | tokyo-eew | `/opt/dpi-bot-final-backup/app` | `dpi-bot-final-backup.service` |
| 大阪EEW | eew | osaka-eew | `/opt/dpi-bot-final-backup/app` | 同上 |
| 東京気象 | weather | tokyo-weather | `/opt/dpi-bot-weather-backup/repo/Di` | `dpi-weather-receiver.service` と `dpi-weather-sender.service` |
| 大阪気象 | weather | osaka-weather | 同上 | 同上 |
| 自宅 | home | home | 既存私有リポジトリの `Di` | 既存の管理画面から中央送信・各受信プログラム・health agentを再起動 |

EC2はブラウザーのSystems Manager Session Managerから実行できる。
停止中のEC2は更新時に起動し、更新証跡を確認後、元の停止配置へ戻す。
各EC2のインスタンスロールに、状態テーブル `DPI-BackupFleetState-v51` の
`dynamodb:GetItem` / `dynamodb:PutItem` を追加する（対象リージョンのテーブルARNに限定）。
`.dpi-mode` にはサービス実行ユーザーの書き込み権限が必要。

東京EEWの例（公開リポジトリのルートで実行）:

```bash
sudo systemctl stop dpi-bot-final-backup.service
sudo python3 scripts/install-mode-runtime.py eew \
  --root /opt/dpi-bot-final-backup/app --node tokyo-eew --region ap-northeast-1 --upgrade-v2 --apply
sudo systemctl start dpi-bot-final-backup.service
```

気象は2サービスを停止して `kind=weather` と表のroot/nodeへ置き換え、両サービスを再起動する。
大阪は `--region ap-northeast-3`。既存サービスと同じPython環境にboto3が必要。
サービス実行ユーザーがroot以外の場合は、作成された `.dpi-mode` の所有者をそのユーザーへ合わせる。

自宅は既存のブラウザー管理/リモート操作手段から、私有リポジトリのDiパスを指定する:

```bash
python3 scripts/install-mode-runtime.py home \
  --root /path/to/dpi_code/Di --node home --region ap-northeast-1 --upgrade-v2 --apply
```

`/path/to/dpi_code/Di` は実際の設置場所へ置き換える。自宅のパスやサービス管理方式はインストーラーが推測しない。
自宅のAWSキー追加は不要。認証済みhealth heartbeat応答で制御設定を受け取る。
health agentを先に起動し、新鮮な設定を受け取った後に全送信プロセスを再起動する。
設定を受け取れない間は送信を拒否する。旧プロセスを残したまま反映済みとしない。

インストーラーは元ファイルを `.dpi-mode/backups/<installation-id>` に保存する。
復旧は対象サービスを停止し、表示されたバックアップパスで次を実行して再起動する:

```bash
python3 scripts/restore-mode-runtime.py --root /actual/runtime/root \
  --backup /actual/runtime/root/.dpi-mode/backups/INSTALLATION_ID
```

## 反映確認と負荷

- モードの「要求受付」と「各ノード反映済み」は別。実行中のコードハッシュ・変更番号・ポリシーが
  揃い、90秒以内の証跡がある場合だけ反映済みと表示する。
- AWS Lambdaは常駐プロセスではないため、無送信プローブで確認した更新証跡と、常駐ノードの最新反映確認を区別する。
  AWS更新証跡だけで全Lambdaが同時に停止を確認したとは表示しない。
- 共通ゲートはプロセス単位で5秒キャッシュ、読み取り障害時の有効期限10秒。
  自宅の設定ファイルは45秒以内、heartbeat間隔は有効化時に最大30秒。
  リージョン間複製や設定伝達があるため、ゼロ秒での全系統停止保証ではない。
- 常駐ノードの証跡更新は30秒ごと。送信先ごとのDynamoDB読み取りはしない。
  Lambdaの常時プローブやEC2の常時起動は追加しない。
- 管理操作リース180秒は管理APIのTimeout=120秒より長い。Timeoutを延長する場合はリースも見直す。
- 試験配信は「配信テスト」枠だけを使用する。Lambda一覧は60秒キャッシュし、実行状態は実行中のIDだけを4秒間隔で取得する。
  履歴は最大40実行に制限し、全Lambda試験でも各Lambdaへ送信先を1件ずつ割り当てる。

## 検証

```bash
npm run check
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m compileall -q aws/channel-directory-api scripts
```

公開CIでは、私有ソースが必要な5件を明示的にskipする。
本番から読み取ったソースのローカルコピーにパッチを適用し、
`DPI_PREPARED_RUNTIME_DIR` 指定で5件も実行する。ネットワーク/実配信を使わず、
停止時にHTTP送信や配信権取得へ進まないことを検証する。
他のテストはキャッシュ期限、古い電文の拒否、待機中の停止/緊急変更、競合、
旧プロセス証跡、更新失敗の復旧と再開、XMLプレビュー一致などを検証する。
CIは検証のみで、本番へのデプロイや通知送信は行わない。

2026-10-20の既存EC2確認では、承認済みの東京気象/大阪EEW一時起動後に元の停止状態へ戻した。
その確認は既存動作の確認であり、新ランタイムの本番更新や本番電文のテスト送信ではない。
