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
    assert.match(source, /"seriousErrors"/u);
    assert.match(source, /rows\[:50\]/u);
});

test('DMDATA履歴は固定ドメイン・短時間キャッシュ・配信状態記録を使用する', async () => {
    const [source, template, html, script] = await Promise.all([
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
        readFile(new URL('../aws/channel-directory-api/template.yaml', import.meta.url), 'utf8'),
        readFile(new URL('../site/xml-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/admin-center/script.js', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /view == "dmdata-history"/u);
    assert.match(source, /api\.dmdata\.jp.*data\.api\.dmdata\.jp/u);
    assert.match(source, /_dmdata_history_cache/u);
    assert.match(source, /DMDATA#SOURCE#/u);
    assert.match(source, /xmlSha256/u);
    assert.match(source, /hmac\.compare_digest\(dmdata_source\["xmlSha256"\], xml_digest\)/u);
    assert.match(source, /deliveryStateLabel/u);
    assert.match(source, /gd\/eew/u);
    assert.match(template, /DmdataApiKeyParameter/u);
    assert.match(template, /DMDATA_API_KEY_PARAMETER/u);
    assert.doesNotMatch(template, /DMDATA_API_KEY:\s/u);
    assert.match(html, /DMDATA過去受信/u);
    assert.match(html, /未対応形式/u);
    assert.match(script, /dmdata-load-xml/u);
    assert.doesNotMatch(script, /innerHTML/u);
});

test('配信系統は待機系停止を異常にせず地域別SQSを表示する', async () => {
    const [source, html, script] = await Promise.all([
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-flow-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-flow-admin/script.js', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /view == "delivery-flow"/u);
    assert.match(source, /def _sqs_region_summary/u);
    assert.match(source, /"expectedStopped": state == "stopped"/u);
    assert.match(source, /"lastConnectivityAt"/u);
    assert.match(source, /"lastPassedAt"/u);
    assert.match(html, /AWS高速系統|バックアップ待機中/u);
    assert.match(script, /component\.expectedStopped/u);
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
