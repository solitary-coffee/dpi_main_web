import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAdminCenterRequest } from '../worker/admin-center.js';
import { handlePatliteIngest } from '../worker/patlite-admin.js';
import { PatliteEngine, desiredPattern, parseConfig, parseStatus, setCommand } from '../site/patlite-admin/logic.js';

class FakeD1 {
    constructor() { this.row = null; this.writes = 0; }
    prepare(sql) {
        const db = this;
        return {
            bind(...args) { this.args = args; return this; },
            async run() { if (/INSERT INTO patlite_state/u.test(sql)) { db.writes += 1; db.row = { body: this.args[0], generated_at: this.args[1], received_at: this.args[2] }; } return {}; },
            async first() { return db.row; },
        };
    }
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
    const signingInput = `${encode({ alg: 'RS256', kid: 'patlite-test-key' })}.${encode({
        iss: 'https://test-team.cloudflareaccess.com', aud: 'test-audience', email, sub: 's', iat: now, exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput));
    const token = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: 'patlite-test-key' }] });
    try {
        await run(token);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function env(db = new FakeD1()) {
    return {
        ACCESS_AUD: 'test-audience',
        ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
        ADMIN_EMAILS: 'admin@example.com',
        ASSETS: { fetch: async () => new Response('patlite page', { headers: { 'Content-Type': 'text/html' } }) },
        PATLITE_BRIDGE_TOKEN: 'bridge-secret',
        REUSE_DB: db,
    };
}

const ingest = (body, token = 'bridge-secret', method = 'POST') => new Request('https://dpi-bot.com/api/patlite/ingest', {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
});

test('積層灯ブリッジの送信は合言葉が合うときだけ保存し、管理者だけが読める', async () => {
    const db = new FakeD1();
    const environment = env(db);
    assert.equal(await handlePatliteIngest(new Request('https://dpi-bot.com/other'), environment), null);
    assert.equal((await handlePatliteIngest(ingest({ conditions: [] }, null), environment)).status, 401);
    assert.equal((await handlePatliteIngest(ingest({ conditions: [] }, 'wrong'), environment)).status, 401);
    assert.equal((await handlePatliteIngest(ingest({ conditions: 'x' }), environment)).status, 400);
    assert.equal((await handlePatliteIngest(ingest(null, 'bridge-secret', 'GET'), environment)).status, 405);
    assert.equal(db.writes, 0);
    const ok = await handlePatliteIngest(ingest({ generated_at: 100, conditions: [
        { id: 'home:critical:EEW配信', kind: 'home_critical', title: '停止', since: 90, until: null },
        { id: 'bad', kind: '<script>', title: 'x' },
    ] }), environment);
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).accepted, 1);

    const stateApi = (headers = {}) => new Request('https://dpi-bot.com/site/patlite-admin/api/state', { headers });
    assert.equal((await handleAdminCenterRequest(stateApi(), environment)).status, 403);
    await withAccess(async (token) => {
        const response = await handleAdminCenterRequest(stateApi({ 'cf-access-jwt-assertion': token }), environment);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.conditions.length, 1);
        assert.equal(body.conditions[0].kind, 'home_critical');
        assert.equal(body.generatedAt, 100);
        assert.ok(body.serverTime > 0 && body.receivedAt > 0);
        const page = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/patlite-admin/', { headers: { 'cf-access-jwt-assertion': token } }), environment);
        assert.equal(page.status, 200);
    });
});

const lamps = (on = {}) => ({ red: 'off', yellow: 'off', green: 'off', blue: 'off', white: 'off', ...on });

test('表示の決まり: 正常は消灯、最長5分、重大障害は再表示、点滅は色ごと', () => {
    assert.deepEqual(desiredPattern([], new Set(), 100).lamps, lamps());
    const failover = [{ id: 'a', kind: 'aws_failover', since: 0 }, { id: 'd', kind: 'home_degraded', since: 0 }];
    assert.deepEqual(desiredPattern(failover, new Set(), 10).lamps, lamps({ red: 'flash', blue: 'flash', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 120).lamps, lamps({ red: 'on', blue: 'on', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 400).lamps, lamps());
    assert.deepEqual(desiredPattern(failover, new Set(), 300 + 1790).lamps, lamps({ red: 'flash', blue: 'flash' }));
    assert.deepEqual(desiredPattern([{ id: 'e', kind: 'eew_warning', since: 0 }], new Set(['e']), 10).lamps, lamps());
});

test('Arduino の応答の読み取りとコマンド', () => {
    const status = parseStatus('OK STATUS FS=0 R=FLASH Y=OFF G=OFF B=ON W=OFF BZ=0 BZA=0 LINK=OK HM=SOFTWARE BTN=0 LED=GREEN PERIOD=500 EV=REMOTE_SET EC=12 UP=30');
    assert.deepEqual(status.lamps, lamps({ red: 'flash', blue: 'on' }));
    assert.equal(status.eventCounter, 12);
    assert.equal(status.fullStop, false);
    assert.deepEqual(parseConfig('OK CFG MAXD=120 RINT=600 RLEN=20 RECV=0 PERIOD=400 HTO=90'),
        { maxDisplay: 120, reminderInterval: 600, reminder: 20, recovery: 0, period: 400, hostTimeout: 90 });
    assert.equal(parseConfig('ERR UNKNOWN_COMMAND'), null);
    assert.equal(setCommand(lamps({ white: 'flash', yellow: 'on' })), 'SET R=OFF Y=ON G=OFF B=OFF W=FLASH BZ=0');
});

test('復旧の緑・途絶・ボタンでの確認', () => {
    const engine = new PatliteEngine(0);
    engine.update([{ id: 'home:critical:x', kind: 'home_critical', since: 5 }], 10, 0, 10);
    assert.deepEqual(engine.pattern(11).lamps, lamps({ red: 'flash' }));
    engine.acknowledge(12);
    assert.deepEqual(engine.pattern(13).lamps, lamps());
    engine.update([], 20, 0, 20);
    assert.deepEqual(engine.pattern(21).lamps, lamps({ green: 'on' }));
    assert.deepEqual(engine.pattern(90).lamps, lamps());
    // サイトに 3 分以上新しい送信が無い → 青の点滅、届いたら復旧の緑
    assert.deepEqual(engine.pattern(20 + 181).lamps, lamps({ blue: 'flash' }));
    engine.update([], 300, 0, 300);
    assert.deepEqual(engine.pattern(301).lamps, lamps({ green: 'on' }));
});

test('管理ページは module で読み込み、ブザーを鳴らすコマンドを送らない', async () => {
    const html = await readFile(new URL('../site/patlite-admin/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../site/patlite-admin/script.js', import.meta.url), 'utf8');
    assert.match(html, /<script type="module" src="script.js"><\/script>/u);
    assert.doesNotMatch(script, /BZ=1/u);
    assert.match(script, /new Worker\('ticker\.js'\)/u);
});
