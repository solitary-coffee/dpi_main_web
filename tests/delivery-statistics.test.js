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
    assert.match(source, /"seriousErrors"/u);
    assert.match(source, /rows\[:50\]/u);
});

test('配信監視テーブルへのIAM権限は読み取り専用に限定する', async () => {
    const template = await readFile(new URL('../aws/channel-directory-api/template.yaml', import.meta.url), 'utf8');
    const policy = template.match(/- Sid: ReadDeliveryMonitor([\s\S]*?)(?=\n\s+- Sid:|\n\s+FunctionUrlConfig:)/u)?.[1] || '';
    assert.match(template, /DELIVERY_MONITOR_TABLE_NAME: !Ref DeliveryMonitorTableName/u);
    assert.match(policy, /dynamodb:Scan/u);
    assert.match(policy, /dynamodb:DescribeTable/u);
    assert.doesNotMatch(policy, /PutItem|UpdateItem|DeleteItem/u);
});
