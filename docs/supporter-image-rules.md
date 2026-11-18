# 有料プランの画像配信ルール（スナップショット schemaVersion 4）

雨雲レーダー（高解像度版）・津波警報・注意報（図・表）・気象警報（図）・地震情報（図）を、有料プランの通知ルールとして設定できるようにする機能です。
Worker 変数 `SUPPORTER_IMAGE_RULES_ENABLED` が `"1"` のときだけ有効になります。初期値はオフで、オフの間は次のように動作します。

- `/api/supporter/options` は画像ルールの種別を返さず、画面にも表示しません。
- 画像ルールを含む保存リクエストは 400 で拒否します。
- 配信スナップショットから画像ルールを除外します。フラグを戻せば、画像ルールだけを止めるキルスイッチとして使えます。

このフラグは有料サイトの公開設定（`SUPPORTER_PUBLIC_ENABLED` など）とは関係なく、有料サイトは非公開のままです。

## プラン別の機能（`site/supporter/plan-features.js`）

プランごとの機能フラグは `site/supporter/plan-features.js` だけで定義しています。Worker（`PLAN_CATALOG[*].features`、`planFeatures()`、`hasFeature()`、`imageTier()`）とダッシュボードの `app.js` は、どちらもこのファイルを読み込みます。

| 機能 | Basic | Plus | Pro | カスタム |
|---|---|---|---|---|
| rainfallThreshold（既存の雨雲レーダーで降水量の閾値を指定） | — | ○ | ○ | ○ |
| prefectureScope / municipalityScope / strictMunicipality | — | 都道府県のみ | ○ | 管理者が設定した権限による |
| imageDelivery（画像ルール） | — | ○ | ○ | ○ |
| hiresRadarThreshold / tsunamiEnlarged / weatherMunicipality / earthquakeMapFilter | — | — | ○ | ○ |

## ルールの項目

すべての画像ルールに共通する項目です。

- `id`, `name`, `type`, `guildId`, `channelId`, `channelIds`：既存のルールと同じ意味です。
- `region`：`earthquake-map` 以外で使います。`all`（全国）、`hokkaido`、`tohoku`、`kanto-koshin`、`hokuriku`、`tokai`、`kinki`、`chugoku`、`shikoku`、`kyushu-north`、`kyushu-south-amami`、`okinawa` のいずれかです。
- `tier`：スナップショットにだけ含めます。値は `plus`、`pro`、`custom` のいずれかで、アカウントが契約中の最上位プランを表します。Basic のルールは画像ルールとして送信しません。

画像ルールは、既存のルール数・チャンネル数・サーバー数の上限に含めて数えます。条件の組み合わせ（`conditionLogic`）と追加条件（`conditions`）は画像ルールには適用しません。保存時は `and` と `[]` に固定します。

種別ごとの項目は次のとおりです。

| type | 項目 |
|---|---|
| `hires-radar` | `linearRainband`（真偽値）、`radarCondition`（`scheduled` または `rainfall-threshold`。`rainfall-threshold` は Pro 以上）、`rainfallThresholdMmPerHour`（10・20・30・50・80 のいずれか。閾値配信のときだけ使用）、`deliveryIntervalHours`（1・2・3・6・12・24 のいずれか） |
| `tsunami-map` | `includeTables`（真偽値、初期値は true）、`enlargedArea`（真偽値、Pro 以上）。指定した地方に注意報以上が発表されたときに配信します。 |
| `earthquake-map` | `products`（`VXSE51` 震度速報・`VXSE52` 震源に関する情報・`VXSE53` 震源・震度に関する情報・`VXSE62` 長周期地震動に関する観測情報から1件以上。省略時は4種類すべて）。Pro 以上（`earthquakeMapFilter`）では `minIntensity`（全国の最大震度のしきい値）、`regionMinIntensity`（`{地方ID: しきい値}`。地方ID は `region` から `all` を除いた11地方）、`centerMunicipality`（地図の中心にする市区町村。7桁の地震情報用 市町村等コード）も指定できます。Pro 以上では `minLgInt`（長周期地震動階級のしきい値 `1`〜`4`。`VXSE62` だけに適用し、震度のしきい値といずれかを満たせば配信。VXSE51/52/53 の配信には影響しない）も指定できます。しきい値は `1`・`2`・`3`・`4`・`5-`（5弱）・`5+`（5強）・`6-`（6弱）・`6+`（6強）・`7` のいずれかです。`region` は使わず、保存時に `all` に固定します。 |
| `weather-map` | `products`（下表の ID から1件以上）、`minSeverity`（`warning` または `advisory`）。Pro 以上では、`prefecture`（`"01"`〜`"47"`）、`municipalities`（その都道府県内の7桁の気象庁コード、最大50件）、`municipalityDetail` も指定できます。都道府県を指定しない場合、スナップショットには `prefecture` を含めません。 |

`weather-map` の `products` に指定できる ID は次のとおりです。すべて Plus 以上で利用できます（都道府県・市区町村の指定などの Pro 限定項目は従来どおり Pro 以上）。新規ルールの初期選択は `VPWW55`〜`VPWW60` だけです。`VPWW61`・`VPHW50`・`VPBS50` は明示的に選択した場合だけ配信し、既存ルールに自動で追加することはありません。

| ID | 表示名 | 配信形式 |
|---|---|---|
| `VPWW55` | 大雨 | 図 |
| `VPWW56` | 土砂災害 | 図 |
| `VPWW57` | 高潮 | 図 |
| `VPWW58` | 暴風雪・暴風 | 図 |
| `VPWW59` | 波浪 | 図 |
| `VPWW60` | 大雪 | 図 |
| `VPWW61` | その他注意報（一覧表） | 表 |
| `VPHW50` | 竜巻注意情報（気象防災速報） | 図（気象防災速報（竜巻注意）／（竜巻目撃）。目撃情報付きの VPHW51 を含む） |
| `VPBS50` | 線状降水帯（発生・直前予測） | 図（気象防災速報（線状降水帯発生）／（線状降水帯直前予測）） |

### 地震情報（図）`earthquake-map`

- Plus：選んだ種類の地震情報をすべて配信します（しきい値なし）。
- Pro・カスタム：しきい値を1つも指定しなければすべて配信し、指定した場合はいずれか1つを満たすと配信します（OR）。震源に関する情報（VXSE52）は、同じ地震の震度速報の震度で判定します（自宅サーバー側の処理）。
- `centerMunicipality` は `site/supporter/earthquake-municipalities.json`（1,894件、約48KB、gzip 約15KB）に含まれるコードだけを受け付けます。保存時に Worker が `env.ASSETS` からこのファイルを読み込んで照合し、読み込めない場合は保存を拒否します（503）。ダッシュボードは同じファイルを都道府県→市区町村の選択肢に使います。ファイルは有料サイトと同じアクセス制限（`/site/supporter/` の限定公開）の下で配信されます。
- 一覧の作り直し：`node scripts/build-earthquake-municipalities.mjs <dpi_code/Di/jma_earthquake_areas.json>`（気象庁 地震火山関連コード表 シート24 の市町村等）。
- スナップショットでは、Pro 限定の項目は Pro・カスタムのアカウントで値があるときだけ出力します。Plus のルールにこれらの項目が含まれると、自宅サーバーはそのルールを無視するためです。

スナップショットの例（Plus）：

```json
{"id": "rule-…", "name": "地震図", "type": "earthquake-map", "guildId": "…", "channelId": "…", "channelIds": ["…"],
 "region": "all", "tier": "plus", "products": ["VXSE51", "VXSE53"]}
```

スナップショットの例（Pro）：

```json
{"id": "rule-…", "name": "地震図（関東）", "type": "earthquake-map", "guildId": "…", "channelId": "…", "channelIds": ["…"],
 "region": "all", "tier": "pro", "products": ["VXSE51", "VXSE52", "VXSE53"],
 "minIntensity": "5-", "regionMinIntensity": {"tohoku": "5+", "kanto-koshin": "3"}, "centerMunicipality": "1310100"}
```

検証処理は次のファイルにあります。

- サイト：`worker/supporter-image-rules.js` の `normalizeImageRuleFields()`。`normalizeSupporterRules()` から呼び出します。
- 自宅サーバー：`dpi_code/Di/supporter_image_rules.py`。`tier` を使って Pro 限定の項目をもう一度確認します。

## ダウングレード時の扱い

ダウングレード後のスナップショットでは、保存済みの絞り込みを黙って広げることはしません（`imageRuleSnapshotFields()`）。

- Basic になった場合や契約がない場合は、画像ルールをすべて除外します。
- Pro から Plus になった場合
  - 閾値配信の `hires-radar` は、ルールごと除外します。
  - 都道府県や市区町村を指定した `weather-map` は、ルールごと除外します。
  - 範囲に影響しない追加機能（`enlargedArea`、`municipalityDetail`）は false にして送信します。
  - 震度のしきい値（`minIntensity`・`regionMinIntensity`）を指定した `earthquake-map` は、ルールごと除外します。地図の中心（`centerMunicipality`）だけを指定したルールは、中心の指定を外して送信します。

保存済みの設定は削除しません。再びアップグレードすると、元の設定で配信を再開します。

## schemaVersion の決め方

- 画像ルールが1件でも含まれる場合は 4 にします。
- 画像ルールがない場合は従来どおりです（EEW の最終報を省略するルールがあれば 3、地域の絞り込みがあれば 2、それ以外は 1）。

## デプロイの順序（必ずこの順番で行う）

1. **自宅サーバー（dpi_code）**：schemaVersion 4 と画像ルールに対応したコードを配備します。古い自宅サーバーは、知らないルール種別を含むスナップショット全体を拒否します。この状態でフラグを有効にすると、画像ルールだけでなく有料配信がすべて止まります。
2. **AWS Lambda（dpi-channel-directory-api）**：CloudShell で、`aws/channel-directory-api/deploy_schema_v4.py` と同じコミットの `lambda_function.py` を同じディレクトリに置き、次を実行します。
   - `python3 deploy_schema_v4.py --check`：読み取り専用の事前確認です。ロールバック用の ZIP を保存します。
   - `python3 deploy_schema_v4.py --apply`：Lambda のコードだけを更新します。ACTIVE のスナップショットや稼働モードは変更しません。
   - `python3 deploy_schema_v4.py --rollback`：問題があったときに元のコードへ戻します。

   このスクリプトは、v1 だけに対応した検証関数と v3 パッチ済みの検証関数を、どちらもリポジトリの検証関数に置き換えます。置き換えた後、v1〜v4 は受け付けて v5 は拒否すること、画像ルールの `tier` と `region` を検査していることを、オフラインで確認します。
3. **サイト（Worker）**：フラグをオフのまま配備します。
4. 自宅サーバーがすべて更新されたことを確認してから、`SUPPORTER_IMAGE_RULES_ENABLED=1` を設定します。限定公開ユーザーで保存とスナップショット（v4、`tier` あり）を確認してください。

### `earthquake-map` の追加時（2026-11-18）

`earthquake-map` はスキーマ v4 のまま追加した種別です。古い検証処理は、この種別を含むスナップショット全体を拒否します。サイトの配備は必ず最後に行ってください。

1. **自宅サーバー（dpi_code）**：`supporter_delivery.validate_snapshot` が `earthquake-map` を受け付ける版で、全受信プロセスとファイル同期（AWS）を再起動します。EC2 予備機も更新します。
2. **AWS Lambda**：`deploy_schema_v4.py --check` → `--apply`。最初の v4 検証処理（`earthquake-map` を含まない版）も置き換えの対象です。
3. **サイト（Worker）**：最後に配備します。D1 のマイグレーションは不要です（ルールは既存の `settings_json` に保存します）。

問題が起きたら、まず `SUPPORTER_IMAGE_RULES_ENABLED` を外してください。次にスナップショットを生成したときに画像ルールが除外され、schemaVersion は 1〜3 に戻ります。
