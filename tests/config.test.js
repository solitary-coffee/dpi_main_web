import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CONTACT_TO_EMAILを平文のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'CONTACT_TO_EMAIL'), false);
});

test('メール配信・認証のSecretをリポジトリ上のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const secretNames = [
        'NEWSLETTER_TOKEN_SECRET',
        'ACCESS_TEAM_DOMAIN',
        'ACCESS_AUD',
        'ADMIN_EMAILS',
        'MAIL_ADMIN_EMAILS',
        'DISCORD_CLIENT_SECRET',
        'DISCORD_BOT_TOKEN',
        'REUSE_SESSION_SECRET',
        'AWS_CHANNEL_DIRECTORY_URL',
        'AWS_CHANNEL_DIRECTORY_TOKEN',
        'STATUSPAGE_API_KEY',
    ];

    for (const name of secretNames) {
        assert.equal(Object.hasOwn(config.vars || {}, name), false, `${name} must not be in vars`);
    }
    assert.equal(Object.hasOwn(config, 'secrets'), false);
    assert.equal(config.vars.STATUSPAGE_PAGE_ID, '28grbz2c7xtm');
    assert.equal(config.vars.STATUSPAGE_PUBLIC_URL, 'https://coffeebousai.statuspage.io/');
});

test('D1・Queue・送信元制限・管理画面ルーティングを宣言する', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const noticeBinding = config.send_email.find((binding) => binding.name === 'NOTICE_EMAIL');

    assert.deepEqual(noticeBinding.allowed_sender_addresses, ['notice@dpi-bot.com']);
    const newsletterDb = config.d1_databases.find((binding) => binding.binding === 'NEWSLETTER_DB');
    const ipBlockDb = config.d1_databases.find((binding) => binding.binding === 'IP_BLOCK_DB');
    const reuseDb = config.d1_databases.find((binding) => binding.binding === 'REUSE_DB');
    assert.equal(newsletterDb.database_name, 'dpi-newsletter');
    assert.equal(ipBlockDb.database_name, 'dpi-newsletter');
    assert.equal(newsletterDb.database_id, ipBlockDb.database_id);
    assert.equal(reuseDb.database_id, newsletterDb.database_id);
    assert.equal(config.queues.producers[0].binding, 'NEWSLETTER_QUEUE');
    assert.equal(config.queues.consumers[0].max_concurrency, 1);
    assert.equal(config.queues.consumers[0].dead_letter_queue, 'dpi-newsletter-delivery-dlq');
    assert.equal(config.assets.run_worker_first, true);
});

test('遮断IPを平文のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'BLOCKED_IPS'), false);
    assert.equal(Object.hasOwn(config.vars || {}, 'IP_BLOCK_MESSAGE'), false);
});

test('IP遮断用D1マイグレーションを同梱する', async () => {
    const migrationPath = new URL('../migrations/0002_ip_blocking.sql', import.meta.url);
    const migration = await readFile(migrationPath, 'utf8');

    assert.match(migration, /CREATE TABLE IF NOT EXISTS ip_block_rules/u);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS ip_block_audit/u);
});

test('Discordリッチお知らせ用D1マイグレーションを同梱する', async () => {
    const migration = await readFile(new URL('../migrations/0007_discord_rich_announcements.sql', import.meta.url), 'utf8');
    assert.match(migration, /delivery_format/u);
    assert.match(migration, /embed_color/u);
    assert.match(migration, /image_data BLOB/u);
    assert.match(migration, /external_sent_count/u);
    assert.match(migration, /external_failed_count/u);
});

test('Discord送信先モード用D1マイグレーションを同梱する', async () => {
    const migration = await readFile(new URL('../migrations/0008_discord_targeting.sql', import.meta.url), 'utf8');
    assert.match(migration, /target_mode/u);
    assert.match(migration, /deduplicate_channels/u);
    assert.match(migration, /target_server_ids/u);
});

test('公式Discord送信設定用D1マイグレーションを同梱する', async () => {
    const migration = await readFile(new URL('../migrations/0010_official_discord_announcements.sql', import.meta.url), 'utf8');
    assert.match(migration, /send_official_support/u);
    assert.match(migration, /official_mention_role_id/u);
    assert.match(migration, /official_message_id/u);
});
