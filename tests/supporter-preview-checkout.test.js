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

test('ログインなしのクレジットチャージは指定金額のテスト決済を作り、範囲外は断る', async t => {
 const originalFetch = globalThis.fetch;
 t.after(() => { globalThis.fetch = originalFetch; });
 const sent = [];
 globalThis.fetch = async (url, options) => { sent.push(new URLSearchParams(options.body)); return Response.json({url: 'https://checkout.stripe.com/c/pay/cs_test_2'}); };
 const env = {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true'};
 const ok = await handleSupporterRequest(post({plan: 'credit', amount: 3000}), env);
 assert.equal(ok.status, 200);
 assert.equal(sent[0].get('line_items[0][price_data][unit_amount]'), '3000');
 assert.equal(sent[0].get('metadata[dpi_checkout_kind]'), 'preview_demo');
 assert.equal(sent[0].get('metadata[dpi_user]'), null);
 assert.equal(sent[0].get('customer'), null);
 for (const amount of [499, 100001, 1000.5, 'abc']) {
  assert.equal((await handleSupporterRequest(post({plan: 'credit', amount}), env)).status, 400);
 }
 assert.equal(sent.length, 1);
});

test('プランの支払いページでは PayPay を除外し、クレジットチャージでは除外しない', async t => {
 const originalFetch = globalThis.fetch;
 t.after(() => { globalThis.fetch = originalFetch; });
 const sent = [];
 globalThis.fetch = async (url, options) => { sent.push(new URLSearchParams(options.body)); return Response.json({url: 'https://checkout.stripe.com/c/pay/cs_test_3'}); };
 const env = {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true'};
 await handleSupporterRequest(post({plan: 'pro'}), env);
 await handleSupporterRequest(post({plan: 'credit', amount: 1000}), env);
 assert.equal(sent[0].get('excluded_payment_method_types[0]'), 'paypay');
 assert.equal(sent[1].get('excluded_payment_method_types[0]'), null);
 const source = await readFile(new URL('../worker/supporter-billing.js', import.meta.url), 'utf8');
 // 通常の申込み・カスタムプランの初回・カスタムプランの差額も除外する
 assert.equal((source.match(/\.\.\.SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS/g) || []).length, 3);
});

test('テスト支払いの結果（チャージ額・プラン・支払い方法）を返し、ほかの支払いの情報は返さない', async t => {
 const originalFetch = globalThis.fetch;
 t.after(() => { globalThis.fetch = originalFetch; });
 const sessions = {
  cs_test_credit00001: {status: 'complete', payment_status: 'paid', amount_total: 3000, metadata: {dpi_checkout_kind: 'preview_demo', dpi_preview_credit_amount: '3000'}, payment_intent: {payment_method: {type: 'paypay'}}},
  cs_test_plan0000001: {status: 'complete', payment_status: 'paid', amount_total: 800, metadata: {dpi_checkout_kind: 'preview_demo', dpi_plan: 'plus'}, payment_intent: {payment_method: {type: 'card'}}},
  cs_test_realuser001: {status: 'complete', payment_status: 'paid', amount_total: 800, metadata: {dpi_checkout_kind: 'initial_subscription', dpi_user: '637850681666961408'}},
 };
 let lastUrl = '';
 globalThis.fetch = async url => { lastUrl = String(url); const id = lastUrl.split('/checkout/sessions/')[1].split('?')[0]; return Response.json(sessions[id]); };
 const env = {...billingEnv, SUPPORTER_PREVIEW_OPEN: 'true'};
 const get = id => handleSupporterRequest(new Request(`https://dpi-bot.com/api/supporter/preview-checkout/result?session_id=${id}`), env);
 assert.deepEqual(await (await get('cs_test_credit00001')).json(), {kind: 'credit', completed: true, amount: 3000, planName: null, paymentMethod: 'PayPay'});
 assert.match(lastUrl, /expand%5B%5D=payment_intent\.payment_method|expand\[\]=payment_intent\.payment_method/);
 assert.deepEqual(await (await get('cs_test_plan0000001')).json(), {kind: 'plan', completed: true, amount: 800, planName: 'Plus', paymentMethod: 'カード'});
 const other = await get('cs_test_realuser001');
 assert.equal(other.status, 404);
 assert.doesNotMatch(await other.text(), /637850681666961408/);
 assert.equal((await get('cs_live_abc')).status, 400);
});
