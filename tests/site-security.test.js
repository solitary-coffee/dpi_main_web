import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { withAccessLog } from '../worker/access-log.js';
import { handleReuseRequest, __test as reuseTest } from '../worker/reuse.js';
import { addSiteSecurityHeaders, withSiteSecurity } from '../worker/site-security.js';

test('公開ホストのHTTP GET/HEADだけを同じパスとクエリのHTTPSへ301転送する', async () => {
    for (const method of ['GET', 'HEAD']) {
        const response = await withSiteSecurity(new Request('http://dpi-bot.com/a/b?x=1', { method }), async () => {
            assert.fail('redirect must not call the application');
        });
        assert.equal(response.status, 301);
        assert.equal(response.headers.get('location'), 'https://dpi-bot.com/a/b?x=1');
    }

    const post = await withSiteSecurity(new Request('http://dpi-bot.com/a', { method: 'POST' }), () => new Response('ok'));
    assert.equal(post.status, 200);
    const local = await withSiteSecurity(new Request('http://localhost:8787/a'), () => new Response('local'));
    assert.equal(await local.text(), 'local');
});

test('cf-visitorのHTTPを転送し、HTTPSならURLがHTTPでもループさせない', async () => {
    const redirected = await withSiteSecurity(new Request('https://www.dpi-bot.com/path', {
        headers: { 'cf-visitor': '{"scheme":"http"}' },
    }), () => new Response('unused'));
    assert.equal(redirected.status, 301);

    const noLoop = await withSiteSecurity(new Request('http://dpi-bot.com/path', {
        headers: { 'cf-visitor': '{"scheme":"https"}' },
    }), () => new Response('ok'));
    assert.equal(noLoop.status, 200);
    assert.equal(await noLoop.text(), 'ok');
});

test('既存ヘッダーを上書きせず、HTTPSとHTMLにだけ条件付きヘッダーを足す', () => {
    const request = new Request('https://dpi-bot.com/page');
    const response = addSiteSecurityHeaders(request, new Response('<h1>ok</h1>', {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-frame-options': 'DENY',
            'content-security-policy': "default-src 'none'",
            'referrer-policy': 'no-referrer',
        },
    }));
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=15552000');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), payment=(self "https://checkout.stripe.com")');
});

test('304・204・Webhook・ストリームを消費せずに扱う', async () => {
    for (const status of [204, 304]) {
        const response = addSiteSecurityHeaders(
            new Request('https://dpi-bot.com/empty'),
            new Response(null, { status }),
        );
        assert.equal(response.status, status);
        assert.equal(response.body, null);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('webhook'));
            controller.close();
        },
    });
    const response = addSiteSecurityHeaders(
        new Request('https://dpi-bot.com/api/supporter/stripe/webhook', { method: 'POST' }),
        new Response(stream, { headers: { 'content-type': 'text/plain' } }),
    );
    assert.equal(await response.text(), 'webhook');
    assert.equal(response.headers.get('content-security-policy'), null);

    const switchingProtocols = { status: 101, headers: new Headers(), webSocket: {} };
    assert.equal(addSiteSecurityHeaders(new Request('https://dpi-bot.com/socket'), switchingProtocols), switchingProtocols);
    assert.equal(switchingProtocols.headers.get('x-content-type-options'), 'nosniff');
});

test('アクセスログは成功した静的ファイルを除外し、限度超過時はD1へ書かない', async () => {
    let writes = 0;
    const database = {
        prepare() { return { bind() { return this; }, async run() {} }; },
        async batch() { writes += 1; },
    };
    await withAccessLog(
        new Request('https://dpi-bot.com/app.js', { headers: { 'cf-connecting-ip': '192.0.2.1' } }),
        { ACCESS_LOG_DB: database }, null, 'dpi-bot.com',
        () => new Response('asset', { status: 200 }),
    );
    assert.equal(writes, 0);

    for (const status of [403, 404, 429]) {
        await withAccessLog(
            new Request('https://dpi-bot.com/noisy', { headers: { 'cf-connecting-ip': '192.0.2.1' } }),
            { ACCESS_LOG_DB: database, ACCESS_LOG_RATE_LIMITER: { limit: async () => ({ success: false }) } },
            null, 'dpi-bot.com', () => new Response('noisy', { status }),
        );
    }
    assert.equal(writes, 0);
});

test('アクセスログ制限バインディングなし・例外時は従来どおりD1へ書く', async () => {
    for (const limiter of [undefined, { limit: async () => { throw new Error('unavailable'); } }]) {
        let writes = 0;
        const database = {
            prepare() { return { bind() { return this; }, async run() {} }; },
            async batch() { writes += 1; },
        };
        await withAccessLog(
            new Request('https://dpi-bot.com/api/test', { headers: { 'cf-connecting-ip': '192.0.2.2' } }),
            { ACCESS_LOG_DB: database, ACCESS_LOG_RATE_LIMITER: limiter }, null, 'dpi-bot.com',
            () => Response.json({ ok: true }),
        );
        assert.equal(writes, 1);
    }
});

test('OAuth開始の限度超過は429でD1に触れず、バインディングなし・例外は許可する', async () => {
    let databaseCalls = 0;
    const response = await handleReuseRequest(
        new Request('https://dpi-bot.com/api/reuse/oauth/start', { headers: { 'cf-connecting-ip': '192.0.2.3' } }),
        {
            OAUTH_START_RATE_LIMITER: { limit: async () => ({ success: false }) },
            REUSE_DB: new Proxy({}, { get() { databaseCalls += 1; return undefined; } }),
        },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(databaseCalls, 0);
    assert.match((await response.json()).message, /1分後/u);

    assert.equal(await reuseTest.oauthStartAllowed(new Request('https://dpi-bot.com/'), {}), true);
    assert.equal(await reuseTest.oauthStartAllowed(new Request('https://dpi-bot.com/'), {
        OAUTH_START_RATE_LIMITER: { limit: async () => { throw new Error('unavailable'); } },
    }), true);
});

test('Wranglerに重複しない2つのrate limitを宣言する', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    const access = config.ratelimits.find((item) => item.name === 'ACCESS_LOG_RATE_LIMITER');
    const oauth = config.ratelimits.find((item) => item.name === 'OAUTH_START_RATE_LIMITER');
    assert.deepEqual(access, { name: 'ACCESS_LOG_RATE_LIMITER', namespace_id: '2026112502', simple: { limit: 60, period: 60 } });
    assert.deepEqual(oauth, { name: 'OAUTH_START_RATE_LIMITER', namespace_id: '2026112503', simple: { limit: 10, period: 60 } });
    assert.equal(new Set(config.ratelimits.map((item) => item.namespace_id)).size, config.ratelimits.length);
});
