import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    assert.equal(response.headers.get('referrer-policy'), 'origin');
});

test('確認フォームはOriginが省略されても同一サイトのブラウザ遷移なら登録できる', async () => {
    const token = 'B'.repeat(43);
    let subscriberWasActivated = false;
    const database = {
        prepare(sql) {
            return {
                bind() {
                    return this;
                },
                async first() {
                    if (sql.includes('FROM newsletter_subscribers WHERE confirmation_token_hash')) {
                        return {
                            id: 'subscriber-id',
                            pending_categories: 'outage,update',
                            pending_consent_version: '2026-08-29',
                            confirmation_expires_at: new Date(Date.now() + 60_000).toISOString(),
                        };
                    }
                    return null;
                },
                async run() {
                    if (sql.includes("status = 'active'")) subscriberWasActivated = true;
                    return { meta: { changes: 1 } };
                },
            };
        },
        async batch() {
            return [];
        },
    };
    const response = await worker.fetch(new Request('https://dpi-bot.com/api/newsletter/confirm', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate',
        },
        body: new URLSearchParams({ token }),
    }), minimalEnvironment({
        NEWSLETTER_DB: database,
        NEWSLETTER_TOKEN_SECRET: 'x'.repeat(48),
    }));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(subscriberWasActivated, true);
    assert.match(html, /登録が完了しました/u);
});

test('確認フォームは異なるサイトのOriginをFetch Metadataで上書きできない', async () => {
    const response = await worker.fetch(new Request('https://dpi-bot.com/api/newsletter/confirm', {
        method: 'POST',
        headers: {
            Origin: 'https://attacker.example',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate',
        },
        body: new URLSearchParams({ token: 'C'.repeat(43) }),
    }), minimalEnvironment({
        NEWSLETTER_DB: { prepare() {} },
        NEWSLETTER_TOKEN_SECRET: 'x'.repeat(48),
    }));
    const html = await response.text();

    assert.equal(response.status, 403);
    assert.match(html, /このページ以外からは操作できません/u);
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

test('管理画面サマリーはD1予約語を列名に使わずbatchで集計する', async () => {
    const capturedSql = [];
    const database = {
        prepare(sql) {
            capturedSql.push(sql);
            return { sql };
        },
        async batch(statements) {
            assert.equal(statements.length, 3);
            return [
                { results: [{ status: 'active', count: 1 }] },
                {
                    results: [{
                        maintenance_count: 0,
                        outage_count: 1,
                        update_count: 1,
                        maintenance_outage_count: 1,
                        maintenance_update_count: 1,
                        outage_update_count: 1,
                        maintenance_outage_update_count: 1,
                    }],
                },
                { results: [] },
            ];
        },
    };
    const response = await newsletterTest.adminSummary(
        { NEWSLETTER_DB: database },
        { email: 'admin@example.com' },
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.subscribers.active, 1);
    assert.deepEqual(result.subscribers.categories, {
        maintenance: 0,
        outage: 1,
        update: 1,
    });
    assert.equal(result.subscribers.audiences['maintenance,outage'], 1);
    assert.equal(result.subscribers.audiences['maintenance,outage,update'], 1);
    assert.doesNotMatch(capturedSql.join('\n'), /\bAS\s+update\b/iu);
    assert.match(capturedSql.join('\n'), /AS update_count/iu);
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

test('メール本文は安全なMarkdownだけをHTMLへ変換する', () => {
    const email = newsletterTest.buildCampaignEmail({
        campaign_id: 'campaign-markdown',
        category: 'maintenance,outage',
        subject: 'Markdown配信テスト',
        body_text: [
            '## 状況のお知らせ',
            '',
            '**重要**な内容と`コード`です。',
            '- 項目1',
            '- 項目2',
            '> 続報をお待ちください。',
            '[公式サイト](https://dpi-bot.com/)',
            '<script>alert(1)</script>',
            '[危険](javascript:alert(1))',
        ].join('\n'),
        email: 'reader@example.com',
    }, 'signed-token.value', {
        NOTICE_FROM_EMAIL: 'notice@dpi-bot.com',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
    });

    assert.match(email.html, /メンテナンス情報・障害・重要情報/u);
    assert.match(email.html, /<h3[^>]*>状況のお知らせ<\/h3>/u);
    assert.match(email.html, /<strong>重要<\/strong>/u);
    assert.match(email.html, /<code[^>]*>コード<\/code>/u);
    assert.match(email.html, /<ul[^>]*><li>項目1<\/li><li>項目2<\/li><\/ul>/u);
    assert.match(email.html, /<blockquote[^>]*>続報をお待ちください。<\/blockquote>/u);
    assert.match(email.html, /href="https:\/\/dpi-bot\.com\/"/u);
    assert.doesNotMatch(email.html, /<script>/u);
    assert.match(email.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    assert.doesNotMatch(email.html, /href="javascript:/u);
});

test('複数カテゴリ配信は購読カテゴリが1つでも一致すれば対象になる', () => {
    assert.equal(
        newsletterTest.serializedCategoriesOverlap('outage', 'maintenance,outage'),
        true,
    );
    assert.equal(
        newsletterTest.serializedCategoriesOverlap('update', 'maintenance,outage'),
        false,
    );
    assert.deepEqual(
        newsletterTest.parseSerializedCategories('outage,maintenance'),
        ['maintenance', 'outage'],
    );
});

test('管理画面はカテゴリチップ・3種類のテンプレート・隔離プレビューを備える', async () => {
    const [html, script, style] = await Promise.all([
        readFile(new URL('../site/mail-admin/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/mail-admin/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../site/mail-admin/style.css', import.meta.url), 'utf8'),
    ]);

    assert.equal((html.match(/name="campaign-categories"/gu) || []).length, 3);
    assert.match(html, /data-template="maintenance"/u);
    assert.match(html, /data-template="outage"/u);
    assert.match(html, /data-template="update"/u);
    assert.match(html, /<iframe[^>]+id="email-preview"[^>]+sandbox(?:\s|>)/u);
    assert.doesNotMatch(html, /sandbox="[^"]*(?:allow-scripts|allow-same-origin)/u);
    assert.match(script, /\/site\/mail-admin\/api\/preview/u);
    assert.match(script, /URL\.createObjectURL/u);
    assert.doesNotMatch(script, /\.innerHTML\s*=/u);
    assert.match(style, /background:\s*#444950/iu);
    assert.match(style, /\.category-chip input:checked \+ span/u);
});

test('全ページの左メニューは同じ10項目とメール配信リンクを使用する', async () => {
    const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
    const expectedLabels = [
        'トップページ',
        'コマンド',
        '配信内容',
        'お知らせ',
        '開発者紹介',
        'BOTを招待',
        'ご支援のお願い',
        '利用規約等',
        'お問い合わせ',
        'メール配信',
    ];
    const htmlFiles = [];
    const collectHtmlFiles = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const entryPath = join(directory, entry.name);
            if (entry.isDirectory()) await collectHtmlFiles(entryPath);
            else if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(entryPath);
        }
    };
    await collectHtmlFiles(repositoryRoot);

    let sidebarCount = 0;
    for (const file of htmlFiles) {
        const html = await readFile(file, 'utf8');
        const sidebar = html.match(/<nav\b[^>]*class="[^"]*\bsidebar\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/u);
        if (!sidebar) continue;
        sidebarCount += 1;
        const labels = Array.from(sidebar[1].matchAll(/<a\b[^>]*>([^<]+)<\/a>/gu))
            .map((match) => match[1].trim());
        assert.deepEqual(labels, expectedLabels, file);

        const mailLink = sidebar[1].match(/<a\b[^>]*href="([^"]+)"[^>]*>メール配信<\/a>/u);
        assert.ok(mailLink, file);
        const resolvedMailPath = resolve(dirname(file), mailLink[1]);
        const expectedMailPath = resolve(repositoryRoot, 'site/mail/index.html');
        assert.ok(
            resolvedMailPath === expectedMailPath || resolve(resolvedMailPath, 'index.html') === expectedMailPath,
            `${file}: ${mailLink[1]}`,
        );
    }
    assert.ok(sidebarCount > 0);
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
