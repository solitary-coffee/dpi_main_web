# 有料プランの画像配信ルール（スナップショット schemaVersion 4）

雨雲レーダー（高解像度版）・津波警報・注意報（図・表）・気象警報（図）・地震情報（図）・緊急地震速報（警報）の図・警報・注意報の表を、有料プランの通知ルールとして設定できるようにする機能です。
Worker 変数 `SUPPORTER_IMAGE_RULES_ENABLED` が `"1"` のときだけ有効になります。`eew-map`（緊急地震速報（警報）の図）と `warning-table`（警報・注意報の表）は、さらに `SUPPORTER_IMAGE_RULES_V2_ENABLED` が `"1"` のときだけ有効です（どちらも初期値はオフ）。オフの間は次のように動作します。

- `/api/supporter/options` は画像ルールの種別を返さず、画面にも表示しません。
- 画像ルールを含む保存リクエストは 400 で拒否します。
- 配信スナップショットから画像ルールを除外します。フラグを戻せば、画像ルールだけを止めるキルスイッチとして使えます。

このフラグは有料サイトの公開設定（`SUPPORTER_PUBLIC_ENABLED` など）とは関係なく、有料サイトは非公開のままです。

## プラン別の機能（`site/supporter/plan-features.js`）

プランごとの機能フラグは `site/supporter/plan-features.js` の `FEATURE_DEFINITIONS` だけで定義しています。Worker（`PLAN_CATALOG[*].features`、`planFeatures()`、`hasFeature()`、`imageTier()`、`featureList()`）、ダッシュボードの `app.js`、管理画面の `supporter-admin/app.js` は、どれもこのファイルを読み込みます。カスタムは、すべての機能を契約ごとに管理者が設定します（`supporter_custom_plans.features_json`、マイグレーション 0032）。

| 機能名 | 内容 | Basic | Plus | Pro |
|---|---|---|---|---|
| `rainfallThreshold` | 文字：既存の雨雲レーダーで1時間降水量の閾値を指定 | — | ○ | ○ |
| `prefectureScope` | 文字：都道府県単位の指定 | — | ○ | ○ |
| `municipalityScope` | 文字：市区町村単位の指定（`prefectureScope` が必要） | — | — | ○ |
| `strictMunicipality` | 文字：指定した市区町村だけの本文抽出（`municipalityScope` が必要） | — | — | ○ |
| `complexConditions` | 文字：AND・OR・追加条件 | — | — | ○ |
| `multiDestination` | 1つのルールから複数チャンネルへ配信 | — | — | ○ |
| `eewMap` | 緊急地震速報（警報）の図：全国 | ○ | ○ | ○ |
| `eewMapRegion` | 緊急地震速報（警報）の図：地方を選ぶ（`eewMap` が必要） | — | ○ | ○ |
| `weatherMap` | 気象警報の図：全国・地方 | — | ○ | ○ |
| `weatherMunicipality` | 気象警報の図：都道府県・市区町村・市区町村の詳細 | — | — | ○ |
| `warningTableNational` | 警報・注意報の表：全国の表 | — | ○ | ○ |
| `warningTableRegional` | 警報・注意報の表：地方の表 | — | — | ○ |
| `warningTableTimeseries` | 警報・注意報の表：時系列の表 | — | — | ○ |
| `warningTableEvery` | 警報・注意報の表：毎回配信（いずれかの表が必要。「内容が変わったときだけ」と「発表のない区域も載せる」は表があれば利用可） | — | — | ○ |
| `hiresRadar` | 雨雲レーダー（高解像度版）：全国・地方・定時配信・線状降水帯 | — | ○ | ○ |
| `hiresRadarThreshold` | 雨雲レーダー（高解像度版）：閾値以上で配信 | — | — | ○ |
| `tsunamiMap` | 津波警報・注意報の図・表：全国・地方 | — | ○ | ○ |
| `tsunamiEnlarged` | 津波警報・注意報の図：発表地域拡大版 | — | — | ○ |
| `earthquakeMap` | 地震情報の図：すべての地震情報 | — | ○ | ○ |
| `earthquakeMapFilter` | 地震情報の図：しきい値・地図の中心 | — | — | ○ |

`imageDelivery` は互換用の派生フラグ（画像ルールの種別が1つでも使えるとき true）で、付与する機能ではありません。種別ごとに作成できるかは `imageTypeAllowed(features, type)`（`IMAGE_TYPE_FEATURES`）で判定します。

マイグレーション 0032 より前のカスタム契約（`features_json` が NULL）は、従来どおり「画像はすべて Pro と同じ＋`rainfallThreshold`＋旧列の権限（`municipality_branching` → `prefectureScope`・`municipalityScope`、`content_extraction` → `strictMunicipality`、`complex_conditions`、`multi_destination`）」として扱います（`legacyCustomFeatureNames()`）。マイグレーションも同じ一覧を書き込みます。旧列は `features_json` と同期して保存し続けます。

## ルールの項目

すべての画像ルールに共通する項目です。

- `id`, `name`, `type`, `guildId`, `channelId`, `channelIds`：既存のルールと同じ意味です。
- `region`：`earthquake-map`・`eew-map`・`warning-table` 以外で使います（この3種別は `all` に固定）。`all`（全国）、`hokkaido`、`tohoku`、`kanto-koshin`、`hokuriku`、`tokai`、`kinki`、`chugoku`、`shikoku`、`kyushu-north`、`kyushu-south-amami`、`okinawa` のいずれかです。
- `tier`：スナップショットにだけ含めます。値は `supporter`、`plus`、`pro`、`custom` のいずれかで、画像配信を使えるアカウントの契約中の最上位プランを表します。`supporter`（Basic）は `eew-map` のルールにだけ付きます。`features` を読まない古い自宅サーバー向けの互換用です。
- `features`：スナップショットにだけ含めます。ルールの持ち主に付与されている機能名（上表）を昇順に並べた配列です（有効な契約すべての和集合。カスタムは契約ごとの設定）。新しい自宅サーバーは、`features` があれば `tier` の代わりにこれで有料項目を再確認します。

画像ルールは、既存のルール数・チャンネル数・サーバー数の上限に含めて数えます。条件の組み合わせ（`conditionLogic`）と追加条件（`conditions`）は画像ルールには適用しません。保存時は `and` と `[]` に固定します。

種別ごとの項目は次のとおりです。

| type | 項目 |
|---|---|
| `hires-radar` | `linearRainband`（真偽値）、`radarCondition`（`scheduled` または `rainfall-threshold`。`rainfall-threshold` は Pro 以上）、`rainfallThresholdMmPerHour`（10・20・30・50・80 のいずれか。閾値配信のときだけ使用）、`deliveryIntervalHours`（1・2・3・6・12・24 のいずれか） |
| `tsunami-map` | `outputs`（`map` 図・`table` 表から1件以上。省略時は両方。図と表を別々のチャンネルへ送るときはルールを分けます）、`includeTables`（互換用。`outputs` に `table` があれば true。`outputs` が無い古いルールで false なら図だけ）、`enlargedArea`（真偽値、Pro 以上。`outputs` に `map` があるときだけ有効）。指定した地方に注意報以上が発表されたときに配信します。 |
| `eew-map` | `regions`（地方ID の配列。空＝全国：緊急地震速報（警報）が発表されたら配信。指定あり＝選んだ地方が対象地域になったとき（続報で追加された場合も含む）に配信。指定は Plus 以上 `eewMapRegion`）。全国・地方とも同じ図です。 |
| `warning-table` | `tables`（`national` 全国の表・`regional` 地方の表・`timeseries` 時系列の表から1件以上。全国は `warningTableNational`、地方は `warningTableRegional`、時系列は `warningTableTimeseries`）、`regions`（地方の表・時系列の表の対象地方。地方ID の配列で、どちらかの表を選んだときは1件以上必須、全国の表だけなら空）、`deliverOn`（`changed` 内容が変わったときだけ＝初期値、`every` 毎回＝`warningTableEvery`）、`showAllAreas`（発表のない区域も載せる。真偽値）。 |
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

- 契約がない場合は、画像ルールをすべて除外します。Basic になった場合は、全国の `eew-map` だけを送信します（地方を選んだ `eew-map` は除外し、全国へ広げません）。
- `warning-table` は、契約で使えなくなった表だけを外して送信します（表が1つも残らなければ除外）。`every` が使えなくなった場合は `changed` にして送信します（配信が減る方向）。
- 古い隠し設定（`earthquake-map` の `products` に `VXSE43` 緊急地震速報（警報））は保存済みのルールで引き続き受け付け、`eewMap` があるときだけ送信します。新しく作る場合は `eew-map` を使います。
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

### `eew-map`・`warning-table`・`features` の追加時（2026-11-21）

古い検証処理（自宅サーバー・AWS Lambda）は、`eew-map` を含むスナップショット全体を拒否します（AWS Lambda は `warning-table` も拒否します）。必ず次の順番で行ってください。

1. **自宅サーバー（dpi_code）**：`eew-map` を受け付け、`features` を読む版を配備し、全受信プロセスとファイル同期を再起動します。EC2 予備機も更新します。
2. **AWS Lambda**：`deploy_schema_v4.py --check` → `--apply`。`earthquake-map` までの v4 検証処理も置き換えの対象です（`eew-map` は `tier` が `supporter` でも受け付け、それ以外の画像種別は従来どおり `plus`・`pro`・`custom` だけ）。
3. **D1**：`migrations/0032_supporter_custom_plan_features.sql` を適用します（サイトの配備より前。カスタム契約の保存で `features_json` 列を使います）。
4. **サイト（Worker）**：`SUPPORTER_IMAGE_RULES_V2_ENABLED` はオフのまま配備します。`features`・`outputs` の追加は古い自宅サーバーでも無視されるだけです（ただし古い自宅サーバーは表だけの津波ルールにも図を送ります）。
5. 1〜2 の完了を確認してから `SUPPORTER_IMAGE_RULES_V2_ENABLED=1` を設定します。

問題が起きたら、まず `SUPPORTER_IMAGE_RULES_V2_ENABLED`（新しい2種別だけ）または `SUPPORTER_IMAGE_RULES_ENABLED`（画像ルールすべて）を外してください。次にスナップショットを生成したときに画像ルールが除外され、schemaVersion は 1〜3 に戻ります。
