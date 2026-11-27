import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { handleAdminCenterRequest } from '../worker/admin-center.js';
import { __test as cdnAdminWorkerTest } from '../worker/cdn-admin.js';

const SAMPLE_INVENTORY = {
    generatedAt: '2026-11-18T12:00:00Z',
    locations: [
        {
            id: 'r2', label: 'Cloudflare R2', available: true, error: '', objects: 3, bytes: 2_500_500,
            categories: [
                { id: 'small', label: '小さい画像', objects: 2, bytes: 500, latest: '2026-11-18T10:00:00Z' },
                { id: 'large', label: '大きい画像', objects: 1, bytes: 2_500_000, latest: '2026-11-18T11:00:00Z' },
            ],
        },
    ],
};

const SAMPLE_STATS = {
    version: 1,
    generatedAt: '2026-11-18T12:00:00Z',
    month: '2026-11',
    role: 'home',
    health: {
        source: 'worker',
        enabled: true,
        providers: [
            { name: 'r2', configured: true, up: true, reason: '', checkedAt: '2026-11-18T11:59:30Z', downEvents24h: 2, lastDownAt: '2026-11-18T03:00:00Z', lastDownReason: 'timeout' },
            { name: 's3', configured: true, up: false, reason: 'probe AccessDenied', checkedAt: '2026-11-18T11:59:30Z', downEvents24h: 1, lastDownAt: '2026-11-18T10:00:00Z', lastDownReason: 'probe AccessDenied' },
        ],
    },
    r2: { configured: true, available: true, bytes: 20_000_000_000, objects: 40_000, uploadsThisMonth: 600_000, month: '2026-11', quotaBytes: 50_000_000_000, monthlyUploadCap: 1_300_000, computedAt: '2026-11-18T06:07:00Z' },
    aws: {
        configured: true,
        s3: { available: true, bytes: 2_000_000_000, objects: 1234, measuredAt: '2026-11-17T00:00:00Z' },
        cloudfront: { available: true, requests: 3000, bytesDownloaded: 3_000_000_000, month: '2026-11' },
    },
    r2Analytics: { configured: false },
    sendModes: { last24h: { 'aws:r2': 30, 'direct:attach': 2 }, month: { 'aws:r2': 900, 'aws:s3': 12, 'direct:attach': 5 }, jobs24h: 20, jobsMonth: 600, uploadMs24h: { count: 20, avg: 180.5, p95: 420, max: 900 }, monthComplete: true },
    cost: {
        projection: 'month-end', monthFraction: 0.58, jpyPerUsd: 150, budgetJpy: 500, totalUsd: 1.5, totalJpy: 225, withinBudget: true,
        providers: {
            r2: { basis: 'estimate', items: { storage: 0.15, classA: 0.9, classB: 0 }, usd: 1.05, jpy: 158 },
            s3: { basis: 'estimate', items: { storage: 0.05, put: 0.4, get: 0 }, usd: 0.45, jpy: 68 },
        },
    },
    limits: { r2QuotaBytes: 50_000_000_000, r2MonthlyUploadCap: 1_300_000, cloudfrontFreeBytes: 1e12, cloudfrontFreeRequests: 10_000_000 },
};

class FakeBucket {
    constructor(objects = {}) {
        this.objects = objects;
        this.reads = [];
    }
    async get(key) {
        this.reads.push(key);
        const value = this.objects[key];
        if (value === undefined) return null;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return { size: text.length, uploaded: new Date('2026-11-18T12:00:05Z'), text: async () => text };
    }
    async put() { throw new Error('the admin site must never write'); }
    async list() { throw new Error('the admin site must never list'); }
    async delete() { throw new Error('the admin site must never delete'); }
}

// One key for the whole file: access.js caches the signing keys per team domain.
const keyPair = crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
);

async function withAccess(run, email = 'admin@example.com') {
    const { privateKey, publicKey } = await keyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const signingInput = `${encode({ alg: 'RS256', kid: 'cdn-test-key' })}.${encode({
        iss: 'https://test-team.cloudflareaccess.com', aud: 'test-audience', email, sub: 's', iat: now, exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput));
    const token = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: 'cdn-test-key' }] });
    try {
        await run(token);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function adminEnv(bucket) {
    return {
        ACCESS_AUD: 'test-audience',
        ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
        ADMIN_EMAILS: 'admin@example.com',
        ASSETS: { fetch: async () => new Response('cdn page', { headers: { 'Content-Type': 'text/html' } }) },
        ...(bucket ? { IMAGE_CDN_META: bucket } : {}),
    };
}

const api = (headers = {}, method = 'GET') => new Request('https://dpi-bot.com/site/cdn-admin/api/stats', { method, headers });

test('画像CDNの集計APIはAccess認証済みの管理者だけに返し、R2は読み取りだけ', async () => {
    const bucket = new FakeBucket({ 'admin-stats.json': SAMPLE_STATS, 'usage.json': { bytes: 1, objects: 1, computedAt: '2026-11-18T06:07:00Z' } });

    const anonymous = await handleAdminCenterRequest(api(), adminEnv(bucket));
    assert.equal(anonymous.status, 403);
    assert.equal(bucket.reads.length, 0);
    const page = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/cdn-admin/'), adminEnv(bucket));
    assert.equal(page.status, 403);

    await withAccess(async (token) => {
        const denied = await handleAdminCenterRequest(api({ 'cf-access-jwt-assertion': token }), adminEnv(bucket));
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, 'admin_not_allowed');
        assert.equal(bucket.reads.length, 0);
    }, 'someone@example.com');

    await withAccess(async (token) => {
        const headers = { 'cf-access-jwt-assertion': token };
        const response = await handleAdminCenterRequest(api(headers), adminEnv(bucket));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.admin, 'admin@example.com');
        assert.deepEqual(body.stats, SAMPLE_STATS);
        assert.equal(body.usage.computedAt, '2026-11-18T06:07:00Z');
        assert.equal(body.statsSavedAt, '2026-11-18T12:00:05.000Z');
        assert.deepEqual(bucket.reads.sort(), ['admin-stats.json', 'usage.json']);

        assert.equal((await handleAdminCenterRequest(api(headers, 'POST'), adminEnv(bucket))).status, 405);

        const unbound = await handleAdminCenterRequest(api(headers), adminEnv(null));
        assert.equal(unbound.status, 503);
        assert.equal((await unbound.json()).code, 'image_cdn_not_configured');

        const empty = await (await handleAdminCenterRequest(api(headers), adminEnv(new FakeBucket()))).json();
        assert.equal(empty.success, true);
        assert.equal(empty.stats, null);
        assert.equal(empty.statsError, null);

        const broken = await (await handleAdminCenterRequest(api(headers), adminEnv(new FakeBucket({ 'admin-stats.json': '[1' })))).json();
        assert.equal(broken.stats, null);
        assert.match(broken.statsError, /解析/u);

        const pageOk = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/cdn-admin/', { headers }), adminEnv(bucket));
        assert.equal(pageOk.status, 200);
        assert.match(pageOk.headers.get('content-security-policy'), /script-src 'self'/u);
        const redirect = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/cdn-admin', { headers }), adminEnv(bucket));
        assert.equal(redirect.status, 308);
    });
});

test('wrangler.jsonc は非公開のメタデータ用R2バケットだけを IMAGE_CDN_META として結び付ける', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.deepEqual(config.r2_buckets, [{ binding: 'IMAGE_CDN_META', bucket_name: 'dpi-image-cdn-meta' }]);
});

// --- page rendering with a minimal DOM ---------------------------------------------------------
class FakeElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.ownText = '';
        this.listeners = {};
    }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; this.ownText = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    findAll(predicate, found = []) {
        for (const child of this.children) {
            if (predicate(child)) found.push(child);
            child.findAll(predicate, found);
        }
        return found;
    }
}

async function renderPage(payload, status = 200) {
    const html = await readFile(new URL('../site/cdn-admin/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../site/cdn-admin/script.js', import.meta.url), 'utf8');
    const ids = [...html.matchAll(/id="([^"]+)"/gu)].map((match) => match[1]);
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement('div')]));
    const document = {
        readyState: 'complete',
        hidden: false,
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => elements[id] || null,
        addEventListener() {},
    };
    const intervals = [];
    const context = vm.createContext({
        document,
        fetch: async (url) => { assert.equal(url, '/site/cdn-admin/api/stats'); return Response.json(payload, { status }); },
        setInterval: (fn, ms) => { intervals.push(ms); return 1; },
        clearInterval() {},
        Intl, Date, Number, Math, Object, Array, Set, JSON, String, Boolean, Promise,
    });
    context.globalThis = context;
    vm.runInContext(script, context);
    await context.CdnAdmin.ready;
    return { elements, intervals, html, cdnAdmin: context.CdnAdmin };
}

test('画像CDN管理画面はサンプル集計をカード・表で表示し60秒ごとに更新する', async () => {
    const { elements, intervals, html } = await renderPage({
        success: true, admin: 'admin@example.com', fetchedAt: '2026-11-18T12:30:00Z', stats: SAMPLE_STATS,
        statsSavedAt: '2026-11-18T12:00:05Z', usage: null,
    });
    assert.deepEqual(intervals, [60_000]);
    assert.match(html, /<a href="\/site\/cdn-admin\/" class="active" aria-current="page">画像CDN<\/a>/u);
    assert.doesNotMatch(html, /支援|寄付|購入|決済/u);
    assert.equal(elements['admin-email'].textContent, 'admin@example.com');
    const overview = elements['overview-cards'].textContent;
    assert.match(overview, /225円/u);
    assert.match(overview, /予算 500円/u);
    assert.match(overview, /20\.00 GB/u);
    assert.match(overview, /600,000件/u);
    assert.match(overview, /R2 UP \/ S3 DOWN/u);
    const r2 = elements['r2-cards'];
    assert.match(r2.textContent, /20\.00 GB \/ 50\.00 GB/u);
    assert.match(r2.textContent, /未設定/u);                     // analytics token not configured
    const bars = r2.findAll((node) => node.className.startsWith('cdn-bar-fill'));
    assert.equal(bars[0].style.width, '40.0%');
    assert.equal(bars[1].style.width, '46.2%');
    assert.match(elements['aws-cards'].textContent, /3\.00 GB \/ 1\.00 TB/u);
    assert.match(elements['aws-cards'].textContent, /1,234件/u);
    const health = elements['health-rows'].textContent;
    assert.match(health, /Cloudflare R2UP/u);
    assert.match(health, /AWS S3DOWNprobe AccessDenied/u);
    assert.match(health, /2回/u);
    const modes = elements['mode-rows'].textContent;
    assert.match(modes, /AWS経由／画像R230件900件/u);
    assert.match(modes, /AWS経由／画像S30件12件/u);
    assert.match(modes, /自宅直送／添付2件5件/u);
    assert.match(elements['modes-note'].textContent, /平均 180\.5ms/u);
    const cost = elements['cost-rows'].textContent;
    assert.match(cost, /Cloudflare R2/u);
    assert.match(cost, /合計.*\$1\.50225円/u);
    assert.match(elements['budget-bar'].textContent, /225円 \/ 500円/u);
    assert.equal(elements['stale-notice'].hidden, true);           // 30 minutes old: fresh
});

test('集計がまだ無い・古い・API失敗の表示', async () => {
    const empty = await renderPage({ success: true, admin: 'a', fetchedAt: '2026-11-18T12:30:00Z', stats: null, usage: null });
    assert.match(empty.elements['global-status'].textContent, /まだ集計がありません/u);
    assert.match(empty.elements['health-rows'].textContent, /記録がありません/u);

    const stale = await renderPage({ success: true, admin: 'a', fetchedAt: '2026-11-18T18:00:00Z', stats: SAMPLE_STATS, usage: null });
    assert.equal(stale.elements['stale-notice'].hidden, false);
    assert.match(stale.elements['stale-notice'].textContent, /6時間以上/u);

    const failed = await renderPage({ success: false, message: 'Cloudflare Accessでの認証が必要です。' }, 403);
    assert.match(failed.elements['global-status'].textContent, /Cloudflare Access/u);
    assert.equal(failed.elements['global-status'].className, 'status error');
});

test('画像内訳は usage 内の正常な集計も大きさの降順・日本時間で表示する', async () => {
    const page = await renderPage({
        success: true, admin: 'a', fetchedAt: '2026-11-18T12:30:00Z', stats: {}, usage: { inventory: SAMPLE_INVENTORY },
    });
    const text = page.elements['inventory-locations'].textContent;
    assert.match(page.elements['inventory-generated-at'].textContent, /2026\/11\/18 21:00:00/u);
    assert.match(text, /Cloudflare R2合計 3枚 ／ 2\.5 MB/u);
    assert.ok(text.indexOf('大きい画像') < text.indexOf('小さい画像'));
    assert.match(text, /2026\/11\/18 20:00:00/u);
    assert.doesNotMatch(await readFile(new URL('../site/cdn-admin/script.js', import.meta.url), 'utf8'), /innerHTML/u);
    assert.equal(cdnAdminWorkerTest.MAX_OBJECT_BYTES, 2 * 1024 * 1024);
});

test('画像内訳は項目が欠けていても表示用データを安全に補う', async () => {
    const { cdnAdmin } = await renderPage({ success: true, admin: 'a', fetchedAt: '2026-11-18T12:30:00Z', stats: {}, usage: null });
    const view = cdnAdmin.inventoryViewModel({ locations: [{ categories: [{}] }] });
    assert.equal(view.available, true);
    assert.deepEqual(JSON.parse(JSON.stringify(view.locations[0])), {
        id: '', label: '保存先', available: false, error: '', objects: 0, bytes: 0,
        categories: [{ id: '', label: '種類不明', objects: 0, bytes: 0, latest: '未記録' }],
    });
    assert.equal(view.generatedAt, '未記録');
});

test('画像内訳が無い・壊れている場合は次回集計の案内を表示する', async () => {
    const page = await renderPage({
        success: true, admin: 'a', fetchedAt: '2026-11-18T12:30:00Z', stats: { inventory: { locations: 'broken' } }, usage: null,
    });
    assert.equal(page.cdnAdmin.inventoryViewModel(null).available, false);
    assert.equal(page.cdnAdmin.inventoryViewModel('broken').available, false);
    assert.match(page.elements['inventory-locations'].textContent, /まだ集計されていません（自宅の集計は 1 時間ごと）/u);
});

test('取得失敗の保存先は型名だけの理由と空の内訳を表示する', async () => {
    const inventory = {
        generatedAt: '2026-11-18T12:00:00Z',
        locations: [{ id: 'home', label: '自宅', available: false, error: 'TimeoutError', objects: 0, bytes: 0, categories: [] }],
    };
    const page = await renderPage({
        success: true, admin: 'a', fetchedAt: '2026-11-18T12:30:00Z', stats: { inventory }, usage: null,
    });
    assert.match(page.elements['inventory-locations'].textContent, /自宅合計 0枚 ／ 0 B ／ 取得不可: TimeoutError/u);
    assert.match(page.elements['inventory-locations'].textContent, /取得できなかったため内訳はありません。/u);
});
