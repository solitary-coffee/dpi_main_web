import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handlePatliteLamp, lampKeyValid, patliteAdminLampKey, LAMP_KEY_TTL_SECONDS } from '../worker/patlite-admin.js';

class FakeD1 {
    constructor() { this.device = null; this.claimed = []; }
    prepare(sql) {
        const db = this;
        return {
            bind(...args) { this.args = args; return this; },
            async run() {
                if (/INSERT INTO patlite_device/u.test(sql)) db.device = { full_stop: this.args[0], reported_at: this.args[1], reported_by: this.args[2] };
                if (/UPDATE patlite_commands/u.test(sql)) { db.claimed.push(this.args[2]); return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
            },
            async first() {
                if (/patlite_state/u.test(sql)) return { body: JSON.stringify([{ id: 'eew:warning', kind: 'eew_warning', title: '緊急地震速報（警報）' }]), generated_at: 1, received_at: 2 };
                if (/patlite_device/u.test(sql)) return db.device;
                return null;
            },
            async all() { return { results: [] }; },
        };
    }
}

const env = () => ({ PATLITE_BRIDGE_TOKEN: 'bridge-token-for-test', REUSE_DB: new FakeD1() });
const issueRequest = () => new Request('https://dpi-bot.com/site/patlite-admin/api/lamp-key', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://dpi-bot.com' }, body: '{}' });
const lampRequest = (action, key, init = {}) => new Request(`https://dpi-bot.com/api/patlite/lamp/${action}`, { ...init, headers: { ...(init.headers || {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) } });

test('発行した鍵は 400 日有効で、改ざん・期限切れ・別の秘密値では通らない', async () => {
    const e = env();
    const now = 1_800_000_000;
    const issued = await patliteAdminLampKey(issueRequest(), e, { email: 'admin@example.com' }, now);
    assert.equal(issued.expiresAt, now + LAMP_KEY_TTL_SECONDS);
    assert.equal(await lampKeyValid(e, issued.key, now + 86400), true);
    assert.equal(await lampKeyValid(e, issued.key, issued.expiresAt + 1), false);
    assert.equal(await lampKeyValid(e, issued.key.replace(/\.\d+\./u, `.${issued.expiresAt + 999}.`), now), false);
    assert.equal(await lampKeyValid({ PATLITE_BRIDGE_TOKEN: 'other' }, issued.key, now), false);
    assert.equal(await lampKeyValid({ ...e, PATLITE_LAMP_SECRET: 'rotated' }, issued.key, now), false, 'PATLITE_LAMP_SECRET を変えると全部無効');
    assert.equal(await lampKeyValid({}, issued.key, now), false);
    assert.equal(await lampKeyValid(e, e.PATLITE_BRIDGE_TOKEN, now), false, 'ブリッジの合言葉そのものは鍵にならない');
});

test('別サイトからの発行は拒否する', async () => {
    const request = new Request('https://dpi-bot.com/site/patlite-admin/api/lamp-key', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    await assert.rejects(patliteAdminLampKey(request, env(), { email: 'a@example.com' }), /別サイト/u);
});

test('鍵があれば Access の外から状態を読める・無ければ 401', async () => {
    const e = env();
    const { key } = await patliteAdminLampKey(issueRequest(), e, { email: 'admin@example.com' });
    assert.equal(await handlePatliteLamp(new Request('https://dpi-bot.com/api/patlite/ingest'), e), null, '関係ないパスは素通し');
    assert.equal((await handlePatliteLamp(lampRequest('state'), e)).status, 401);
    assert.equal((await handlePatliteLamp(lampRequest('state', 'v1.9999999999.' + '0'.repeat(32) + '.' + 'a'.repeat(64)), e)).status, 401);
    const response = await handlePatliteLamp(lampRequest('state', key), e);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.success, true);
    assert.equal(data.viaLampKey, true);
    assert.equal(data.admin, '');
    assert.equal(data.conditions[0].kind, 'eew_warning');
});

test('鍵でできるのは 状態・強制停止の報告・依頼の実行済み だけ', async () => {
    const e = env();
    const { key } = await patliteAdminLampKey(issueRequest(), e, { email: 'admin@example.com' });
    const post = (action, body) => lampRequest(action, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await handlePatliteLamp(post('device', { fullStop: true }), e)).status, 200);
    assert.equal(e.REUSE_DB.device.full_stop, 1);
    assert.equal(e.REUSE_DB.device.reported_by, 'lamp-key');
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const done = await handlePatliteLamp(post('command-done', { id }), e);
    assert.equal((await done.json()).claimed, true);
    for (const action of ['settings', 'command', 'history', 'lamp-key']) {
        assert.equal((await handlePatliteLamp(post(action, {}), e)).status, 404, action);
    }
    assert.equal((await handlePatliteLamp(lampRequest('state', key, { method: 'POST' }), e)).status, 405);
});

test('ページはログインで読めないときだけ鍵に切り替え、Worker は保守ゲートより前で受ける', async () => {
    const script = await readFile(new URL('../site/patlite-admin/script.js', import.meta.url), 'utf8');
    assert.match(script, /const \{ response, data \} = await lampFetch\(API,/u);
    assert.match(script, /if \(!lamp\.viaKey\) renewLampKey\(\);/u);
    const key = await readFile(new URL('../site/patlite-admin/lamp-key.js', import.meta.url), 'utf8');
    assert.match(key, /credentials: 'omit', headers: \{ \.\.\.\(init\.headers \|\| \{\}\), Authorization: `Bearer \$\{saved\.key\}` \}/u);
    const index = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
    assert.ok(index.indexOf('handlePatliteLamp(request, env)') < index.indexOf("publicMaintenanceGate(request, env, 'main')"));
});
