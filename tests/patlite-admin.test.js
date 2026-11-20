import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAdminCenterRequest } from '../worker/admin-center.js';
import { handlePatliteIngest } from '../worker/patlite-admin.js';
import { PatliteEngine, dailyIlluminationMinute, desiredPattern, isNight, parseConfig, parseStatus, policyFor, setCommand } from '../site/patlite-admin/logic.js';
import { normalizeSettings } from '../worker/patlite-admin.js';

class FakeD1 {
    constructor() { this.row = null; this.settings = null; this.writes = 0; }
    prepare(sql) {
        const db = this;
        return {
            bind(...args) { this.args = args; return this; },
            async run() {
                if (/INSERT INTO patlite_state/u.test(sql)) { db.writes += 1; db.row = { body: this.args[0], generated_at: this.args[1], received_at: this.args[2] }; }
                if (/INSERT INTO patlite_settings/u.test(sql)) db.settings = { body: this.args[0], updated_by: this.args[2] };
                return {};
            },
            async first() { return /patlite_settings/u.test(sql) ? db.settings : db.row; },
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
    assert.match(script, /ILLUM \$\{seconds\}/u);
    assert.match(script, /new Worker\('ticker\.js'\)/u);
});


test('一時停止・夜間モードの設定は管理者だけが保存でき、値を検証する', async () => {
    const db = new FakeD1();
    const environment = env(db);
    const save = (body, headers = {}) => new Request('https://dpi-bot.com/site/patlite-admin/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dpi-bot.com', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await handleAdminCenterRequest(save({}), environment)).status, 403);
    await withAccess(async (token) => {
        const auth = { 'cf-access-jwt-assertion': token };
        const until = Date.now() / 1000 + 3600;
        const response = await handleAdminCenterRequest(save({ snoozeUntil: until, night: { enabled: true, start: '23:00', end: '06:30' }, illumination: { daily: true, seconds: 999 } }, auth), environment);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.settings.night.start, '23:00');
        assert.equal(body.settings.illumination.seconds, 20);   // 範囲外は既定値
        assert.equal(db.settings.updated_by, 'admin@example.com');
        const cross = await handleAdminCenterRequest(save({}, { ...auth, origin: 'https://evil.example' }), environment);
        assert.equal(cross.status, 403);
        const state = await (await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/patlite-admin/api/state', { headers: auth }), environment)).json();
        assert.equal(state.settings.night.enabled, true);
        assert.ok(Math.abs(state.settings.snoozeUntil - until) < 1);
    });
    assert.equal(normalizeSettings({ snoozeUntil: 10, night: { start: '25:00' } }, 100).snoozeUntil, null);
    assert.equal(normalizeSettings({ night: { start: '25:00' } }).night.start, '22:00');
});

test('夜間モードは重大だけ、一時停止は全部消す', () => {
    // 2026-11-20 23:30 JST = 14:30 UTC
    const night = Date.UTC(2026, 10, 20, 14, 30) / 1000;
    const day = Date.UTC(2026, 10, 20, 3, 0) / 1000;      // 12:00 JST
    const settings = { night: { enabled: true, start: '22:00', end: '07:00' } };
    assert.equal(isNight(settings, night), true);
    assert.equal(isNight(settings, day), false);
    assert.equal(isNight({ night: { enabled: true, start: '09:00', end: '17:00' } }, day), true);
    const conditions = [{ id: 'd', kind: 'home_degraded', since: night - 10 }, { id: 'e', kind: 'eew_warning', since: night - 10 }];
    const atNight = desiredPattern(conditions, new Set(), night, undefined, policyFor(settings, night));
    assert.deepEqual(atNight.lamps, lamps({ white: 'flash' }));
    assert.match(atNight.shown[0].suppressed, /夜間/u);
    const snoozed = desiredPattern(conditions, new Set(), night, undefined, policyFor({ snoozeUntil: night + 60 }, night));
    assert.deepEqual(snoozed.lamps, lamps());
    const minute = dailyIlluminationMinute(day);
    assert.ok(minute >= 600 && minute < 1200);
    assert.equal(minute, dailyIlluminationMinute(day + 3600));
});

class HistoryD1 {
    constructor() { this.history = []; this.state = null; this.nextId = 1; }
    prepare(sql) {
        const db = this;
        const statement = {
            sql,
            bind(...args) { this.args = args; return this; },
            async first() { return /patlite_state/u.test(sql) ? db.state : null; },
            async all() { return { results: db.history.filter((row) => row.ended_at === null) }; },
            async run() { return db.exec(this); },
        };
        return statement;
    }
    exec(statement) {
        const { sql, args } = statement;
        if (/^INSERT INTO patlite_history/u.test(sql)) this.history.push({ row_id: this.nextId++, cid: args[0], kind: args[1], title: args[2], started_at: args[3], ended_at: args[4] ?? null });
        else if (/^UPDATE patlite_history/u.test(sql)) this.history.find((row) => row.row_id === args[1]).ended_at = args[0];
        return {};
    }
    async batch(statements) { for (const statement of statements) this.exec(statement); }
}

test('履歴: 出た項目・消えた項目・ブリッジの途絶を記録する', async () => {
    const { recordHistory } = await import('../worker/patlite-admin.js');
    const db = new HistoryD1();
    await recordHistory(db, [{ id: 'aws:alarm:x', kind: 'aws_alarm', title: 'AWS アラーム: x', since: 900 }], 1000);
    db.state = { received_at: 1000 };
    await recordHistory(db, [{ id: 'aws:alarm:x', kind: 'aws_alarm', title: 'AWS アラーム: x', since: 900 }], 1060);   // 変化なし
    assert.equal(db.history.length, 1);
    db.state = { received_at: 1060 };
    await recordHistory(db, [{ id: 'home:critical:EEW配信', kind: 'home_critical', title: '停止', since: 1100 }], 1600);   // 途絶あり・入れ替わり
    const alarm = db.history.find((row) => row.cid === 'aws:alarm:x');
    assert.equal(alarm.started_at, 900);
    assert.equal(alarm.ended_at, 1600);
    const gap = db.history.find((row) => row.kind === 'link_lost');
    assert.deepEqual([gap.started_at, gap.ended_at], [1060 + 180, 1600]);
    assert.equal(db.history.find((row) => row.cid === 'home:critical:EEW配信').ended_at, null);
});
