import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutConsumed } from '../worker/supporter-billing.js';
import { readJson } from '../worker/reuse.js';
import { publicMaintenanceGate } from '../worker/maintenance.js';

test('解約済みの契約がある初回決済は使用済みとみなし、契約を作り直さない', () => {
    const session = { id: 'cs_1', created: 1000 };
    assert.equal(checkoutConsumed([], session), false);
    assert.equal(checkoutConsumed([{ status: 'canceled', created: 1200, metadata: {} }], session), true);
    assert.equal(checkoutConsumed([{ status: 'canceled', created: 900, metadata: { dpi_initial_session: 'cs_1' } }], session), true);
    assert.equal(checkoutConsumed([{ status: 'canceled', created: 900, metadata: {} }], session), false);
});

test('JSON の null・配列は 400 にする（503 にしない）', async () => {
    const req = body => new Request('https://example.com/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await assert.rejects(readJson(req('null')), error => error.status === 400);
    await assert.rejects(readJson(req('[1]')), error => error.status === 400);
    assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
    const big = JSON.stringify({ rules: 'x'.repeat(40 * 1024) });
    await assert.rejects(readJson(req(big)), error => error.status === 413);
    assert.equal((await readJson(req(big), 1024 * 1024)).rules.length, 40 * 1024);
});

test('メンテナンス中でも管理画面は通す', async () => {
    const env = { DPI_MAINTENANCE_KV: { get: async () => ({ enabled: true, message: 'm' }) } };
    assert.equal(await publicMaintenanceGate(new Request('https://dpi-bot.com/site/status-admin/'), env, 'main'), null);
    assert.equal(await publicMaintenanceGate(new Request('https://dpi-bot.com/site/admin-center/'), env, 'main'), null);
    assert.equal((await publicMaintenanceGate(new Request('https://dpi-bot.com/site/supporter/'), env, 'main')).status, 503);
});
