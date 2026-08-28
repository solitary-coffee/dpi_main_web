import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CONTACT_TO_EMAILを平文のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'CONTACT_TO_EMAIL'), false);
});

test('メール配信のSecretをリポジトリ上のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const secretNames = [
        'NEWSLETTER_TOKEN_SECRET',
        'ACCESS_TEAM_DOMAIN',
        'ACCESS_AUD',
        'MAIL_ADMIN_EMAILS',
    ];

    for (const name of secretNames) {
        assert.equal(Object.hasOwn(config.vars || {}, name), false, `${name} must not be in vars`);
    }
    assert.equal(Object.hasOwn(config, 'secrets'), false);
});

test('D1・Queue・送信元制限・管理画面ルーティングを宣言する', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const noticeBinding = config.send_email.find((binding) => binding.name === 'NOTICE_EMAIL');

    assert.deepEqual(noticeBinding.allowed_sender_addresses, ['notice@dpi-bot.com']);
    assert.equal(config.d1_databases[0].binding, 'NEWSLETTER_DB');
    assert.equal(Object.hasOwn(config.d1_databases[0], 'database_id'), false);
    assert.equal(config.queues.producers[0].binding, 'NEWSLETTER_QUEUE');
    assert.equal(config.queues.consumers[0].max_concurrency, 1);
    assert.equal(config.queues.consumers[0].dead_letter_queue, 'dpi-newsletter-delivery-dlq');
    assert.ok(config.assets.run_worker_first.includes('/site/mail-admin/*'));
});
