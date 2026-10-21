import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('AWS配信統計は最新世代だけを集計し24時間・7日・保持期間を提供する', async () => {
    const source = await readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8');
    assert.match(source, /view == "delivery-stats"/u);
    assert.match(source, /\{"24h", "7d", "all"\}/u);
    assert.match(source, /latest_by_delivery/u);
    assert.match(source, /\(generation, updated\) >/u);
    assert.match(source, /"byEventType"/u);
    assert.match(source, /"byTitle"/u);
    assert.match(source, /def _delivery_title/u);
    assert.match(source, /"deliverySlot": _delivery_slot/u);
    assert.match(source, /"deliveryId": _clean\(item\.get\("deliveryId"\)/u);
    assert.match(source, /"seriousErrors"/u);
    assert.match(source, /rows\[:50\]/u);
});

test('DMDATA履歴は固定ドメイン・短時間キャッシュ・配信状態記録を使用する', async () => {
    const [source, template, html, script, worker] = await Promise.all([
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
        readFile(new URL('../aws/channel-directory-api/template.yaml', import.meta.url), 'utf8'),
        readFile(new URL('../site/xml-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/admin-center/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../worker/admin-center.js', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /view == "dmdata-history"/u);
    assert.match(source, /api\.dmdata\.jp.*data\.api\.dmdata\.jp/u);
    assert.match(source, /_dmdata_history_cache/u);
    assert.match(source, /DMDATA#SOURCE#/u);
    assert.match(source, /xmlSha256/u);
    assert.match(source, /hmac\.compare_digest\(dmdata_source\["xmlSha256"\], xml_digest\)/u);
    assert.match(source, /deliveryStateLabel/u);
    assert.match(source, /gd\/eew/u);
    assert.match(source, /"eew-warning"/u);
    assert.match(source, /warning_only=category == "eew-warning"/u);
    assert.match(source, /"warningLabel": "警報発表済み"/u);
    assert.match(source, /dmdata_delivery_state_lookup_failed/u);
    assert.match(source, /"deliveryStateLabel"\] = "状態取得失敗"/u);
    assert.match(source, /def _match_dmdata_monitor_deliveries/u);
    assert.match(source, /_delivery_identity_cache\[period\]/u);
    assert.match(source, /_delivery_identity_cache\.get\("7d"\)/u);
    assert.match(source, /abs\(row\["sourceEpoch"\] - received_epoch\) <= 8/u);
    assert.match(source, /"配信済み（AWS監視記録）"/u);
    assert.match(source, /item\["lastDeliveryId"\] = monitored\.get\("deliveryId"\)/u);
    assert.match(source, /summary\["typeCode"\].*dmdata_source\.get\("typeCode"\)/u);
    assert.match(script, /dmdataSource: selectedDmdataSource/u);
    assert.match(script, /function routeForDmdataItem/u);
    assert.match(template, /DmdataApiKeyParameter/u);
    assert.match(template, /DMDATA_API_KEY_PARAMETER/u);
    const operationalPolicy = template.match(/- Sid: ReadAndWriteOperationalState([\s\S]*?)(?=\n\s+- Sid:|\n\s+FunctionUrlConfig:)/u)?.[1] || '';
    assert.match(operationalPolicy, /dynamodb:BatchGetItem/u);
    assert.doesNotMatch(template, /DMDATA_API_KEY:\s/u);
    assert.match(html, /DMDATA過去受信/u);
    assert.match(html, /緊急地震速報（警報発表イベント）/u);
    assert.match(html, /未対応形式/u);
    assert.match(script, /dmdata-load-xml/u);
    assert.match(worker, /'eew-warning'/u);
    assert.match(source, /"is_warning": source\.get\("isWarning"\) is True/u);
    assert.doesNotMatch(script, /innerHTML/u);
});

test('配信系統はEC2とLambda・SQSバックアップを分離しSQS稼働状態を表示する', async () => {
    const [source, html, script, style] = await Promise.all([
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-flow-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-flow-admin/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-flow-admin/style.css', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /view == "delivery-flow"/u);
    assert.match(source, /def _sqs_region_summary/u);
    assert.match(source, /"layer": "ec2"/u);
    assert.match(source, /dpi-delivery-backup-/u);
    assert.match(source, /dpi-ha-candidate-/u);
    assert.match(source, /"sourceType": "lambda-sqs"/u);
    assert.match(source, /"lastConnectivityAt"/u);
    assert.match(source, /"lastPassedAt"/u);
    assert.match(source, /"label": "上流API"[\s\S]*"label": "自宅サーバー"[\s\S]*"label": "受付API・HA制御"/u);
    assert.match(source, /"priority": "優先1"[\s\S]*"priority": "優先2"[\s\S]*"priority": "優先3"/u);
    assert.match(source, /"label": "高速判定・分散"[\s\S]*"label": "MRSC所有権判定"[\s\S]*"label": "Discord配信Lambda"/u);
    assert.match(source, /"label": "EC2"[\s\S]*"label": "受付API・HA制御"[\s\S]*"label": "高速判定・分散"/u);
    assert.match(source, /def _sqs_activity_state/u);
    assert.match(source, /activity_state = "error" if dlq > 0/u);
    assert.match(source, /def _sqs_queue_role/u);
    assert.match(source, /WebSocket配信用SQS/u);
    assert.match(source, /高可用性候補判定の失敗退避DLQ/u);
    assert.match(source, /"ec2Details"/u);
    assert.match(source, /"lastDeliveryId": recent\.get\("deliveryId"\)/u);
    assert.match(source, /"activityLabel": _sqs_activity_label/u);
    assert.match(html, /待機中（正常）|バックアップ待機中/u);
    assert.match(script, /component\.expectedStopped/u);
    assert.match(script, /component\.standby/u);
    assert.match(script, /queueStateLabel/u);
    assert.match(script, /document\.createElement\(tag\)/u);
    assert.match(script, /flow\.routes/u);
    assert.match(script, /flow-route-branches/u);
    assert.match(script, /stageStatusSummary\(matches\)/u);
    assert.match(script, /\['abnormal', '異常'\]/u);
    assert.match(script, /component\.activityState === 'error'/u);
    assert.match(script, /queue\.role \|\| '用途未分類SQS'/u);
    assert.match(script, /ec2DetailRows\(component\.ec2Details\)/u);
    assert.match(script, /東京リージョン/u);
    assert.match(script, /大阪リージョン/u);
    assert.match(script, /flow-region-badge/u);
    assert.match(script, /Lambda内訳/u);
    assert.match(script, /queue\.region \|\| component\.targetRegion \|\| component\.region/u);
    assert.match(script, /resourceRegionLabel/u);
    assert.match(script, /\['リージョン', details\.region/u);
    assert.match(source, /"sourceRegion": source_region/u);
    assert.match(source, /"targetRegion": target_region/u);
    assert.match(source, /def _discord_delivery_families/u);
    assert.match(source, /"new_EEW"/u);
    assert.match(source, /"new_kisyo"/u);
    assert.match(source, /"layer": "discord-delivery"/u);
    assert.match(source, /"functions": sorted\(fast_functions\)/u);
    assert.match(source, /"layer": "lease"/u);
    assert.match(source, /DPI-DeliveryLease/u);
    assert.doesNotMatch(source, /"functions": sorted\(function_names\)/u);
    assert.match(style, /\.resource-region-badge/u);
    assert.match(style, /\.flow-priority-rules/u);
    assert.match(script, /flow-priority-rules/u);
    assert.match(script, /flow-route-priority/u);
    assert.match(script, /stage\.note/u);
    assert.match(html, /配信順と優先経路/u);
    assert.match(html, /flow-primary-assignments/u);
    assert.match(script, /直近配信ID/u);
    assert.match(style, /\.flow-stage-statuses/u);
    assert.match(style, /\.flow-stage-status/u);
    assert.match(style, /grid-template-columns: repeat\(2/u);
    assert.match(style, /@media \(max-width: 760px\)/u);
    assert.doesNotMatch(script, /setInterval|innerHTML/u);
});

test('配信監視テーブルへのIAM権限は読み取り専用に限定する', async () => {
    const template = await readFile(new URL('../aws/channel-directory-api/template.yaml', import.meta.url), 'utf8');
    const policy = template.match(/- Sid: ReadDeliveryMonitor([\s\S]*?)(?=\n\s+- Sid:|\n\s+FunctionUrlConfig:)/u)?.[1] || '';
    assert.match(template, /DELIVERY_MONITOR_TABLE_NAME: !Ref DeliveryMonitorTableName/u);
    assert.match(policy, /dynamodb:Scan/u);
    assert.match(policy, /dynamodb:DescribeTable/u);
    assert.doesNotMatch(policy, /PutItem|UpdateItem|DeleteItem/u);
});

test('XML配信メタデータだけを配信監視キーへ先行記録する', async () => {
    const [source, template] = await Promise.all([
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
        readFile(new URL('../aws/channel-directory-api/template.yaml', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /def _record_delivery_metadata/u);
    assert.match(source, /"delivery-metadata"/u);
    assert.match(source, /deliverySlot = :delivery_slot/u);
    assert.match(source, /#title = :title/u);
    assert.match(template, /Sid: WriteDeliveryMetadata/u);
    assert.match(template, /dynamodb:LeadingKeys:[\s\S]*delivery#\*/u);
});
