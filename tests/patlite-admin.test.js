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

test('表示の決まり: 正常は消灯、最長5分→30分消灯→続いていればまた点灯、点滅は色ごと', () => {
    assert.deepEqual(desiredPattern([], new Set(), 100).lamps, lamps());
    const failover = [{ id: 'a', kind: 'aws_failover', since: 0 }, { id: 'd', kind: 'home_degraded', since: 0 }];
    assert.deepEqual(desiredPattern(failover, new Set(), 10).lamps, lamps({ red: 'flash', blue: 'flash', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 120).lamps, lamps({ red: 'on', blue: 'on', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 400).lamps, lamps());
    assert.deepEqual(desiredPattern(failover, new Set(), 300 + 1790).lamps, lamps());
    assert.deepEqual(desiredPattern(failover, new Set(), 2100 + 10).lamps, lamps({ red: 'flash', blue: 'flash', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 2100 + 299).lamps, lamps({ red: 'on', blue: 'on', yellow: 'on' }));
    assert.deepEqual(desiredPattern(failover, new Set(), 2100 + 301).lamps, lamps());
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
    assert.deepEqual(atNight.lamps, lamps({ white: 'flash', red: 'flash' }));
    assert.equal(atNight.shown[0].suppressed, '時間帯設定（重大のみ）により無連動');
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
        if (/^INSERT INTO patlite_history/u.test(sql)) {
            const openRow = /NULL, \?5\)/u.test(sql);   // 続いている項目は ended_at が NULL で、5 番目が理由
            this.history.push({ row_id: this.nextId++, cid: args[0], kind: args[1], title: args[2], started_at: args[3],
                ended_at: openRow ? null : args[4] ?? null, suppressed: (openRow ? args[4] : args[5]) ?? null });
        }
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

test('無期限の一時停止: 解除するまで全部消し、期限付きの値は持たない', async () => {
    const { snoozeText } = await import('../site/patlite-admin/logic.js');
    const settings = normalizeSettings({ snoozeForever: true, snoozeUntil: Date.now() / 1000 + 3600 });
    assert.equal(settings.snoozeForever, true);
    assert.equal(settings.snoozeUntil, null);
    const now = Date.now() / 1000 + 365 * 86400;
    assert.equal(policyFor(settings, now).snoozed, true);
    assert.match(snoozeText(settings, now), /無期限/u);
    const conditions = [{ id: 'h', kind: 'home_critical', since: now - 5 }];
    assert.deepEqual(desiredPattern(conditions, new Set(), now, undefined, policyFor(settings, now)).lamps, lamps());
    assert.equal(normalizeSettings({}).snoozeForever, false);
});


// ---------------- 2026-11-21: 段階・防災は繰り返さない・絞り込み・無連動の理由・確認 3 秒・復旧の緑 5 秒 ----------------
import { ACK_DELAY_SECONDS, LEGEND, LEVELS, MAX_RECOVERY_SECONDS, DEFAULT_TIMING, legendByLevel, suppressionReason, filterText } from '../site/patlite-admin/logic.js';
import { recordHistory } from '../worker/patlite-admin.js';

test('段階: すべての項目に 重大 / 中 / 軽 があり、critical は 重大 と同じ。防災の重大は白と別の色の 2 色', () => {
    const expected = {
        home_critical: '重大', aws_failover: '重大', link_lost: '重大', eew_warning: '重大', tsunami_major: '重大', tsunami_warning: '重大',
        special_warning: '重大', quake_6plus: '重大', nankai_investigating: '重大',
        home_restart_loop: '中', aws_alarm: '中', tsunami_advisory: '中', quake_5: '中', long_term_caution: '中',
        home_degraded: '軽', home_resource: '軽', aws_degraded: '軽', recovered: '軽', maintenance: '軽',
    };
    assert.deepEqual(Object.fromEntries(Object.entries(LEGEND).map(([kind, value]) => [kind, value.level])), expected);
    for (const value of Object.values(LEGEND)) {
        assert.ok(LEVELS.includes(value.level));
        assert.equal(value.critical, value.level === '重大');
        assert.equal(value.repeat, value.group === '障害');
    }
    const pattern = (kind) => `${LEGEND[kind].colors.join('+')}/${LEGEND[kind].flashSeconds}`;
    assert.equal(pattern('eew_warning'), 'white+red/null');
    assert.equal(pattern('tsunami_major'), 'white+red/null');
    assert.equal(pattern('tsunami_warning'), 'white+yellow/null');
    assert.equal(pattern('special_warning'), 'white+yellow/0');
    assert.equal(pattern('quake_6plus'), 'white+red/0');
    assert.equal(pattern('nankai_investigating'), 'white/null');
    for (const kind of ['tsunami_advisory', 'quake_5', 'long_term_caution']) assert.equal(pattern(kind), 'white/0');
    // 同じ色・点き方になるのは、運用者の指定どおりの組（EEW と大津波、白の「中」3 つ）と、以前からの黄 2 つだけ
    const groups = {};
    for (const kind of Object.keys(LEGEND)) (groups[pattern(kind)] ||= []).push(kind);
    const shared = Object.values(groups).filter((kinds) => kinds.length > 1).map((kinds) => kinds.sort().join(','));
    assert.deepEqual(shared.sort(), ['eew_warning,tsunami_major', 'home_degraded,home_resource', 'long_term_caution,quake_5,tsunami_advisory']);
    // 障害の項目は白を使わない（白が点いていれば防災情報）
    for (const value of Object.values(LEGEND)) if (value.group === '障害') assert.ok(!value.colors.includes('white'));
    assert.deepEqual(legendByLevel().map((group) => [group.level, group.items.length]), [['重大', 9], ['中', 5], ['軽', 5]]);
});

test('防災情報は最長5分か確認まで点けたら繰り返さない。障害は30分ごとに繰り返す', () => {
    const eew = [{ id: 'eew_warning:1', kind: 'eew_warning', since: 0 }];
    assert.deepEqual(desiredPattern(eew, new Set(), 10).lamps, lamps({ white: 'flash', red: 'flash' }));
    assert.deepEqual(desiredPattern(eew, new Set(), 299).lamps, lamps({ white: 'flash', red: 'flash' }));
    assert.deepEqual(desiredPattern(eew, new Set(), 301).lamps, lamps());
    assert.deepEqual(desiredPattern(eew, new Set(), 2100 + 10).lamps, lamps());   // 繰り返さない
    assert.equal(desiredPattern(eew, new Set(), 2100 + 10).shown[0].repeat, false);
    const special = [{ id: 'special:x', kind: 'special_warning', since: 0 }];
    assert.deepEqual(desiredPattern(special, new Set(), 10).lamps, lamps({ white: 'on', yellow: 'on' }));
    assert.deepEqual(desiredPattern(special, new Set(), 86400).lamps, lamps());
    // 表示の設定（MAXD）が 5 分より長くても、防災は 5 分まで
    assert.deepEqual(desiredPattern(eew, new Set(), 400, { ...DEFAULT_TIMING, maxDisplay: 600 }).lamps, lamps());
    // 確認したら、続いていてももう点けない
    const engine = new PatliteEngine(0);
    engine.update([{ id: 'quake:1:quake_6plus', kind: 'quake_6plus', since: 10 }], 10, 0, 10);
    assert.deepEqual(engine.pattern(11).lamps, lamps({ white: 'on', red: 'on' }));
    engine.acknowledge(12);
    engine.update([{ id: 'quake:1:quake_6plus', kind: 'quake_6plus', since: 10 }], 2000, 0, 2000);
    assert.deepEqual(engine.pattern(2006).lamps, lamps());   // （2000 の送信は途絶からの復帰なので 5 秒は緑）
    assert.deepEqual(engine.pattern(10 + 1800 + 300 + 5).lamps, lamps());
    // 障害は繰り返す
    const system = [{ id: 'h', kind: 'home_critical', since: 0 }];
    assert.deepEqual(desiredPattern(system, new Set(), 2100 + 10).lamps, lamps({ red: 'flash' }));
});

test('種類が上がったら（注意報→警報→大津波警報）新しい項目としてまた点ける', () => {
    const engine = new PatliteEngine(0);
    engine.update([{ id: 'tsunami:tsunami_advisory', kind: 'tsunami_advisory', since: 0 }], 0, 0, 0);
    assert.deepEqual(engine.pattern(1).lamps, lamps({ white: 'on' }));
    engine.acknowledge(2);
    assert.deepEqual(engine.pattern(3).lamps, lamps());
    // ブリッジは種類ごとに別の id・新しい since で送る
    engine.update([{ id: 'tsunami:tsunami_warning', kind: 'tsunami_warning', since: 400 }], 400, 0, 400);
    assert.deepEqual(engine.pattern(406).lamps, lamps({ white: 'flash', yellow: 'flash' }));   // （途絶からの復帰の緑 5 秒の後）
    engine.update([{ id: 'tsunami:tsunami_warning', kind: 'tsunami_warning', since: 400 }], 700, 0, 700);
    assert.deepEqual(engine.pattern(706).lamps, lamps());
    engine.update([{ id: 'tsunami:tsunami_major', kind: 'tsunami_major', since: 900 }], 900, 0, 900);
    assert.deepEqual(engine.pattern(906).lamps, lamps({ white: 'flash', red: 'flash' }));
});

test('絞り込み: 時間帯設定（重大のみ／中以上）と一時的な絞り込み、無連動の理由', () => {
    const night = Date.UTC(2026, 10, 20, 14, 30) / 1000;   // 23:30 JST
    const conditions = [
        { id: 'd', kind: 'home_degraded', since: night - 10 },     // 軽
        { id: 'l', kind: 'home_restart_loop', since: night - 10 },  // 中
        { id: 'h', kind: 'home_critical', since: night - 10 },      // 重大
    ];
    const reasons = (settings, device) => desiredPattern(conditions, new Set(), night, undefined, policyFor(settings, night, device)).shown.map((item) => item.suppressed);
    const band = (level) => ({ night: { enabled: true, start: '22:00', end: '07:00', level } });
    assert.deepEqual(reasons(band('medium')), ['時間帯設定（中以上）により無連動', '', '']);
    assert.deepEqual(reasons(band('critical')), ['時間帯設定（重大のみ）により無連動', '時間帯設定（重大のみ）により無連動', '']);
    assert.deepEqual(reasons({ night: { enabled: true, start: '22:00', end: '07:00' } }), reasons(band('critical')));   // 以前の夜間モード＝重大のみ
    const temporary = (level, until = night + 3600) => ({ filter: { until, level } });
    assert.deepEqual(reasons(temporary('critical')), ['一時的な絞り込み（重大のみ）により無連動', '一時的な絞り込み（重大のみ）により無連動', '']);
    assert.deepEqual(reasons(temporary('medium')), ['一時的な絞り込み（中以上）により無連動', '', '']);
    assert.deepEqual(reasons(temporary('critical', night - 1)), ['', '', '']);   // 期限切れ
    assert.deepEqual(reasons({ snoozeUntil: night + 60 }), Array(3).fill('一時停止により無連動'));
    assert.deepEqual(reasons({ snoozeForever: true }), Array(3).fill('無期限停止により無連動'));
    assert.deepEqual(reasons(null, { fullStop: true }), Array(3).fill('強制停止により無連動'));
    assert.match(filterText({ ...band('medium'), ...temporary('critical') }, night), /一時的な絞り込み中: 重大のみ.*時間帯設定中（22:00〜07:00）: 中以上/u);
    assert.equal(suppressionReason(LEGEND.link_lost, policyFor(band('critical'), night)), '');
    // サイトに保存する値: level は critical / medium だけ、絞り込みは最長 7 日・過ぎたものは持たない
    const now = 1_000_000;
    assert.equal(normalizeSettings({ night: { enabled: true } }, now).night.level, 'critical');
    assert.equal(normalizeSettings({ night: { level: 'medium' } }, now).night.level, 'medium');
    assert.equal(normalizeSettings({ night: { level: 'all' } }, now).night.level, 'critical');
    assert.deepEqual(normalizeSettings({ filter: { until: now + 30 * 86400, level: 'medium' } }, now).filter, { until: now + 7 * 86400, level: 'medium' });
    assert.deepEqual(normalizeSettings({ filter: { until: now - 1, level: 'medium' } }, now).filter, { until: null, level: 'medium' });
    assert.deepEqual(normalizeSettings({}, now).filter, { until: null, level: 'critical' });
});

test('履歴: 積層灯に出さなかった項目も理由つきで記録する（一時停止・無期限停止・時間帯設定・絞り込み・強制停止）', async () => {
    const night = Date.UTC(2026, 10, 20, 14, 30) / 1000;   // 23:30 JST
    const run = async (context, kind = 'home_degraded') => {
        const db = new HistoryD1();
        await recordHistory(db, [{ id: `x:${kind}`, kind, title: 't', since: night - 5 }], night, context);
        return db.history[0].suppressed;
    };
    assert.equal(await run({}), null);
    assert.equal(await run({ settings: { snoozeUntil: night + 60 } }), '一時停止により無連動');
    assert.equal(await run({ settings: { snoozeForever: true } }), '無期限停止により無連動');
    assert.equal(await run({ settings: { night: { enabled: true, start: '22:00', end: '07:00' } } }), '時間帯設定（重大のみ）により無連動');
    assert.equal(await run({ settings: { night: { enabled: true, start: '22:00', end: '07:00', level: 'medium' } } }, 'quake_5'), null);
    assert.equal(await run({ settings: { filter: { until: night + 60, level: 'medium' } } }), '一時的な絞り込み（中以上）により無連動');
    assert.equal(await run({ device: { fullStop: true } }, 'eew_warning'), '強制停止により無連動');
    // ブリッジの途絶の行にも理由を残す
    const db = new HistoryD1();
    db.state = { received_at: night - 600 };
    await recordHistory(db, [], night, { settings: { snoozeForever: true } });
    assert.equal(db.history.find((row) => row.kind === 'link_lost').suppressed, '無期限停止により無連動');
});

test('確認は 3 秒後に消灯し、復旧の緑は確認を待たず 5 秒（確認ですぐ消える）', () => {
    assert.equal(ACK_DELAY_SECONDS, 3);
    assert.equal(MAX_RECOVERY_SECONDS, 5);
    assert.equal(DEFAULT_TIMING.recovery, 5);
    const engine = new PatliteEngine(0);
    engine.update([{ id: 'home:loop:x', kind: 'home_restart_loop', since: 0 }, { id: 'aws:alarm:y', kind: 'aws_alarm', since: 0 }], 0, 0, 0);
    engine.update([{ id: 'home:loop:x', kind: 'home_restart_loop', since: 0 }], 10, 0, 10);   // AWS のアラームが復旧
    assert.deepEqual(engine.pattern(11).lamps, lamps({ yellow: 'flash', green: 'on' }));
    assert.deepEqual(engine.pattern(14.9).lamps, lamps({ yellow: 'flash', green: 'on' }));
    assert.deepEqual(engine.pattern(15).lamps, lamps({ yellow: 'flash' }));   // 5 秒で消える（確認を待たない）
    engine.update([], 20, 0, 20);   // ループも復旧 → 緑
    engine.update([{ id: 'h', kind: 'home_critical', since: 20 }], 20, 0, 20);
    assert.deepEqual(engine.pattern(21).lamps, lamps({ red: 'flash', green: 'on' }));
    engine.requestAck(21);   // ページ・操作盤の確認
    assert.deepEqual(engine.pattern(21).lamps, lamps({ red: 'flash' }));      // 緑はすぐ消える
    assert.deepEqual(engine.pattern(23.9).lamps, lamps({ red: 'flash' }));    // ほかは 3 秒待つ
    assert.deepEqual(engine.pattern(24).lamps, lamps());
    assert.equal(engine.ackDueAt, null);
    // Arduino に古い RECV=60 が残っていても 5 秒
    const old = new PatliteEngine(0);
    old.timing = { ...DEFAULT_TIMING, recovery: 60 };
    old.update([{ id: 'a', kind: 'aws_degraded', since: 0 }], 0, 0, 0);
    old.update([], 1, 0, 1);
    assert.deepEqual(old.pattern(5.5).lamps, lamps({ green: 'on' }));
    assert.deepEqual(old.pattern(6).lamps, lamps());
    // Arduino のボタンを受け付けた（ACK=1）ことを読める
    assert.equal(parseStatus('OK STATUS FS=0 R=OFF Y=OFF G=ON B=OFF W=OFF BZ=0 BZA=0 LINK=OK ACK=1 ILL=0 EV=ACK_PENDING EC=3 UP=1').ackPending, true);
    assert.equal(parseStatus('OK STATUS FS=0 R=OFF Y=OFF G=OFF B=OFF W=OFF ACK=0 EV=READY EC=1 UP=1').ackPending, false);
});

test('強制停止の状態: 積層灯ページが知らせ、state に載り、古いものは使わない', async () => {
    const db = new FakeD1();
    const device = { row: null };
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
        if (!/patlite_device/u.test(sql)) return original(sql);
        return {
            bind(...args) { this.args = args; return this; },
            async run() { device.row = { full_stop: this.args[0], reported_at: this.args[1] }; return {}; },
            async first() { return device.row; },
        };
    };
    const environment = env(db);
    const post = (body, headers = {}) => new Request('https://dpi-bot.com/site/patlite-admin/api/device', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dpi-bot.com', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await handleAdminCenterRequest(post({ fullStop: true }), environment)).status, 403);
    await withAccess(async (token) => {
        const auth = { 'cf-access-jwt-assertion': token };
        assert.equal((await handleAdminCenterRequest(post({ fullStop: 'yes' }, auth), environment)).status, 400);
        assert.equal((await handleAdminCenterRequest(post({ fullStop: true }, auth), environment)).status, 200);
        assert.equal(device.row.full_stop, 1);
        const state = await (await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/patlite-admin/api/state', { headers: auth }), environment)).json();
        assert.equal(state.device.fullStop, true);
        device.row.reported_at -= 16 * 60;   // 15 分より古い
        const stale = await (await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/patlite-admin/api/state', { headers: auth }), environment)).json();
        assert.equal(stale.device.fullStop, false);
    });
});

test('画面: 色の一覧は段階ごと、絞り込みの操作、操作盤のタイルは 6×3 のまま', async () => {
    const html = await readFile(new URL('../site/patlite-admin/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../site/patlite-admin/script.js', import.meta.url), 'utf8');
    const deckHtml = await readFile(new URL('../site/control-deck/index.html', import.meta.url), 'utf8');
    const deck = await readFile(new URL('../site/control-deck/deck.js', import.meta.url), 'utf8');
    for (const id of ['filter-form', 'filter-level', 'filter-hours', 'filter-clear', 'night-level', 'legend']) assert.match(html, new RegExp(`id="${id}"`, 'u'));
    assert.match(script, /legendByLevel\(\)/u);
    assert.match(script, /engine\.requestAck\(now\)/u);
    assert.match(script, /if \(status\.ackPending\) engine\.dismissRecovered\(\);/u);
    assert.match(script, /DEVICE_API/u);
    assert.match(deck, /legendByLevel\(\)/u);
    assert.match(deckHtml, /id="filter-tile"/u);
    assert.match(deckHtml, /id="filter-dialog"/u);
    assert.match(deckHtml, /id="refresh-tile"/u);            // 「配信統計」の代わりに「今すぐ更新」（2026-11-21）
    assert.doesNotMatch(deckHtml, /delivery-admin/u);
    // 確認（2×2）＋ 14 マス ＝ 6 列 × 3 段
    assert.equal((deckHtml.match(/class="deck-tile/gu) || []).length, 15);
    assert.equal((deckHtml.match(/deck-ack/gu) || []).length, 1);
});

test('メンテナンス中: 灯は点けず、期限までは途絶を出さない。期限を過ぎたら途絶を出し、メンテナンスの表示は消す', () => {
    const t = 1_000_000;
    const maintenance = { id: 'maintenance:window', kind: 'maintenance', title: 'メンテナンス中（1月12日　22時47分まで）', since: t, until: t + 3600 };
    const engine = new PatliteEngine(t);
    engine.update([maintenance], t, 0, t);
    assert.deepEqual(engine.pattern(t + 1).lamps, lamps());
    assert.deepEqual(engine.items(t + 1).map((item) => item.kind), ['maintenance']);
    // 自宅が止まって届かなくなっても、期限までは途絶にしない
    for (const passed of [181, 1800, 3599]) assert.equal(engine.linkLost(t + passed), false, String(passed));
    // 期限を過ぎたら途絶（期限の時刻から点き始める = すぐ点滅する）。メンテナンスの表示は残さない
    assert.equal(engine.linkLost(t + 3601), true);
    assert.deepEqual(engine.items(t + 3601).map((item) => [item.kind, item.since]), [['link_lost', t + 3600]]);
    assert.deepEqual(engine.pattern(t + 3601).lamps, lamps({ blue: 'flash' }));
    // 防災情報はメンテナンス中も点く
    engine.update([maintenance, { id: 'e', kind: 'eew_warning', since: t + 10 }], t + 10, 0, t + 10);
    assert.deepEqual(engine.pattern(t + 12).lamps, lamps({ white: 'flash', red: 'flash' }));
});

test('メンテナンスの期限: この PC の時計のずれを直す・長すぎる期限は信用しない・解除したらすぐ元に戻る', () => {
    const t = 1_000_000;
    const offset = 500;   // この PC の時計が 500 秒進んでいる
    const engine = new PatliteEngine(t + offset);
    engine.update([{ id: 'm', kind: 'maintenance', since: t, until: t + 600 }], t + offset, offset, t + offset);
    assert.equal(engine.linkLost(t + offset + 599), false);
    assert.equal(engine.linkLost(t + offset + 601), true);
    const long = new PatliteEngine(t);
    long.update([{ id: 'm', kind: 'maintenance', since: t, until: t + 24 * 3600 }], t, 0, t);
    assert.equal(long.linkLost(t + 181), true);
    const ended = new PatliteEngine(t);
    ended.update([{ id: 'm', kind: 'maintenance', since: t, until: t + 3600 }], t, 0, t);
    ended.update([], t + 60, 0, t + 60);
    assert.equal(ended.linkLost(t + 60 + 181), true);
    assert.deepEqual([...ended.recovered.keys()], []);   // メンテナンスの終了は「復旧」の緑にしない
});
