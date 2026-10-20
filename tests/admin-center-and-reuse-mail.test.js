import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAdminCenterRequest, __test as adminCenter } from '../worker/admin-center.js';
import { __test as newsletter } from '../worker/newsletter.js';

const env = {
    NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
    NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
    NOTICE_REPLY_TO_EMAIL: 'support@dpi-bot.com',
};

test('分割した運用管理画面をAccess認証で保護し末尾スラッシュを正規化する', async () => {
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
        for (const root of ['/site/admin-center', '/site/system-admin', '/site/ec2-admin', '/site/xml-admin', '/site/status-admin', '/site/delivery-admin', '/site/delivery-flow-admin']) {
            const canonical = await handleAdminCenterRequest(new Request(`https://dpi-bot.com${root}/`, { headers }), adminEnv);
            assert.equal(canonical.status, 200, root);
            assert.equal(await canonical.text(), 'admin page', root);

            const missingSlash = await handleAdminCenterRequest(new Request(`https://dpi-bot.com${root}`, { headers }), adminEnv);
            assert.equal(missingSlash.status, 308, root);
            assert.equal(missingSlash.headers.get('location'), `https://dpi-bot.com${root}/`, root);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('統合管理センターは概要だけを表示し操作は専用タブへ分離する', async () => {
    const [overview, system, ec2, xml] = await Promise.all([
        readFile(new URL('../site/admin-center/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/system-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/ec2-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/xml-admin/index.html', import.meta.url), 'utf8'),
    ]);
    assert.match(overview, /id="operation-overview"/u);
    assert.doesNotMatch(overview, /id="mode-form"|id="ec2-rows"|id="xml-form"/u);
    assert.match(system, /id="system-panels"[\s\S]*id="mode-form"[\s\S]*id="audit-rows"/u);
    assert.match(ec2, /id="ec2-rows"/u);
    assert.match(xml, /id="xml-form"[\s\S]*id="delivery-slots"/u);
    for (const html of [overview, system, ec2, xml]) {
        assert.match(html, /\/site\/system-admin\//u);
        assert.match(html, /\/site\/ec2-admin\//u);
        assert.match(html, /\/site\/xml-admin\//u);
    }
});

test('危険操作は確認文字列を入力させずポップアップ確認しモード動作を常時表示する', async () => {
    const [system, xml, status, adminScript, statusScript] = await Promise.all([
        readFile(new URL('../site/system-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/xml-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/status-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/admin-center/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../site/status-admin/script.js', import.meta.url), 'utf8'),
    ]);
    assert.match(system, /id="selected-mode-plan"/u);
    assert.doesNotMatch(`${system}${xml}${status}`, /id="(?:mode|xml|incident|maintenance)-confirmation"/u);
    assert.doesNotMatch(`${adminScript}${statusScript}`, /window\.prompt/u);
    assert.match(adminScript, /window\.confirm/u);
    assert.match(adminScript, /confirmation = `MODE:/u);
    assert.match(adminScript, /confirmation: `XML配信:/u);
    assert.match(statusScript, /window\.confirm/u);
});

test('すべての管理画面から用途別タブへ移動できる', async () => {
    const pages = ['admin-center', 'system-admin', 'ec2-admin', 'xml-admin', 'status-admin', 'delivery-admin', 'delivery-flow-admin', 'channel-admin', 'reuse-admin', 'mail-admin', 'discord-admin', 'ip-admin'];
    const expected = ['/site/admin-center/', '/site/system-admin/', '/site/ec2-admin/', '/site/xml-admin/', '/site/status-admin/', '/site/delivery-admin/', '/site/delivery-flow-admin/', '/site/channel-admin/', '/site/reuse-admin/', '/site/mail-admin/', '/site/discord-admin/', '/site/ip-admin/'];
    for (const page of pages) {
        const html = await readFile(new URL(`../site/${page}/index.html`, import.meta.url), 'utf8');
        const sidebar = html.match(/<nav class="sidebar"[\s\S]*?<ul>([\s\S]*?)<\/ul>/u)?.[1] || '';
        const links = [...sidebar.matchAll(/<a href="([^"]+)"/gu)].map((match) => match[1]);
        assert.deepEqual(links.filter((href) => href.startsWith('/site/')), expected, page);
    }
});

async function accessToken(privateKey) {
    return accessTokenFor(privateKey, 'https://test-team.cloudflareaccess.com');
}

async function accessTokenFor(privateKey, issuer) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const signingInput = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({
        iss: issuer,
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

test('管理センターは許可済み二次利用の配信枠件数をチャンネル単位で集計する', () => {
    const counts = adminCenter.countApprovedDeliverySlots([
        {
            delivery_types: '["地震情報"]',
            channel_mappings: JSON.stringify([
                { channelId: '1', deliveryTypes: ['地震情報', '津波情報'] },
                { channelId: '2', deliveryTypes: ['地震情報'] },
            ]),
        },
        { delivery_types: '["台風情報"]', channel_mappings: '[]' },
    ]);
    assert.deepEqual(counts, { 地震情報: 2, 津波情報: 1, 台風情報: 1 });
});

test('管理操作APIはAccessの管理者をAWSへ引き継ぎ監査記録を残す', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    const teamDomain = 'https://action-test.cloudflareaccess.com';
    const token = await accessTokenFor(privateKey, teamDomain);
    const originalFetch = globalThis.fetch;
    let forwarded;
    let auditBind;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).startsWith(teamDomain)) return Response.json({ keys: [{ ...publicJwk, kid: 'test-key' }] });
        forwarded = { url: String(url), options, body: JSON.parse(options.body) };
        return Response.json({ success: true, message: 'accepted', requestId: forwarded.body.requestId });
    };
    const database = {
        prepare() {
            return {
                bind(...values) { auditBind = values; return this; },
                async run() { return { success: true }; },
            };
        },
    };
    try {
        const response = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/admin-center/api/action', {
            method: 'POST',
            headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json', origin: 'https://dpi-bot.com' },
            body: JSON.stringify({ action: 'ec2', actor: 'forged@example.com', region: 'ap-northeast-1', instanceId: 'i-0123456789abcdef0', operation: 'start', confirmation: 'start:i-0123456789abcdef0' }),
        }), {
            ACCESS_AUD: 'test-audience', ACCESS_TEAM_DOMAIN: teamDomain, ADMIN_EMAILS: 'admin@example.com',
            AWS_CHANNEL_DIRECTORY_URL: 'https://example.lambda-url.ap-northeast-1.on.aws/', AWS_CHANNEL_DIRECTORY_TOKEN: 'aws-token', NEWSLETTER_DB: database,
        });
        assert.equal(response.status, 200);
        assert.equal(forwarded.body.actor, 'admin@example.com');
        assert.equal(forwarded.options.headers.Authorization, 'Bearer aws-token');
        assert.equal(auditBind[1], 'admin@example.com');
        assert.equal(auditBind[2], 'aws.ec2');
    } finally {
        globalThis.fetch = originalFetch;
    }
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

test('配信枠を検証しDiscordはサーバー未選択でも配信できる', () => {
    assert.deepEqual(newsletter.validateRecipientGroups(['subscribers', 'reuse_approved', 'discord_approved']), ['subscribers', 'reuse_approved', 'discord_approved']);
    assert.deepEqual(newsletter.validateDeliverySlots(['地震情報', 'DPI_Bot通知']), ['地震情報', 'DPI_Bot通知']);
    assert.deepEqual(newsletter.validateTargetServerIds(['12345678901234567'], ['discord_approved']), ['12345678901234567']);
    assert.throws(() => newsletter.validateRecipientGroups([]), /1つ以上/u);
    assert.throws(() => newsletter.validateRecipientGroups(['unknown']), /正しく/u);
    assert.throws(() => newsletter.validateDeliverySlots(['unknown']), /正しく/u);
    assert.deepEqual(newsletter.validateTargetServerIds([], ['discord_approved']), []);
    assert.deepEqual(newsletter.validateDiscordTargeting({
        targetMode: 'delivery_slots', deliverySlots: ['地震情報'], targetServerIds: [], deduplicateChannels: true,
    }, ['discord_approved']), {
        targetMode: 'delivery_slots', deliverySlots: ['地震情報'], targetServerIds: [], deduplicateChannels: true,
    });
    assert.deepEqual(newsletter.validateDiscordTargeting({
        targetMode: 'servers', deliverySlots: [], targetServerIds: ['12345678901234567'], deduplicateChannels: false,
    }, ['discord_approved']), {
        targetMode: 'servers', deliverySlots: [], targetServerIds: ['12345678901234567'], deduplicateChannels: false,
    });
    assert.throws(() => newsletter.validateDiscordTargeting({
        targetMode: 'servers', deliverySlots: [], targetServerIds: [], deduplicateChannels: true,
    }, ['discord_approved']), /サーバーを1つ以上/u);
    assert.throws(() => newsletter.validateDiscordTargeting({
        targetMode: 'intersection', deliverySlots: ['地震情報'], targetServerIds: [], deduplicateChannels: true,
    }, ['discord_approved']), /それぞれ1つ以上/u);
});

test('メールとDiscordの管理APIは送信先を相互に混在させない', () => {
    assert.deepEqual(newsletter.validateSurfaceRecipientGroups(['subscribers', 'reuse_approved'], 'mail'), ['subscribers', 'reuse_approved']);
    assert.deepEqual(newsletter.validateSurfaceRecipientGroups(['discord_approved'], 'discord'), ['discord_approved']);
    assert.throws(() => newsletter.validateSurfaceRecipientGroups(['discord_approved'], 'mail'), /Discordお知らせ管理/u);
    assert.throws(() => newsletter.validateSurfaceRecipientGroups(['subscribers'], 'discord'), /Discord配信/u);
});

test('Discordお知らせ画面と配信統計画面を専用タブとして提供する', async () => {
    const [discordHtml, discordScript, deliveryHtml, deliveryScript, directoryLambda] = await Promise.all([
        readFile(new URL('../site/discord-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/discord-admin/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/delivery-admin/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../aws/channel-directory-api/lambda_function.py', import.meta.url), 'utf8'),
    ]);
    assert.match(discordHtml, /Discordお知らせ管理/u);
    assert.match(discordHtml, /data-template="maintenance"/u);
    assert.match(discordHtml, /name="delivery-format"[^>]+value="embed"/u);
    assert.match(discordHtml, /id="image-file"[^>]+image\/png/u);
    assert.match(discordScript, /recipientGroups: \['discord_approved'\]/u);
    assert.match(discordScript, /\/site\/discord-admin\/api\/campaigns/u);
    assert.match(discordScript, /new FormData\(\)/u);
    assert.match(discordScript, /renderDiscordMarkdown/u);
    assert.match(discordHtml, /送信先サーバー/u);
    assert.match(discordHtml, /同じチャンネルには1件だけ送信する/u);
    assert.match(discordHtml, /value="delivery_slots"/u);
    assert.match(discordScript, /validateTargetSelection/u);
    assert.match(discordScript, /現在の送信件数|AWS登録Webhook/u);
    assert.match(directoryLambda, /discord-announcement-preview/u);
    assert.match(directoryLambda, /_valid_discord_webhook_url/u);
    assert.match(directoryLambda, /failureSummary/u);
    assert.match(directoryLambda, /deduplicateChannels/u);
    assert.match(directoryLambda, /def _string_list\(value, limit, item_length=2048\):/u);
    assert.doesNotMatch(directoryLambda, /text = _clean\(item, 100\)/u);
    assert.match(directoryLambda, /DISCORD_REQUEST_INTERVAL_SECONDS = 0\.02/u);
    assert.match(deliveryHtml, /緊急地震速報|情報種別ごとの配信数/u);
    assert.match(deliveryScript, /\/site\/delivery-admin\/api\/summary/u);
    assert.doesNotMatch(discordScript, /innerHTML/u);
    assert.doesNotMatch(deliveryScript, /innerHTML/u);
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

test('Discord EmbedはMarkdown・色・画像添付をmultipartで送信する', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url: String(url), options };
        return Response.json({ id: 'embed-message-id' });
    };
    try {
        const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
        const result = await newsletter.sendDiscordAnnouncement(
            '22345678901234567',
            '障害情報',
            '**復旧作業中**です。',
            { DISCORD_BOT_TOKEN: 'secret-token' },
            {
                format: 'embed', embedColor: 0xdc2626,
                imageName: 'status.png', imageType: 'image/png', imageData: [...image],
                imageAlt: '障害状況の画像',
            },
        );
        assert.equal(result.id, 'embed-message-id');
        assert.ok(request.options.body instanceof FormData);
        assert.equal(request.options.headers['Content-Type'], undefined);
        const payload = JSON.parse(request.options.body.get('payload_json'));
        assert.equal(payload.embeds[0].title, '障害情報');
        assert.equal(payload.embeds[0].description, '**復旧作業中**です。');
        assert.equal(payload.embeds[0].color, 0xdc2626);
        assert.equal(payload.embeds[0].image.url, 'attachment://status.png');
        assert.equal(payload.attachments[0].description, '障害状況の画像');
        assert.deepEqual(payload.allowed_mentions, { parse: [] });
        assert.equal(request.options.body.get('files[0]').size, image.byteLength);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Discord画像は許可形式・マジックバイト・URLとの重複を検証する', () => {
    const recipientGroups = ['discord_approved'];
    const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    const options = newsletter.validateDiscordOptions({
        deliveryFormat: 'embed', embedColor: '#5865f2', imageUrl: '', imageAlt: '説明',
        image: { name: 'notice.png', type: 'image/png', size: 8, bytes: pngBytes },
    }, recipientGroups);
    assert.equal(options.image.name, 'notice.png');
    assert.equal(options.embedColor, 0x5865f2);
    assert.throws(() => newsletter.validateDiscordOptions({
        deliveryFormat: 'message', embedColor: '#5865f2', imageUrl: '',
        image: { name: 'fake.png', type: 'image/png', size: 4, bytes: new Uint8Array([1, 2, 3, 4]).buffer },
    }, recipientGroups), /内容と形式/u);
    assert.throws(() => newsletter.validateDiscordOptions({
        deliveryFormat: 'embed', embedColor: '#5865f2', imageUrl: 'https://example.com/image.png',
        image: { name: 'notice.png', type: 'image/png', size: 8, bytes: pngBytes },
    }, recipientGroups), /どちらか一方/u);
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
