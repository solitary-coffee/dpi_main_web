import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChannelDirectoryRequest, __test as directoryTest } from '../worker/channel-directory.js';

test('Access設定がなければ配信先検索APIをフェイルクローズする', async () => {
    const response = await handleChannelDirectoryRequest(
        new Request('https://dpi-bot.com/site/channel-admin/api/search'),
        {},
    );
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'admin_not_configured');
});

test('二次利用申請のチャンネル別設定を検索用データへ変換する', () => {
    const items = directoryTest.applicationDirectoryItems({
        id: 'app-1', reference: 'DPI-20261014-001', status: 'approved',
        guild_id: '123456789012345678', guild_name: '防災サーバー',
        channel_id: '223456789012345678', channel_name: '地震', channel_type: 5,
        delivery_types: '["地震情報"]',
        channel_mappings: JSON.stringify([
            { channelId: '223456789012345678', channelName: '地震', channelType: 5, announcement: true, deliveryTypes: ['地震情報', '津波情報'] },
            { channelId: '323456789012345678', channelName: '気象', channelType: 0, announcement: false, deliveryTypes: ['気象情報_概況'] },
        ]),
        server_public: 'public', channel_visibility: 'role_limited', updated_at: '2026-10-14T08:00:00Z',
    });

    assert.equal(items.length, 2);
    assert.equal(items[0].serverName, '防災サーバー');
    assert.equal(items[0].announcement, true);
    assert.deepEqual(items[1].deliveryTypes, ['気象情報_概況']);
    assert.match(items[0].permissionSummary, /指定ロール/u);
});

test('AWSと申請の同一チャンネルを統合し配信名を重複排除する', () => {
    const merged = directoryTest.mergeDirectoryItems([
        {
            serverId: '1', serverName: '防災', channelId: '2', channelName: '速報',
            deliveryTypes: ['地震情報'], announcement: null, channelType: null,
            permissions: null, permissionSummary: null, visibility: null, memberCount: null,
            updatedAt: '2026-10-13T00:00:00Z', application: null, sources: ['aws'],
        },
        {
            serverId: '1', serverName: '防災', channelId: '2', channelName: '速報',
            deliveryTypes: ['地震情報', '津波情報'], announcement: true, channelType: 5,
            permissions: null, permissionSummary: '指定ロールのみ閲覧可能', visibility: 'role_limited', memberCount: null,
            updatedAt: '2026-10-14T00:00:00Z', application: { reference: 'DPI-1' }, sources: ['application'],
        },
    ]);

    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].deliveryTypes, ['地震情報', '津波情報']);
    assert.deepEqual(merged[0].sources, ['aws', 'application']);
    assert.equal(merged[0].announcement, true);
});

test('名前・ID・配信名・アナウンス種別で絞り込める', () => {
    const item = {
        serverId: '123456789012345678', serverName: 'DPI 防災',
        channelId: '223456789012345678', channelName: '地震速報',
        deliveryTypes: ['地震情報'], announcement: true,
    };
    assert.equal(directoryTest.matchesFilters(item, { q: 'dpi', delivery: '', announcement: 'all' }), true);
    assert.equal(directoryTest.matchesFilters(item, { q: '223456789012345678', delivery: '', announcement: 'all' }), true);
    assert.equal(directoryTest.matchesFilters(item, { q: '', delivery: '地震', announcement: 'yes' }), true);
    assert.equal(directoryTest.matchesFilters(item, { q: '', delivery: '', announcement: 'no' }), false);
});

test('最大件数は未指定またはallなら全件、数値なら上限内に丸める', () => {
    assert.equal(directoryTest.parseFilters(new URLSearchParams()).limit, null);
    assert.equal(directoryTest.parseFilters(new URLSearchParams({ limit: 'all' })).limit, null);
    assert.equal(directoryTest.parseFilters(new URLSearchParams({ limit: '500' })).limit, 500);
    assert.equal(directoryTest.parseFilters(new URLSearchParams({ limit: '5000' })).limit, 1000);
});

test('Discord権限上書きの主要権限を日本語へ変換する', () => {
    const viewAndSend = String((1n << 10n) | (1n << 11n));
    const overwrites = directoryTest.normalizePermissionOverwrites([
        { id: '123456789012345678', type: 0, allow: viewAndSend, deny: '0' },
    ]);
    assert.equal(overwrites.length, 1);
    assert.equal(overwrites[0].targetType, 'role');
    assert.deepEqual(overwrites[0].allow, ['チャンネルを見る', 'メッセージを送信']);
    assert.deepEqual(overwrites[0].deny, []);
});
