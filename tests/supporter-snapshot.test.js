import test from 'node:test';
import assert from 'node:assert/strict';

import {buildSupporterSnapshot, publishSupporterSnapshot, refreshSupporterSnapshot} from '../worker/supporter-snapshot.js';

const ACCOUNT_ID = '637850681666961408';
const GUILD_ID = '12345678901234567';
const CHANNEL_ID = '98765432109876543';

function database(rows) {
    return {
        prepare(sql) {
            if(sql.includes('supporter_custom_plans'))return {async all(){return {results:[]};}};
            assert.match(sql, /NOT EXISTS/u);
            return {async all() { return {results: rows}; }};
        },
    };
}

function account({customer = 'cus_active', revision = 4, type = 'rain-radar'} = {}) {
    return {
        discord_user_id: ACCOUNT_ID,
        customer_id: customer,
        revision,
        settings_json: JSON.stringify({rules: [{
            name: '関東の雨雲',
            guildId: GUILD_ID,
            channelId: CHANNEL_ID,
            channelIds: [CHANNEL_ID],
            type,
            region: 'kanto-koshin',
            radarCondition: 'rainfall-threshold',
            rainfallThresholdMmPerHour: 10,
            deliveryIntervalHours: 3,
            conditionLogic: 'and',
            conditions: [],
        }]}),
    };
}

test('有効な契約のルールだけを個人情報なしでスナップショット化する', async () => {
    const rows = [account(), account({customer: 'cus_canceled', revision: 2, type: 'weather'})];
    const loadSubscriptions = async (_env, customerIds) => {
        assert.deepEqual(customerIds, ['cus_active', 'cus_canceled']);
        return new Map([
            ['cus_active', [{status: 'active', recognizedPlan: true, planId:'plus'}]],
            ['cus_canceled', [{status: 'canceled', recognizedPlan: true}]],
        ]);
    };
    const snapshot = await buildSupporterSnapshot(database(rows), {}, loadSubscriptions, 1_800_000_000_123);
    assert.equal(snapshot.rules.length, 1);
    assert.equal(snapshot.rules[0].type, 'rain-radar');
    assert.match(snapshot.rules[0].id, /^rule-[0-9a-f]{16}$/u);
    assert.equal(snapshot.generatedAt, 1_800_000_000);
    assert.equal(snapshot.expiresAt, 1_800_108_000);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(ACCOUNT_ID, 'u'));
    assert.doesNotMatch(JSON.stringify(snapshot), /cus_active/u);
});

test('AWS公開APIへBearer認証付きでスナップショットを送る', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let request;
    globalThis.fetch = async (url, options) => {
        request = {url, options};
        return new Response(JSON.stringify({success: true, published: true, version: 'routes-v2'}), {
            status: 200,
            headers: {'Content-Type': 'application/json'},
        });
    };
    const snapshot = {version: 'routes-v2'};
    const result = await publishSupporterSnapshot({
        AWS_CHANNEL_DIRECTORY_URL: 'https://example.lambda-url.ap-northeast-1.on.aws/',
        AWS_CHANNEL_DIRECTORY_TOKEN: 'secret-token',
    }, snapshot);
    assert.equal(result.published, true);
    assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
    const body = JSON.parse(request.options.body);
    assert.equal(body.action, 'supporter-snapshot');
    assert.deepEqual(body.snapshot, snapshot);
});

test('AWS設定がない環境ではStripe照会も公開も行わない', async () => {
    let called = false;
    const result = await refreshSupporterSnapshot({}, database([]), async () => {
        called = true;
        return new Map();
    });
    assert.equal(result.reason, 'not_configured');
    assert.equal(called, false);
});
