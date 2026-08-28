import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { __test as newsletterTest } from '../worker/newsletter.js';
import { __test as accessTest, authenticateNewsletterAdmin } from '../worker/access.js';

function minimalEnvironment(overrides = {}) {
    return {
        ASSETS: {
            fetch: async () => new Response('asset'),
        },
        ...overrides,
    };
}

test('メール配信設定APIはサイトキーだけを返しSecretを公開しない', async () => {
    const env = minimalEnvironment({
        NEWSLETTER_DB: {},
        NOTICE_EMAIL: {},
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
        NEWSLETTER_CONSENT_VERSION: '2026-08-29',
        NEWSLETTER_TOKEN_SECRET: 'x'.repeat(32),
        RECAPTCHA_SITE_KEY: 'public-site-key',
        RECAPTCHA_SECRET_KEY: 'private-secret-key',
    });
    const response = await worker.fetch(
        new Request('https://dpi-bot.com/api/newsletter/config'),
        env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.configured, true);
    assert.equal(body.siteKey, 'public-site-key');
    assert.doesNotMatch(JSON.stringify(body), /private-secret-key/u);
    assert.deepEqual(body.categories.map((category) => category.id), ['maintenance', 'outage', 'update']);
});

test('確認リンクのGETはDBを変更せず、POST確認フォームだけを返す', async () => {
    let databaseWasUsed = false;
    const token = 'A'.repeat(43);
    const env = minimalEnvironment({
        NEWSLETTER_DB: {
            prepare() {
                databaseWasUsed = true;
                throw new Error('GET must not touch D1');
            },
        },
    });
    const response = await worker.fetch(
        new Request(`https://dpi-bot.com/api/newsletter/confirm?token=${token}`),
        env,
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(databaseWasUsed, false);
    assert.match(html, /method="post"/u);
    assert.match(html, /登録を確定する/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('公開登録はreCAPTCHA確認後にハッシュだけをD1へ保存して確認メールを送る', async () => {
    const originalFetch = globalThis.fetch;
    const sentMessages = [];
    const captured = { subscriberInsert: null, confirmationUpdate: null };
    const database = {
        prepare(sql) {
            const statement = {
                sql,
                args: [],
                bind(...args) {
                    this.args = args;
                    return this;
                },
                async first() {
                    if (sql.includes('FROM newsletter_rate_events')) return { count: 0 };
                    if (sql.includes('FROM newsletter_subscribers WHERE email')) return null;
                    return null;
                },
                async run() {
                    if (sql.includes('INSERT INTO newsletter_subscribers')) {
                        captured.subscriberInsert = this.args;
                    }
                    if (sql.includes('last_confirmation_sent_at')) {
                        captured.confirmationUpdate = this.args;
                    }
                    return { meta: { changes: 1 } };
                },
            };
            return statement;
        },
        async batch() {
            return [];
        },
    };
    const env = minimalEnvironment({
        NEWSLETTER_DB: database,
        NOTICE_EMAIL: {
            async send(message) {
                sentMessages.push(message);
                return { messageId: 'confirmation-message' };
            },
        },
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
        NOTICE_REPLY_TO_EMAIL: 'support@dpi-bot.com',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
        NEWSLETTER_CONSENT_VERSION: '2026-08-29',
        NEWSLETTER_TOKEN_SECRET: 'k'.repeat(48),
        RECAPTCHA_SITE_KEY: 'public-site-key',
        RECAPTCHA_SECRET_KEY: 'private-secret-key',
        RECAPTCHA_ALLOWED_HOSTS: 'dpi-bot.com',
    });
    globalThis.fetch = async (url) => {
        assert.equal(String(url), 'https://www.google.com/recaptcha/api/siteverify');
        return Response.json({
            success: true,
            hostname: 'dpi-bot.com',
            challenge_ts: new Date().toISOString(),
        });
    };

    try {
        const response = await worker.fetch(new Request('https://dpi-bot.com/api/newsletter/subscribe', {
            method: 'POST',
            headers: {
                Origin: 'https://dpi-bot.com',
                'Content-Type': 'application/json',
                'CF-Connecting-IP': '203.0.113.10',
            },
            body: JSON.stringify({
                email: 'Reader@Example.com',
                categories: ['outage', 'update'],
                consent: true,
                recaptchaToken: 'valid-token',
                formStartedAt: Date.now() - 3_000,
                website: '',
            }),
        }), env);
        const result = await response.json();

        assert.equal(response.status, 202);
        assert.equal(result.success, true);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].to, 'reader@example.com');
        assert.equal(captured.subscriberInsert[1], 'reader@example.com');
        assert.equal(captured.subscriberInsert[2], 'outage,update');
        assert.match(captured.subscriberInsert[6], /^[a-f0-9]{64}$/u);
        const confirmationToken = new URL(sentMessages[0].text.match(/https:\/\/[^\s]+/u)[0])
            .searchParams.get('token');
        assert.match(confirmationToken, /^[A-Za-z0-9_-]{43}$/u);
        assert.notEqual(captured.subscriberInsert[6], confirmationToken);
        assert.equal(captured.confirmationUpdate[3], captured.subscriberInsert[6]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Access設定がなければ管理画面をフェイルクローズしAssetsを返さない', async () => {
    let assetWasFetched = false;
    const response = await worker.fetch(
        new Request('https://dpi-bot.com/site/mail-admin/'),
        minimalEnvironment({
            ASSETS: {
                fetch: async () => {
                    assetWasFetched = true;
                    return new Response('private admin asset');
                },
            },
        }),
    );
    const html = await response.text();

    assert.equal(response.status, 503);
    assert.equal(assetWasFetched, false);
    assert.doesNotMatch(html, /private admin asset/u);
    assert.match(html, /認証設定が完了していません/u);
});

test('管理者が入力したHTMLやJavaScriptをメールHTMLで無害化する', () => {
    const injected = '<script>globalThis.pwned=true</script>\n<img src=x onerror=alert(1)>';
    const email = newsletterTest.buildCampaignEmail({
        campaign_id: 'campaign-123',
        category: 'outage',
        subject: '重要なお知らせ',
        body_text: injected,
        email: 'reader@example.com',
    }, 'signed-token.value', {
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
        NOTICE_REPLY_TO_EMAIL: 'support@dpi-bot.com',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
    });

    assert.doesNotMatch(email.html, /<script>/u);
    assert.doesNotMatch(email.html, /<img/u);
    assert.match(email.html, /&lt;script&gt;/u);
    assert.match(email.text, /<script>globalThis\.pwned=true<\/script>/u);
    assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(email.headers['List-Unsubscribe'], /^<https:\/\/dpi-bot\.com\/api\/newsletter\/unsubscribe\?token=/u);
    assert.equal(email.attachments, undefined);
});

test('Queue consumerは受信者ごとに個別送信して配信完了を記録する', async () => {
    const sentMessages = [];
    const updates = [];
    let acknowledged = false;
    let retried = false;
    const delivery = {
        id: 'delivery-1',
        campaign_id: 'campaign-1',
        subscriber_id: 'subscriber-1',
        status: 'queued',
        attempts: 0,
        updated_at: new Date().toISOString(),
        subject: '配信テスト',
        body_text: '<script>実行しない</script>',
        category: 'maintenance',
        campaign_status: 'sending',
        email: 'reader@example.com',
        subscriber_status: 'active',
        categories: 'maintenance,update',
    };
    const database = {
        prepare(sql) {
            return {
                sql,
                args: [],
                bind(...args) {
                    this.args = args;
                    return this;
                },
                async first() {
                    return sql.includes('JOIN newsletter_campaigns') ? delivery : null;
                },
                async run() {
                    updates.push({ sql, args: this.args });
                    return { meta: { changes: 1 } };
                },
            };
        },
        async batch() {
            return [];
        },
    };
    const env = {
        NEWSLETTER_DB: database,
        NEWSLETTER_TOKEN_SECRET: 'q'.repeat(48),
        NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
        NOTICE_REPLY_TO_EMAIL: 'support@dpi-bot.com',
        NOTICE_EMAIL: {
            async send(message) {
                sentMessages.push(message);
                return { messageId: 'email-message-1' };
            },
        },
    };
    const message = {
        body: { version: 1, deliveryId: 'delivery-1', campaignId: 'campaign-1' },
        ack() { acknowledged = true; },
        retry() { retried = true; },
    };

    await worker.queue({ messages: [message] }, env);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].to, 'reader@example.com');
    assert.doesNotMatch(sentMessages[0].html, /<script>/u);
    assert.equal(acknowledged, true);
    assert.equal(retried, false);
    assert.ok(updates.some((update) => update.sql.includes("status = 'sending'")));
    assert.ok(updates.some((update) => update.sql.includes("status = 'sent'")));
    assert.ok(updates.some((update) => update.sql.includes("status = 'completed'")));
});

test('カテゴリ・件名・本文を許可リストと制御文字で検証する', () => {
    assert.deepEqual(
        newsletterTest.validateCategories(['update', 'maintenance']),
        ['maintenance', 'update'],
    );
    assert.throws(() => newsletterTest.validateCategories(['update', 'unknown']), /配信/u);
    assert.throws(() => newsletterTest.validateCampaignSubject('件名\nBcc: attacker@example.com'), /件名/u);
    assert.throws(() => newsletterTest.validateCampaignBody('本文\u0000'), /本文/u);
});

test('配信停止トークンはHMAC署名付きで改変を比較できる', async () => {
    const subscriber = { id: 'subscriber-id', email: 'reader@example.com' };
    const secret = 's'.repeat(48);
    const token = await newsletterTest.createUnsubscribeToken(
        subscriber,
        secret,
    );
    const [payload, signature] = token.split('.');
    const env = {
        NEWSLETTER_TOKEN_SECRET: secret,
        NEWSLETTER_DB: {
            prepare() {
                return {
                    bind(id) {
                        return { first: async () => id === subscriber.id ? subscriber : null };
                    },
                };
            },
        },
    };

    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    assert.deepEqual(await newsletterTest.verifyUnsubscribeToken(token, env), subscriber);
    assert.equal(await newsletterTest.verifyUnsubscribeToken(`${payload}A.${signature}`, env), null);
    assert.equal(newsletterTest.constantTimeEqual(
        Uint8Array.of(1, 2, 3),
        Uint8Array.of(1, 2, 3),
    ), true);
    assert.equal(newsletterTest.constantTimeEqual(
        Uint8Array.of(1, 2, 3),
        Uint8Array.of(1, 2, 4),
    ), false);
    assert.notEqual(`${payload}A.${signature}`, token);
});

test('AccessのチームドメインはCloudflare AccessのHTTPS発行元だけを許可する', () => {
    assert.equal(
        accessTest.normalizeTeamDomain('https://dpi.cloudflareaccess.com'),
        'https://dpi.cloudflareaccess.com',
    );
    assert.equal(accessTest.normalizeTeamDomain('https://attacker.example'), '');
    assert.equal(accessTest.normalizeTeamDomain('http://dpi.cloudflareaccess.com'), '');
    assert.equal(accessTest.audienceMatches(['first', 'target'], 'target'), true);
});

test('Access JWTの署名・発行元・AUD・管理者メールをすべて検証する', async () => {
    const originalFetch = globalThis.fetch;
    const teamDomain = 'https://unit-test.cloudflareaccess.com';
    const audience = 'test-audience';
    const keyPair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    publicJwk.kid = 'test-key';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    const encode = (value) => Buffer.from(value).toString('base64url');
    const makeToken = async (overrides = {}) => {
        const header = encode(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
        const payload = encode(JSON.stringify({
            iss: teamDomain,
            aud: audience,
            email: 'admin@example.com',
            sub: 'admin-subject',
            iat: Math.floor(Date.now() / 1_000) - 10,
            exp: Math.floor(Date.now() / 1_000) + 600,
            ...overrides,
        }));
        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            keyPair.privateKey,
            new TextEncoder().encode(`${header}.${payload}`),
        );
        return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
    };

    globalThis.fetch = async (url) => {
        assert.equal(String(url), `${teamDomain}/cdn-cgi/access/certs`);
        return Response.json({ keys: [publicJwk] });
    };

    try {
        const validRequest = new Request('https://dpi-bot.com/site/mail-admin/api/summary', {
            headers: { 'Cf-Access-Jwt-Assertion': await makeToken() },
        });
        const identity = await authenticateNewsletterAdmin(validRequest, {
            ACCESS_TEAM_DOMAIN: teamDomain,
            ACCESS_AUD: audience,
            MAIL_ADMIN_EMAILS: 'admin@example.com',
        });
        assert.equal(identity.email, 'admin@example.com');

        const wrongAudienceRequest = new Request('https://dpi-bot.com/site/mail-admin/api/summary', {
            headers: { 'Cf-Access-Jwt-Assertion': await makeToken({ aud: 'wrong-audience' }) },
        });
        await assert.rejects(
            authenticateNewsletterAdmin(wrongAudienceRequest, {
                ACCESS_TEAM_DOMAIN: teamDomain,
                ACCESS_AUD: audience,
                MAIL_ADMIN_EMAILS: 'admin@example.com',
            }),
            (error) => error.code === 'invalid_access_token',
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
