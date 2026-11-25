import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleSupporterRequest, supporterIntakePaused } from '../worker/supporter.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('準備中の切替は SUPPORTER_INTAKE_PAUSED=true のときだけ有効', () => {
 assert.equal(supporterIntakePaused({SUPPORTER_INTAKE_PAUSED: 'true'}), true);
 assert.equal(supporterIntakePaused({SUPPORTER_INTAKE_PAUSED: ' TRUE '}), true);
 assert.equal(supporterIntakePaused({SUPPORTER_INTAKE_PAUSED: 'false'}), false);
 assert.equal(supporterIntakePaused({}), false);
});

test('準備中はプラン一覧（ログイン不要）に intakePaused を載せる', async () => {
 const request = new Request('https://dpi-bot.com/api/supporter/plans');
 const paused = await handleSupporterRequest(request, {SUPPORTER_PREVIEW_OPEN: 'true', SUPPORTER_INTAKE_PAUSED: 'true'});
 assert.equal(paused.status, 200);
 assert.equal((await paused.json()).intakePaused, true);
 const open = await handleSupporterRequest(request, {SUPPORTER_PREVIEW_OPEN: 'true'});
 assert.equal((await open.json()).intakePaused, false);
});

test('準備中の拒否は、ログイン確認の後・申込み／支払い／設定保存の処理より前にある', async () => {
 const source = await read('../worker/supporter.js');
 const gate = source.indexOf("if (request.method !== 'GET' && supporterIntakePaused(env) && !pausedPortal) return response({message:SUPPORTER_INTAKE_PAUSED_MESSAGE,intakePaused:true},503);");
 assert.ok(gate > 0);
 assert.ok(source.indexOf('session = await requireSession(request') < gate, 'ログイン（セッション確認）は通す');
 for (const marker of ['(checkout|topup|preview-update|update|portal|status)', "path === '/api/supporter/account' && request.method === 'POST'", "path === '/api/supporter/settings' && request.method === 'PUT'"]) {
  assert.ok(source.indexOf(marker) > gate, marker);
 }
});

test('画面は、受付停止の案内とボタンの無効化を持つ', async () => {
 const html = await read('../site/supporter/index.html');
 assert.match(html, /id="intake-paused-notice" class="intake-paused-notice hidden"/);
 const app = await read('../site/supporter/app.js');
 assert.match(app, /applyIntakePaused\(intakePaused\)/);
 assert.match(await read('../site/supporter/style.css'), /body\.intake-paused main button:not\(#reload\)/);
});
