import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdminCenterRequest } from '../worker/admin-center.js';
import { __test as newsletter } from '../worker/newsletter.js';

const env = {
    NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
    NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
    NOTICE_REPLY_TO_EMAIL: 'support@dpi-bot.com',
};

test('統合管理画面の末尾スラッシュは自分自身へリダイレクトしない', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    const token = await accessToken(privateKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: 'test-key' }] });
    const adminEnv = {
        ACCESS_AUD: 'test-audience',
        ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
        ADMIN_EMAILS: 'admin@example.com',
        ASSETS: { fetch: async () => new Response('admin page', { headers: { 'Content-Type': 'text/html' } }) },
    };
    try {
        const headers = { 'cf-access-jwt-assertion': token };
        const canonical = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/admin-center/', { headers }), adminEnv);
        assert.equal(canonical.status, 200);
        assert.equal(await canonical.text(), 'admin page');

        const missingSlash = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/admin-center', { headers }), adminEnv);
        assert.equal(missingSlash.status, 308);
        assert.equal(missingSlash.headers.get('location'), 'https://dpi-bot.com/site/admin-center/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

async function accessToken(privateKey) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const signingInput = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({
        iss: 'https://test-team.cloudflareaccess.com',
        aud: 'test-audience',
        email: 'admin@example.com',
        sub: 'admin-subject',
        iat: now,
        exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

test('二次利用者向けメールは選択した配信枠と管理導線を表示する', () => {
    const mail = newsletter.buildCampaignEmail({
        campaign_id: 'campaign-id',
        recipient_kind: 'reuse_approved',
        category: 'maintenance',
        delivery_slots: '地震情報,津波情報',
        email: 'reuse@example.com',
        subject: '運用からのお知らせ',
        body_text: '配信設定をご確認ください。',
    }, null, env);

    assert.match(mail.text, /対象配信枠: 地震情報・津波情報/u);
    assert.match(mail.text, /二次利用を許可されている方/u);
    assert.match(mail.html, /\/site\/reuse\//u);
    assert.equal(mail.headers['List-Unsubscribe'], undefined);
    assert.equal(mail.headers['List-Subscribe'], undefined);
});

test('購読者向けメールは配信停止ヘッダーを維持する', () => {
    const mail = newsletter.buildCampaignEmail({
        campaign_id: 'campaign-id',
        recipient_kind: 'subscriber',
        category: 'outage',
        delivery_slots: 'DPI_Bot通知',
        email: 'subscriber@example.com',
        subject: '障害情報',
        body_text: '復旧作業中です。',
    }, 'token.token', env);

    assert.match(mail.headers['List-Unsubscribe'], /\/api\/newsletter\/unsubscribe/u);
    assert.match(mail.headers['List-Subscribe'], /\/site\/mail\//u);
});

test('送信先と配信枠はサーバー側の許可リストで検証する', () => {
    assert.deepEqual(newsletter.validateRecipientGroups(['subscribers', 'reuse_approved', 'discord_approved']), ['subscribers', 'reuse_approved', 'discord_approved']);
    assert.deepEqual(newsletter.validateDeliverySlots(['地震情報', 'DPI_Bot通知']), ['地震情報', 'DPI_Bot通知']);
    assert.deepEqual(newsletter.validateTargetServerIds(['12345678901234567'], ['discord_approved']), ['12345678901234567']);
    assert.throws(() => newsletter.validateRecipientGroups([]), /1つ以上/u);
    assert.throws(() => newsletter.validateRecipientGroups(['unknown']), /正しく/u);
    assert.throws(() => newsletter.validateDeliverySlots(['unknown']), /正しく/u);
    assert.throws(() => newsletter.validateTargetServerIds([], ['discord_approved']), /1つ以上/u);
});

test('Discord配信は選択サーバーと現在の配信枠に一致する許可済みチャンネルだけを対象にする', async () => {
    const reuse = [{
        id: 'reuse-1',
        guild_id: '12345678901234567',
        guild_name: 'テストサーバー',
        channel_mappings: JSON.stringify([
            { channelId: '22345678901234567', deliveryTypes: ['地震情報'] },
            { channelId: '32345678901234567', deliveryTypes: ['台風情報'] },
        ]),
        delivery_types: JSON.stringify(['地震情報', '台風情報']),
    }];
    const database = {
        prepare() {
            return {
                bind() { return this; },
                async all() { return { results: reuse }; },
            };
        },
    };
    const recipients = await newsletter.loadCampaignRecipients(
        { NEWSLETTER_DB: database },
        {
            recipient_groups: 'discord_approved',
            delivery_slots: '地震情報',
            target_server_ids: '12345678901234567',
        },
        ['maintenance'],
    );

    assert.deepEqual(recipients, [{
        email: null,
        kind: 'discord_approved',
        subscriberId: 'discord:22345678901234567',
        reference: 'reuse-1',
    }]);
});

test('Discordお知らせはメンションを無効化してBot APIへ投稿する', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url: String(url), options };
        return Response.json({ id: 'message-id' });
    };
    try {
        const result = await newsletter.sendDiscordAnnouncement(
            '22345678901234567',
            '運営からのお知らせ',
            '@everyone テスト配信です。',
            { DISCORD_BOT_TOKEN: 'secret-token' },
        );
        const payload = JSON.parse(request.options.body);
        assert.equal(result.id, 'message-id');
        assert.equal(request.url, 'https://discord.com/api/v10/channels/22345678901234567/messages');
        assert.equal(request.options.headers.Authorization, 'Bot secret-token');
        assert.deepEqual(payload.allowed_mentions, { parse: [] });
        assert.match(payload.content, /運営からのお知らせ/u);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('二次利用者は許可状態と選択配信枠で絞り込み、購読者と重複除外する', async () => {
    const subscribers = [{ id: 'sub-1', email: 'same@example.com' }];
    const reuse = [
        { id: 'reuse-1', contact_email: 'same@example.com', delivery_types: JSON.stringify(['地震情報']) },
        { id: 'reuse-2', contact_email: 'quake@example.com', delivery_types: JSON.stringify(['地震情報', '津波情報']) },
        { id: 'reuse-3', contact_email: 'weather@example.com', delivery_types: JSON.stringify(['台風情報']) },
    ];
    const database = {
        prepare(sql) {
            return {
                bind() { return this; },
                async all() { return { results: sql.includes('newsletter_subscribers') ? subscribers : reuse }; },
            };
        },
    };
    const recipients = await newsletter.loadCampaignRecipients(
        { NEWSLETTER_DB: database },
        { recipient_groups: 'subscribers,reuse_approved', delivery_slots: '地震情報' },
        ['maintenance'],
    );

    assert.deepEqual(recipients.map((item) => [item.email, item.kind]), [
        ['same@example.com', 'subscriber'],
        ['quake@example.com', 'reuse_approved'],
    ]);
});
