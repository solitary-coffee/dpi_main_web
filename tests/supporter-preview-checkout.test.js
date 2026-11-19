import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleSupporterRequest } from '../worker/supporter.js';

const billingEnv = {
 SUPPORTER_BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_x',
 STRIPE_PRICE_SUPPORTER: 'price_basic', STRIPE_PRICE_PLUS: 'price_plus', STRIPE_PRICE_PRO: 'price_pro',
 STRIPE_PRICE_ADDON: 'price_addon', STRIPE_PORTAL_CONFIG: 'bpc_x', SUPPORTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
};
const post = (body, headers = {}) => new Request('https://dpi-bot.com/api/supporter/preview-checkout', {
 method: 'POST', body: JSON.stringify(body),
 headers: {'Content-Type': 'application/json', Origin: 'https://dpi-bot.com', 'Sec-Fetch-Site': 'same-origin', ...headers},
});

test('テスト公開中でなければログイン不要のテスト支払いは存在しない（404）', async () => {
 for (const env of [billingEnv, {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true', SUPPORTER_PUBLIC_ENABLED: 'true'}]) {
  const response = await handleSupporterRequest(post({plan: 'plus'}), env);
  assert.equal(response.status, 404);
 }
});

test('ログインなしで、誰にも紐づかないテストモードの支払いページを作る', async t => {
 const originalFetch = globalThis.fetch;
 t.after(() => { globalThis.fetch = originalFetch; });
 let sent;
 globalThis.fetch = async (url, options) => {
  sent = {url: String(url), params: new URLSearchParams(options.body), headers: options.headers};
  return Response.json({id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1'});
 };
 const response = await handleSupporterRequest(post({plan: 'plus'}), {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true'});
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), {url: 'https://checkout.stripe.com/c/pay/cs_test_1'});
 assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
 assert.equal(sent.params.get('mode'), 'payment');
 assert.equal(sent.params.get('line_items[0][price_data][unit_amount]'), '800');
 assert.equal(sent.params.get('metadata[dpi_checkout_kind]'), 'preview_demo');
 assert.equal(sent.params.get('customer'), null);
 assert.equal(sent.params.get('client_reference_id'), null);
 assert.equal(sent.params.get('metadata[dpi_user]'), null);
 assert.match(sent.params.get('success_url'), /preview_checkout=completed/);
});

test('不正なプラン・本番鍵・GET では作らない', async t => {
 const originalFetch = globalThis.fetch;
 t.after(() => { globalThis.fetch = originalFetch; });
 let calls = 0;
 globalThis.fetch = async () => { calls += 1; return Response.json({url: 'https://checkout.stripe.com/x'}); };
 const env = {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true'};
 assert.equal((await handleSupporterRequest(post({plan: 'gold'}), env)).status, 400);
 assert.equal((await handleSupporterRequest(post({plan: 'plus'}), {...env, STRIPE_SECRET_KEY: 'sk_live_x'})).status, 503);
 assert.equal((await handleSupporterRequest(new Request('https://dpi-bot.com/api/supporter/preview-checkout'), env)).status, 405);
 assert.equal(calls, 0);
});

test('Webhook はテスト支払いの完了を何にも反映しない', async () => {
 const source = await readFile(new URL('../worker/supporter-billing.js', import.meta.url), 'utf8');
 const index = source.indexOf("dpi_checkout_kind==='preview_demo'){");
 assert.ok(index > 0);
 const branch = source.slice(index, source.indexOf('}else if(await rejectDisciplinedCheckout', index));
 assert.doesNotMatch(branch, /db\.|provision|grant|stripe\(/);
});

test('画面にログイン不要のテスト支払いボタンがある', async () => {
 const html = await readFile(new URL('../site/supporter/index.html', import.meta.url), 'utf8');
 assert.match(html, /id="preview-checkout"/);
 for (const plan of ['supporter', 'plus', 'pro']) assert.match(html, new RegExp(`data-preview-plan="${plan}"`));
 assert.match(html, /preview-checkout\.js/);
});
