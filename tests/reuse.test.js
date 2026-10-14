import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleReuseRequest, __test as reuseTest } from '../worker/reuse.js';

test('Discordサーバーは所有者・管理者・サーバー管理権限だけを申請対象にする', () => {
    assert.equal(reuseTest.canManageGuild({ owner: true, permissions: '0' }), true);
    assert.equal(reuseTest.canManageGuild({ owner: false, permissions: String(1 << 3) }), true);
    assert.equal(reuseTest.canManageGuild({ owner: false, permissions: String(1 << 5) }), true);
    assert.equal(reuseTest.canManageGuild({ owner: false, permissions: String(1 << 10) }), false);
});

test('二次利用申請の選択肢・同意・入力長を検証する', () => {
    const valid = reuseTest.validateEditableApplicationInput({
        channelType: 5,
        deliveryTypes: ['eew', 'earthquake'],
        serverPublic: 'public',
        channelVisibility: 'role_limited',
        announcementAutomated: 'yes',
        reuseMethod: 'edited',
        reuseMethodOther: '',
        email: 'USER@example.com',
        purpose: '防災情報を参加者へ迅速に共有するためです。',
        destinationUrl: 'https://example.com/server',
        notes: '出典を明記します。',
        consent: true,
        authorized: true,
    });
    assert.equal(valid.email, 'user@example.com');
    assert.deepEqual(valid.deliveryTypes, ['eew', 'earthquake']);

    assert.throws(
        () => reuseTest.validateEditableApplicationInput({
            channelType: 0,
            deliveryTypes: ['eew'],
            serverPublic: 'public',
            channelVisibility: 'public',
            announcementAutomated: 'yes',
            reuseMethod: 'unchanged', email: 'user@example.com',
            purpose: '十分な長さの利用目的を記載します。', consent: true, authorized: true,
        }),
        (error) => error?.code === 'invalid_announcement_setting',
    );
});

test('公開用の申請情報ではメールアドレスをマスクする', () => {
    const serialized = reuseTest.serializeApplication({
        id: 'id', reference: 'REUSE-1', status: 'pending', revision: 1,
        discord_username: 'User', guild_id: '123', guild_name: 'Guild',
        channel_id: '456', channel_name: 'news', channel_type: 5,
        delivery_types: '["eew"]', server_public: 'public',
        channel_visibility: 'public', announcement_automated: 'yes',
        reuse_method: 'unchanged', contact_email: 'person@example.com',
        purpose: 'purpose', created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
    }, false);
    assert.equal(serialized.contactEmail, 'p***@example.com');
    assert.equal(Object.hasOwn(serialized, 'discordUserId'), false);
});

test('申請画面と管理画面は安全なDOM APIで表示し、審査操作を備える', async () => {
    const publicScript = await readFile(new URL('../site/reuse/script.js', import.meta.url), 'utf8');
    const adminScript = await readFile(new URL('../site/reuse-admin/script.js', import.meta.url), 'utf8');
    const publicHtml = await readFile(new URL('../site/reuse/index.html', import.meta.url), 'utf8');
    const adminHtml = await readFile(new URL('../site/reuse-admin/index.html', import.meta.url), 'utf8');

    assert.doesNotMatch(publicScript, /\.innerHTML\s*=/u);
    assert.doesNotMatch(adminScript, /\.innerHTML\s*=/u);
    assert.match(adminScript, /changes_requested/u);
    assert.match(adminScript, /approved/u);
    assert.match(adminScript, /rejected/u);
    assert.match(adminHtml, /Cloudflare|二次利用申請管理/u);
    for (const html of [publicHtml, adminHtml]) {
        assert.match(html, /class="page-container"/u);
        assert.match(html, /class="sidebar/u);
        assert.match(html, /\.\.\/\.\.\/script\.js/u);
    }
});

test('既存D1 bindingを二次利用申請でも利用でき、設定状態を項目別に返す', async () => {
    const response = await handleReuseRequest(new Request('https://dpi-bot.com/api/reuse/config'), {
        NEWSLETTER_DB: {},
        DISCORD_CLIENT_ID: 'client-id',
        DISCORD_CLIENT_SECRET: 'client-secret',
        DISCORD_BOT_TOKEN: 'bot-token',
        REUSE_SESSION_SECRET: 'session-secret',
        NOTICE_EMAIL: {},
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
    });
    const body = await response.json();

    assert.equal(body.configured, true);
    assert.deepEqual(body.configuration, {
        database: true,
        discord: true,
        session: true,
        email: true,
    });
});

test('未ログインのセッション確認は通常応答として扱う', async () => {
    const response = await handleReuseRequest(
        new Request('https://dpi-bot.com/api/reuse/session'),
        {},
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { success: true, authenticated: false });
});

test('二次利用申請のD1 migrationとDiscord OAuth設定を同梱する', async () => {
    const migration = await readFile(new URL('../migrations/0004_reuse_applications.sql', import.meta.url), 'utf8');
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.match(migration, /CREATE TABLE IF NOT EXISTS reuse_applications/u);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS reuse_application_events/u);
    assert.equal(config.d1_databases.find((item) => item.binding === 'REUSE_DB').database_name, 'dpi-newsletter');
    assert.equal(config.vars.DISCORD_CLIENT_ID, '943752169029505114');
    for (const secret of ['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'REUSE_SESSION_SECRET']) {
        assert.equal(Object.hasOwn(config.vars || {}, secret), false, `${secret} must not be committed`);
    }
});
