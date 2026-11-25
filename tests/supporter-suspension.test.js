// 未払い・一時停止の停止と再開、月末の再決済、カード変更、解約専用画面、本番モードの判定（実際の SQL で確かめる）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { adminBillingAction, autoCancelAt, billingAction, billingMode, billingWebhook, customerInvoices, dunningSchedule, releaseDisputeHolds, runSupporterBillingSchedule, subscriptionSummary } from '../worker/supporter-billing.js';
import { assertSupporterRate, handleSupporterRequest } from '../worker/supporter.js';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';
import { subscriptionSummariesByCustomer } from '../worker/supporter-billing.js';

const UID = '123456789012345678', CUSTOMER = 'cus_x', GUILD = '12345678901234567', CHANNEL = '98765432109876543';
const jst = text => Math.floor(Date.parse(`${text}+09:00`) / 1000);
const SUSPEND = jst('2026-12-01T00:00:00');

async function database(t) {
 let DatabaseSync;
 try { ({DatabaseSync} = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available'); return null; }
 const raw = new DatabaseSync(':memory:');
 const dir = new URL('../migrations/', import.meta.url);
 for (const name of (await readdir(dir)).filter(item => item.endsWith('.sql')).sort()) raw.exec(await readFile(new URL(name, dir), 'utf8'));
 const statement = (sql, values = []) => ({
  bind(...input) { return statement(sql, input); },
  async first() { return raw.prepare(sql).get(...values) ?? null; },
  async all() { return {results: raw.prepare(sql).all(...values)}; },
  async run() { return {meta: {changes: Number(raw.prepare(sql).run(...values).changes)}}; },
 });
 raw.prepare(`INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at,settings_json) VALUES(?,?,?,?,?)`)
  .run(UID, 'user@example.jp', '2026-01-01', '2026-01-01', JSON.stringify({rules: [{name: 'R1', guildId: GUILD, channelId: CHANNEL, channelIds: [CHANNEL], type: 'earthquake', detail: 'all', region: 'all'}]}));
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID, CUSTOMER);
 return {raw, db: {prepare: sql => statement(sql), async batch(list) { const out = []; for (const item of list) out.push(await item.run()); return out; }},
  dunning: id => raw.prepare('SELECT * FROM supporter_dunning WHERE invoice_id=?').get(id)};
}
function envFor(db, mode = 'test') {
 return {SUPPORTER_BILLING_MODE: mode, STRIPE_SECRET_KEY: `rk_${mode}_example`, STRIPE_WEBHOOK_SECRET: 'whsec_example', STRIPE_PRICE_SUPPORTER: 'price_basic', STRIPE_PRICE_PLUS: 'price_plus',
  STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ADDON: 'price_addon', STRIPE_PORTAL_CONFIG: 'bpc_x', SUPPORTER_PUBLIC_ORIGIN: 'https://dpi-bot.com', SUPPORTER_PUBLIC_ENABLED: 'true', REUSE_DB: db,
  NOTICE_FROM_EMAIL: 'notice@dpi-bot.com', NOTICE_EMAIL: {async send() {}}};
}
function subscription(extra = {}) {
 return {id: 'sub_x', status: 'active', customer: CUSTOMER, livemode: false, metadata: {}, items: {data: [{id: 'si', quantity: 1, current_period_start: 1, current_period_end: 4e9, price: {id: 'price_basic', unit_amount: 300, currency: 'jpy', recurring: {interval: 'month'}}}]}, ...extra};
}
// Stripe の代わり。routes は '<METHOD> <path>' → 値 または 関数。
function stripeMock(t, routes) {
 const calls = [], original = globalThis.fetch;
 t.after(() => { globalThis.fetch = original; });
 globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url), method = init.method || 'GET', path = target.pathname.replace('/v1/', '');
  const params = Object.fromEntries(new URLSearchParams(init.body || ''));
  calls.push({method, path, params, key: init.headers?.['Idempotency-Key'] || ''});
  const route = routes[`${method} ${path}`];
  let value = typeof route === 'function' ? route(params) : route;
  if (value === undefined) value = {livemode: false, data: []};
  if (value.httpStatus) return Response.json(value.body, {status: value.httpStatus});
  return Response.json(value);
 };
 return calls;
}
function insertDunning(raw, id, status, extra = {}) {
 const row = {retry_at: jst('2026-11-30T12:00:00'), suspend_at: SUSPEND, retry_attempted_at: null, suspended_at: null, ...extra};
 raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,retry_attempted_at,suspend_at,suspended_at,updated_at)
  VALUES(?,?,'sub_x',300,'jpy',?,1,?,?,?,?,?)`).run(id, CUSTOMER, status, row.retry_at, row.retry_attempted_at, row.suspend_at, row.suspended_at, row.updated_at ?? 1);
}
const delivered = async (env, db, at = jst('2026-11-27T12:00:00')) => (await buildSupporterSnapshot(db, env, subscriptionSummariesByCustomer, at * 1000)).rules.length;
async function webhook(env, type, object, extra = {}) {
 const raw = JSON.stringify({id: extra.id || `evt_${type}_${Math.random()}`, type, livemode: env.SUPPORTER_BILLING_MODE === 'live', created: 1_800_000_000, data: {object, ...extra.data}, ...extra.event});
 const ts = Math.floor(Date.now() / 1000), sig = createHmac('sha256', 'whsec_example').update(`${ts}.${raw}`).digest('hex');
 return billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook', {method: 'POST', body: raw, headers: {'stripe-signature': `t=${ts},v1=${sig}`}}), env);
}

test('停止は翌月1日0時ちょうど。0時より前は配信を続け、0時の定期処理で止まる', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 assert.equal(dunningSchedule(jst('2026-11-26T00:00:00')).suspendAt, SUSPEND);
 insertDunning(store.raw, 'in_1', 'suspend_scheduled', {retry_attempted_at: 1});
 stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open'}});
 await runSupporterBillingSchedule(env, (SUSPEND - 1) * 1000);
 assert.equal(store.dunning('in_1').status, 'suspend_scheduled');
 assert.equal(await delivered(env, store.db), 1);
 const result = await runSupporterBillingSchedule(env, SUSPEND * 1000);
 assert.equal(result.suspended, 1);
 assert.equal(store.dunning('in_1').status, 'suspended');
 assert.equal(await delivered(env, store.db), 0);
});

test('月末の再決済がStripeの障害で終わらなくても、翌月1日0時には止まる。再試行は別の冪等キー', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'retry_scheduled');
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open'},
  'POST invoices/in_1/pay': {httpStatus: 500, body: {error: {message: 'server'}}}});
 await runSupporterBillingSchedule(env, jst('2026-11-30T12:00:00') * 1000);
 assert.equal(store.dunning('in_1').status, 'retry_scheduled');
 await runSupporterBillingSchedule(env, SUSPEND * 1000);
 assert.equal(store.dunning('in_1').status, 'suspended');
 const keys = calls.filter(call => call.path === 'invoices/in_1/pay').map(call => call.key);
 assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 2);
});

test('月末の再決済の前に支払い済みなら、もう一度請求しない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'retry_scheduled');
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription()]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'paid', customer: CUSTOMER, subscription: 'sub_x'}});
 const result = await runSupporterBillingSchedule(env, jst('2026-11-30T12:00:00') * 1000);
 assert.equal(result.paid, 1); assert.equal(store.dunning('in_1').status, 'paid');
 assert.equal(calls.some(call => call.path.endsWith('/pay')), false);
});

test('再決済の途中で処理が落ちた行は、次の定期処理で再開する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), at = jst('2026-11-30T12:00:00');
 insertDunning(store.raw, 'in_1', 'retrying', {retry_attempted_at: at - 7200, updated_at: at - 7200});
 stripeMock(t, {'GET subscriptions': {data: [subscription()]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open'},
  'POST invoices/in_1/pay': {livemode: false, id: 'in_1', status: 'paid', customer: CUSTOMER, subscription: 'sub_x'}});
 await runSupporterBillingSchedule(env, at * 1000);
 assert.equal(store.dunning('in_1').status, 'paid');
});

test('請求が2通あるときは、両方の支払いを確認するまで再開しない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_old', 'suspended', {retry_attempted_at: 1, suspended_at: 1});
 insertDunning(store.raw, 'in_new', 'retry_scheduled', {retry_at: jst('2026-12-31T12:00:00'), suspend_at: jst('2027-01-01T00:00:00')});
 stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}});
 assert.equal((await webhook(env, 'invoice.paid', {id: 'in_old', customer: CUSTOMER, subscription: 'sub_x'})).status, 200);
 assert.equal(store.dunning('in_old').status, 'paid');
 assert.equal(store.dunning('in_new').status, 'suspended');
 assert.equal(await delivered(env, store.db), 0);
 await webhook(env, 'invoice.paid', {id: 'in_new', customer: CUSTOMER, subscription: 'sub_x'});
 assert.equal(await delivered(env, store.db), 1);
});

test('先に停止扱いになった請求書も、本来の月末に1回だけ再決済し、失敗しても停止のまま', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), at = jst('2026-12-31T12:00:00');
 insertDunning(store.raw, 'in_new', 'suspended', {retry_at: at, suspend_at: jst('2027-01-01T00:00:00'), suspended_at: jst('2026-12-27T00:00:00')});
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'GET invoices/in_new': {livemode: false, id: 'in_new', status: 'open'},
  'POST invoices/in_new/pay': {httpStatus: 402, body: {error: {code: 'card_declined', message: 'declined'}}}});
 for (const time of [at - 3600, at, at + 43200]) await runSupporterBillingSchedule(env, time * 1000);
 assert.equal(calls.filter(call => call.path.endsWith('/pay')).length, 1);
 assert.equal(store.dunning('in_new').status, 'suspended');
});

test('停止中・支払い済みの請求書への失敗通知では、状態を戻さない。月末前の手動の失敗でも再決済の予約は残る', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 const failed = id => ({id, customer: CUSTOMER, subscription: 'sub_x', billing_reason: 'subscription_cycle', attempt_count: 3, created: jst('2026-11-26T00:00:00')});
 insertDunning(store.raw, 'in_stop', 'suspended', {retry_attempted_at: 1});
 insertDunning(store.raw, 'in_paid', 'paid', {retry_attempted_at: 1});
 insertDunning(store.raw, 'in_wait', 'retry_scheduled');
 stripeMock(t, {});
 for (const id of ['in_stop', 'in_paid', 'in_wait']) assert.equal((await webhook(env, 'invoice.payment_failed', failed(id))).status, 200);
 assert.deepEqual(['in_stop', 'in_paid', 'in_wait'].map(id => store.dunning(id).status), ['suspended', 'paid', 'retry_scheduled']);
});

test('支払い完了の通知を取りこぼしても、定期処理でStripeと照合して再開する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 stripeMock(t, {'GET subscriptions': {data: [subscription()]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'paid', customer: CUSTOMER, subscription: 'sub_x'}});
 assert.equal(await delivered(env, store.db), 0);
 await runSupporterBillingSchedule(env, (SUSPEND + 43200) * 1000);
 assert.equal(store.dunning('in_1').status, 'paid');
 assert.equal(await delivered(env, store.db), 1);
});

for (const [label, state] of [['unpaid', {status: 'unpaid'}], ['paused', {status: 'paused'}], ['支払いの一時停止', {pause_collection: {behavior: 'void'}}]]) {
 test(`請求書の督促が無い${label}も、翌月1日0時に止まり、解除を確認したら再開する`, async t => {
  const store = await database(t); if (!store) return;
  const env = envFor(store.db);
  let current = subscription(state);
  stripeMock(t, {'GET subscriptions': () => ({data: [current]}), 'GET invoices': () => ({data: current.status === 'unpaid' ? [{id: 'in_open'}] : []})});
  await runSupporterBillingSchedule(env, jst('2026-11-27T12:00:00') * 1000);
  assert.equal(store.dunning('hold:sub_x').suspend_at, SUSPEND);
  assert.equal(await delivered(env, store.db), 1);
  await runSupporterBillingSchedule(env, SUSPEND * 1000);
  assert.equal(await delivered(env, store.db), 0);
  // 停止したまま月をまたいでも停止時刻は動かない
  await runSupporterBillingSchedule(env, jst('2026-12-20T12:00:00') * 1000);
  assert.equal(store.dunning('hold:sub_x').suspend_at, SUSPEND);
  current = subscription();
  await webhook(env, 'customer.subscription.updated', current);
  assert.equal(store.dunning('hold:sub_x').status, 'closed');
  assert.equal(await delivered(env, store.db), 1);
 });
}

test('月末の定期処理の後に起きた一時停止も、1か月ずれずに翌月1日0時に止まる（Webhook・定期処理のどちらで見つけても）', async t => {
 for (const viaWebhook of [true, false]) {
  const store = await database(t); if (!store) return;
  const env = envFor(store.db);
  let current = subscription();
  stripeMock(t, {'GET subscriptions': () => ({data: [current]})});
  await runSupporterBillingSchedule(env, jst('2026-11-30T12:00:00') * 1000);
  current = subscription({status: 'paused'});
  if (viaWebhook) {
   await webhook(env, 'customer.subscription.updated', current, {event: {created: jst('2026-11-30T18:00:00')}});
   assert.equal(store.dunning('hold:sub_x').suspend_at, SUSPEND);
  }
  await runSupporterBillingSchedule(env, (SUSPEND + 1) * 1000);
  assert.equal(await delivered(env, store.db), 0);
 }
});

test('定期処理が動かなくても、配信設定は翌月1日0時を過ぎた未払いを含めない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspend_scheduled', {retry_attempted_at: 1});
 stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}});
 assert.equal(await delivered(env, store.db, SUSPEND - 1), 1);
 assert.equal(await delivered(env, store.db, SUSPEND), 0);
});

test('月末の再決済と停止は、対象が多くても1回で全件を処理する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 for (let index = 0; index < 120; index += 1) insertDunning(store.raw, `in_${index}`, 'retry_scheduled');
 for (let index = 0; index < 600; index += 1) insertDunning(store.raw, `stop_${index}`, 'suspend_scheduled', {retry_attempted_at: 1});
 stripeMock(t, Object.fromEntries(Array.from({length: 120}, (_, index) => [`GET invoices/in_${index}`, {livemode: false, id: `in_${index}`, status: 'paid', customer: CUSTOMER, subscription: 'sub_x'}])));
 assert.equal((await runSupporterBillingSchedule(env, jst('2026-11-30T12:00:00') * 1000)).paid, 120);
 assert.equal((await runSupporterBillingSchedule(env, SUSPEND * 1000)).suspended, 600);
});

test('クレジット失効は1人の失敗で止まらない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 store.raw.prepare('INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES(?,?,?,?)').run('223456789012345678', 'b@example.jp', '2026-01-01', '2026-01-01');
 store.raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run('223456789012345678', 'cus_ok');
 const add = (id, uid, source) => store.raw.prepare(`INSERT INTO supporter_credit_lots(id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at) VALUES(?,?,'purchase',?,500,500,1,'active',1,1)`).run(id, uid, source);
 add('a-broken', UID, 'cs_a'); add('b-ok', '223456789012345678', 'cs_b');
 stripeMock(t, {'GET customers/cus_x': {httpStatus: 404, body: {error: {code: 'resource_missing', message: 'No such customer'}}}, 'GET customers/cus_ok': {livemode: false, balance: -500},
  'POST customers/cus_ok/balance_transactions': {livemode: false, id: 'cbtxn', ending_balance: 0}});
 const result = await runSupporterBillingSchedule(env, jst('2026-11-27T12:00:00') * 1000);
 assert.equal(result.expiredCredits, 1);
 assert.equal(store.raw.prepare("SELECT status FROM supporter_credit_lots WHERE id='a-broken'").get().status, 'active');
});

test('契約管理画面のカード変更は、契約と予約変更のカードにも反映する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 const calls = stripeMock(t, {'GET customers/cus_x': {livemode: false, id: CUSTOMER, invoice_settings: {default_payment_method: 'pm_new'}}, 'GET subscriptions': {data: [subscription({default_payment_method: 'pm_old', schedule: 'sub_sched_x'})]},
  'POST subscriptions/sub_x': {livemode: false}, 'POST subscription_schedules/sub_sched_x': {livemode: false}});
 await webhook(env, 'customer.updated', {id: CUSTOMER, email: 'user@example.jp'}, {data: {previous_attributes: {email: 'old@example.jp'}}});
 assert.equal(calls.some(call => call.method === 'POST'), false, 'カード以外の変更では何もしない');
 await webhook(env, 'customer.updated', {id: CUSTOMER, email: 'user@example.jp'}, {data: {previous_attributes: {invoice_settings: {default_payment_method: null}}}});
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x' && call.method === 'POST').params.default_payment_method, 'pm_new');
 assert.equal(calls.find(call => call.path === 'subscription_schedules/sub_sched_x').params['default_settings[default_payment_method]'], 'pm_new');
});

function activeCustom(raw) {
 const columns = raw.prepare('PRAGMA table_info(supporter_custom_plans)').all();
 const values = {discord_user_id: UID, id: 'custom-one', name: 'カスタム', status: 'active', revision: 1, stripe_subscription_id: 'sub_x', confirmed_yen: 1000, estimated_yen: 1000, channel_limit: 10, server_limit: 3, rule_limit: 10};
 const used = columns.filter(column => column.name in values || (column.notnull && column.dflt_value === null));
 raw.prepare(`INSERT INTO supporter_custom_plans(${used.map(column => column.name).join(',')}) VALUES(${used.map(() => '?').join(',')})`)
  .run(...used.map(column => values[column.name] ?? (/INT/i.test(column.type) ? 0 : '2026-01-01')));
}
const customSubscription = extra => subscription({metadata: {dpi_user: UID, dpi_custom_id: 'custom-one', dpi_custom_revision: '1'}, items: {data: [{id: 'si', quantity: 1, current_period_start: 1, current_period_end: 4e9, price: {id: 'price_custom', unit_amount: 1000, currency: 'jpy'}}]}, ...extra});

test('カスタムは解約専用の画面だけを開ける。ほかの変更は拒否する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 activeCustom(store.raw);
 let current = customSubscription();
 const calls = stripeMock(t, {'GET subscriptions/sub_x': () => current, 'POST billing_portal/sessions': {livemode: false, url: 'https://billing.stripe.com/p/session/x'}});
 const act = action => billingAction(new Request(`https://dpi-bot.com/api/supporter/billing/${action}`), env, store.db, UID, {plan: 'plus'});
 assert.equal((await act('portal')).status, 200);
 const portal = calls.find(call => call.path === 'billing_portal/sessions').params;
 assert.equal(portal['flow_data[type]'], 'subscription_cancel');
 assert.equal(portal['flow_data[subscription_cancel][subscription]'], 'sub_x');
 for (const action of ['checkout', 'update', 'preview-update']) assert.equal((await act(action)).status, 403);
 current = customSubscription({cancel_at: 4e9});
 assert.equal((await act('portal')).status, 409, '解約予約済み');
 current = customSubscription({customer: 'cus_other'});
 assert.equal((await act('portal')).status, 409, '別の顧客の契約');
 store.raw.prepare("UPDATE supporter_custom_plans SET status='offered'").run();
 assert.equal((await act('portal')).status, 409, '契約前');
});

test('カスタムも未払いの間は翌月1日0時まで配信を続ける', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 activeCustom(store.raw);
 insertDunning(store.raw, 'in_1', 'suspend_scheduled', {retry_attempted_at: 1});
 stripeMock(t, {'GET subscriptions': {data: [customSubscription({status: 'past_due'})]}, 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open'}});
 assert.equal(await delivered(env, store.db), 1);
 await runSupporterBillingSchedule(env, SUSPEND * 1000);
 assert.equal(await delivered(env, store.db), 0);
});

test('初回利用料を明細に出し、管理画面から返金できる', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 const session = (id, created, refunded, kind = 'initial_subscription') => ({id, mode: 'payment', status: 'complete', payment_status: 'paid', created, amount_total: 800, currency: 'jpy', metadata: {dpi_checkout_kind: kind},
  payment_intent: {id: `pi_${id}`, latest_charge: {created, amount: 800, amount_refunded: refunded, receipt_url: 'https://pay.stripe.com/receipts/x'}}});
 const calls = stripeMock(t, {'GET invoices': {data: []}, 'GET checkout/sessions': {data: [session('topup', 300, 0, 'credit_topup'), session('new', 200, 800), session('old', 100, 0)]}, 'POST refunds': {livemode: false, status: 'succeeded', amount: 800, currency: 'jpy'}});
 const invoices = await customerInvoices(env, CUSTOMER);
 assert.deepEqual(invoices.map(item => [item.label, item.status, item.receiptUrl]), [['初回利用料', 'refunded', 'https://pay.stripe.com/receipts/x'], ['初回利用料', 'paid', 'https://pay.stripe.com/receipts/x']]);
 await adminBillingAction(env, CUSTOMER, UID, {action: 'refund_latest', amount: 800, requestId: '00000000-0000-4000-8000-000000000001', reason: '二重請求のため返金'});
 assert.equal(calls.find(call => call.path === 'refunds').params.payment_intent, 'pi_old', '返金済みの分・チャージ分は対象にしない');
});

test('返金・支払異議・不正の警告を記録する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 stripeMock(t, {'GET charges/ch_x': {livemode: false, id: 'ch_x', customer: CUSTOMER, payment_intent: 'pi_x'}});
 await webhook(env, 'radar.early_fraud_warning.created', {id: 'issfr_x', charge: 'ch_x'}, {id: 'evt_fraud'});
 await webhook(env, 'charge.dispute.closed', {id: 'dp_x', charge: 'ch_x', status: 'won', amount: 300}, {id: 'evt_closed'});
 await webhook(env, 'charge.dispute.closed', {id: 'dp_x', charge: 'ch_x', status: 'won', amount: 300}, {id: 'evt_closed'});
 const rows = store.raw.prepare('SELECT kind,outcome,discord_user_id,amount FROM supporter_payment_alerts ORDER BY kind').all().map(row => ({...row}));
 assert.deepEqual(rows, [{kind: 'dispute_closed', outcome: 'won', discord_user_id: UID, amount: 300}, {kind: 'fraud_warning', outcome: '', discord_user_id: UID, amount: 0}]);
});

test('テストと本番の食い違いは、応答・Webhookとも拒否する', async t => {
 const store = await database(t); if (!store) return;
 const live = envFor(store.db, 'live'), testEnv = envFor(store.db);
 assert.equal(billingMode(live), 'live'); assert.equal(billingMode(testEnv), 'test');
 assert.equal(billingMode({...live, STRIPE_SECRET_KEY: 'sk_test_x'}), '');
 stripeMock(t, {'GET invoices': {livemode: false, data: []}});
 await assert.rejects(() => customerInvoices(live, CUSTOMER), error => error.status === 503);
 for (const [env, livemode] of [[live, false], [testEnv, true]]) assert.equal((await webhook(env, 'invoice.paid', {id: 'in_x'}, {event: {livemode}})).status, 400);
});

test('期間末解約は cancel_at の予約も表示する', () => {
 assert.equal(subscriptionSummary(subscription({cancel_at: 4e9}), {}).cancelAtPeriodEnd, true);
 assert.equal(subscriptionSummary(subscription({cancel_at: null}), {}).cancelAtPeriodEnd, false);
});

test('プラン一覧は決済モードを返し、申込みの連続作成は429で止める', async () => {
 const env = {...envFor(null), SUPPORTER_PUBLIC_ENABLED: '', SUPPORTER_PREVIEW_OPEN: 'true'};
 const plans = await (await handleSupporterRequest(new Request('https://dpi-bot.com/api/supporter/plans'), env)).json();
 assert.deepEqual([plans.mode, plans.previewOpen, plans.deliveryEnabled], ['test', true, false]);
 const keys = [];
 await assert.rejects(() => assertSupporterRate({SUPPORTER_RATE_LIMITER: {limit: async ({key}) => { keys.push(key); return {success: false}; }}}, 'billing:1'), error => error.status === 429);
 assert.deepEqual(keys, ['billing:1']);
 await assertSupporterRate({SUPPORTER_RATE_LIMITER: {limit: async () => { throw new Error('down'); }}}, 'billing:1');
 await assertSupporterRate({}, 'billing:1');
});

test('停止中は新しい請求を止め、支払いを確認したら請求も再開する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspend_scheduled', {retry_attempted_at: 1});
 let current = subscription({status: 'past_due'});
 const calls = stripeMock(t, {'GET subscriptions': () => ({data: [current]}), 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open'}, 'POST subscriptions/sub_x': {livemode: false}});
 await runSupporterBillingSchedule(env, SUSPEND * 1000);
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x').params['pause_collection[behavior]'], 'void');
 // 当方が付けた一時停止は、利用者の一時停止（hold）として扱わない
 current = subscription({pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}});
 calls.length = 0;
 await runSupporterBillingSchedule(env, (SUSPEND + 43200) * 1000);
 assert.equal(store.dunning('hold:sub_x'), undefined);
 assert.equal(calls.some(call => call.path === 'subscriptions/sub_x'), false, '停止中は付け外しを繰り返さない');
 assert.equal(await delivered(env, store.db), 0);
 await webhook(env, 'invoice.paid', {id: 'in_1', customer: CUSTOMER, subscription: 'sub_x'});
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x').params.pause_collection, '');
 assert.equal(await delivered(env, store.db), 1);
});

test('停止から1か月後の1日0時に自動解約し、未払いの請求を取り消す', async t => {
 assert.equal(autoCancelAt(SUSPEND), jst('2027-01-01T00:00:00'));
 assert.equal(autoCancelAt(jst('2027-02-01T00:00:00')), jst('2027-03-01T00:00:00'));
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND + 5});
 const open = {livemode: false, id: 'in_1', status: 'open', customer: CUSTOMER, subscription: 'sub_x', amount_due: 300, currency: 'jpy'};
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due', pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}})]}, 'GET invoices/in_1': open, 'GET subscriptions/sub_x': subscription({status: 'past_due'}),
  'DELETE subscriptions/sub_x': {livemode: false, status: 'canceled'}, 'POST subscriptions/sub_x': {livemode: false}, 'POST invoices/in_1/void': {livemode: false, status: 'void'}});
 assert.equal((await runSupporterBillingSchedule(env, jst('2026-12-31T12:00:00') * 1000)).autoCanceled, 0);
 assert.equal(calls.some(call => call.method === 'DELETE'), false);
 assert.equal((await runSupporterBillingSchedule(env, jst('2027-01-01T00:00:00') * 1000)).autoCanceled, 1);
 assert.deepEqual(calls.filter(call => call.method === 'DELETE' || call.path.endsWith('/void')).map(call => call.path), ['invoices/in_1/void', 'subscriptions/sub_x']);
 assert.equal(store.dunning('in_1').status, 'closed');
});

test('自動解約は、支払い済み・別の顧客や契約・停止して間もないものを対象にしない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), at = jst('2027-02-01T00:00:00');
 insertDunning(store.raw, 'in_paid', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 insertDunning(store.raw, 'in_other', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 insertDunning(store.raw, 'in_recent', 'suspended', {retry_attempted_at: 1, suspended_at: at - 86400, suspend_at: at - 86400});
 insertDunning(store.raw, 'hold:sub_x', 'suspended', {suspended_at: SUSPEND});
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'GET subscriptions/sub_x': subscription({status: 'past_due'}), 'POST subscriptions/sub_x': {livemode: false},
  'GET invoices/in_paid': {livemode: false, id: 'in_paid', status: 'paid', customer: CUSTOMER, subscription: 'sub_x'}, 'GET invoices/in_other': {livemode: false, id: 'in_other', status: 'open', customer: 'cus_other', subscription: 'sub_x'},
  'GET invoices/in_recent': {livemode: false, id: 'in_recent', status: 'open', customer: CUSTOMER, subscription: 'sub_x'}});
 assert.equal((await runSupporterBillingSchedule(env, at * 1000)).autoCanceled, 0);
 assert.equal(calls.some(call => call.method === 'DELETE' || call.path.endsWith('/void')), false);
});

test('受付人数の上限に達したら、新しい申込みと未契約者のチャージを止める（契約者は止めない）', async t => {
 const store = await database(t); if (!store) return;
 const env = {...envFor(store.db), SUPPORTER_SUBSCRIBER_LIMIT: '1'};
 let own = [];
 stripeMock(t, {'GET subscriptions': () => ({data: own.length ? own : []}), 'GET checkout/sessions': {data: []}, 'POST customers/cus_x': {livemode: false, id: CUSTOMER},
  'POST checkout/sessions': () => ({livemode: false, id: `cs_test_${crypto.randomUUID()}`, status: 'open', url: 'https://checkout.stripe.com/c/pay/x'})});
 const act = (action, extra = {}) => billingAction(new Request(`https://dpi-bot.com/api/supporter/billing/${action}`), {...env, ...extra}, store.db, UID, {plan: 'plus', amount: 500, requestId: crypto.randomUUID(), legalConsentVersion: 'v'});
 const original = globalThis.fetch;
 // 一覧（全顧客）は別の契約者 1 人、本人の一覧は own
 globalThis.fetch = async (url, init) => new URL(url).pathname === '/v1/subscriptions' && !new URL(url).searchParams.get('customer') ? Response.json({data: [subscription({customer: 'cus_full'})]}) : original(url, init);
 for (const action of ['checkout', 'topup']) { const response = await act(action); assert.equal(response.status, 409); assert.match((await response.json()).message, /受付人数/); }
 for (const limit of ['', '0', '2', 'x']) assert.equal((await act('topup', {SUPPORTER_SUBSCRIBER_LIMIT: limit})).status, 200, limit);
 own = [subscription()];
 assert.equal((await act('topup')).status, 200);
});

test('自動解約は請求書の取り消しを先に行い、取り消せなければ解約しない。途中で落ちても次回に続ける', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), at = jst('2027-02-01T00:00:00');
 insertDunning(store.raw, 'in_1', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 let status = 'open', metadata = {}, voidResult = {httpStatus: 400, body: {error: {message: 'already paid'}}}, deleteResult = {httpStatus: 500, body: {error: {message: 'down'}}};
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due', pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}})]},
  'GET invoices/in_1': () => ({livemode: false, id: 'in_1', status, customer: CUSTOMER, subscription: 'sub_x'}), 'GET subscriptions/sub_x': () => subscription({status: 'past_due', metadata}),
  'POST subscriptions/sub_x': params => { if (params['metadata[dpi_auto_cancel]']) metadata = {dpi_auto_cancel: params['metadata[dpi_auto_cancel]']}; return {livemode: false}; },
  'POST invoices/in_1/void': () => { if (!voidResult.httpStatus) status = 'void'; return voidResult; }, 'DELETE subscriptions/sub_x': () => deleteResult});
 const run = async hours => (await runSupporterBillingSchedule(env, (at + hours * 3600) * 1000)).autoCanceled;
 assert.equal(await run(0), 0);
 assert.equal(calls.some(call => call.method === 'DELETE'), false, '取り消せない（直前に支払われた）なら解約しない');
 voidResult = {livemode: false, status: 'void'};
 assert.equal(await run(12), 0);
 assert.equal(store.dunning('in_1').status, 'suspended', '解約に失敗した間も停止のまま');
 deleteResult = {livemode: false, status: 'canceled'};
 assert.equal(await run(24), 1);
 assert.equal(store.dunning('in_1').status, 'closed');
});

test('管理者が請求を取り消したときは、1か月を過ぎていても解約せず再開する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}})]}, 'GET subscriptions/sub_x': subscription({metadata: {dpi_service_pause: 'dunning'}}),
  'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'void', customer: CUSTOMER, subscription: 'sub_x'}, 'POST subscriptions/sub_x': {livemode: false}});
 assert.equal((await runSupporterBillingSchedule(env, jst('2027-02-01T00:00:00') * 1000)).autoCanceled, 0);
 assert.equal(store.dunning('in_1').status, 'closed');
 assert.equal(calls.some(call => call.method === 'DELETE'), false);
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x' && call.method === 'POST').params.pause_collection, '');
});

test('プラン料金への支払異議で配信と請求を止め、取り下げ・勝ちで再開する', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 let status = 'needs_response', current = subscription();
 const calls = stripeMock(t, {'GET subscriptions': () => ({data: [current]}), 'GET disputes/dp_1': () => ({livemode: false, id: 'dp_1', status, charge: 'ch_1', amount: 300}),
  'GET charges/ch_1': {livemode: false, id: 'ch_1', customer: CUSTOMER, payment_intent: 'pi_plan'}, 'POST subscriptions/sub_x': {livemode: false}});
 await webhook(env, 'charge.dispute.created', {id: 'dp_1', charge: 'ch_1', status: 'needs_response', amount: 300});
 assert.equal(await delivered(env, store.db), 0);
 await runSupporterBillingSchedule(env, jst('2026-11-27T12:00:00') * 1000);
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x').params['pause_collection[behavior]'], 'void');
 current = subscription({pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}});
 calls.length = 0; status = 'won';
 // 通知を取りこぼしても定期処理で再開する
 await runSupporterBillingSchedule(env, jst('2026-11-28T00:00:00') * 1000);
 assert.equal(await delivered(env, store.db), 1);
 assert.equal(calls.find(call => call.path === 'subscriptions/sub_x').params.pause_collection, '');
});

test('問い合わせだけの段階・クレジット購入への異議・別の顧客では配信を止めない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 store.raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,checkout_session_id,payment_intent_id,amount,currency,status,created_at,updated_at) VALUES('r',?,?,'cs_top','pi_topup',500,'jpy','credited',1,1)`).run(UID, CUSTOMER);
 const charge = (id, customer, intent) => ({livemode: false, id, customer, payment_intent: intent});
 stripeMock(t, {'GET subscriptions': {data: [subscription()]}, 'GET customers/cus_x': {livemode: false, balance: 0},
  'GET disputes/dp_warn': {livemode: false, id: 'dp_warn', status: 'warning_needs_response', charge: 'ch_plan'}, 'GET disputes/dp_top': {livemode: false, id: 'dp_top', status: 'needs_response', charge: 'ch_top', amount: 500}, 'GET disputes/dp_other': {livemode: false, id: 'dp_other', status: 'needs_response', charge: 'ch_other'},
  'GET charges/ch_plan': charge('ch_plan', CUSTOMER, 'pi_plan'), 'GET charges/ch_top': charge('ch_top', CUSTOMER, 'pi_topup'), 'GET charges/ch_other': charge('ch_other', 'cus_other', 'pi_other')});
 for (const id of ['warn', 'top', 'other']) assert.equal((await webhook(env, 'charge.dispute.created', {id: `dp_${id}`, charge: id === 'warn' ? 'ch_plan' : `ch_${id}`, payment_intent: id === 'top' ? 'pi_topup' : 'pi_x', status: 'needs_response', amount: 500})).status, 200, id);
 assert.equal(store.raw.prepare("SELECT COUNT(*) AS n FROM supporter_dunning").get().n, 0);
 assert.equal(await delivered(env, store.db), 1);
});

test('異議に負けたら止めたまま。管理者が解除した後は、後から届く通知で止め直さない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 stripeMock(t, {'GET subscriptions': {data: [subscription()]}, 'GET disputes/dp_1': {livemode: false, id: 'dp_1', status: 'lost', charge: 'ch_1', amount: 300}, 'GET charges/ch_1': {livemode: false, id: 'ch_1', customer: CUSTOMER, payment_intent: 'pi_plan'}, 'POST subscriptions/sub_x': {livemode: false}});
 const closed = () => webhook(env, 'charge.dispute.closed', {id: 'dp_1', charge: 'ch_1', status: 'lost', amount: 300});
 await closed();
 await runSupporterBillingSchedule(env, jst('2026-11-27T12:00:00') * 1000);
 assert.equal(await delivered(env, store.db), 0);
 // 契約が終わっても、異議の停止は残る
 await webhook(env, 'customer.subscription.deleted', subscription({status: 'canceled'}));
 assert.equal(await delivered(env, store.db), 0);
 assert.equal(await releaseDisputeHolds(env, store.db, CUSTOMER), 1);
 await closed();
 assert.equal(await delivered(env, store.db), 1);
});

test('異議の間は、月末の再決済を行わない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'retry_scheduled');
 insertDunning(store.raw, 'hold:dispute:dp_1', 'suspended', {suspended_at: 1});
 const calls = stripeMock(t, {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'GET disputes/dp_1': {livemode: false, id: 'dp_1', status: 'under_review', charge: 'ch_1'}, 'GET charges/ch_1': {livemode: false, id: 'ch_1', customer: CUSTOMER}, 'POST subscriptions/sub_x': {livemode: false}});
 await runSupporterBillingSchedule(env, jst('2026-11-30T12:00:00') * 1000);
 assert.equal(calls.some(call => call.path.endsWith('/pay')), false);
});

test('払い終えた後も契約が past_due のままのときは、止めたままにしない（通し試験で見つかった不具合）', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 insertDunning(store.raw, 'in_1', 'suspended', {retry_attempted_at: 1, suspended_at: SUSPEND});
 let unpaid = [{id: 'in_1'}];
 const current = subscription({status: 'past_due', pause_collection: {behavior: 'void'}, metadata: {dpi_service_pause: 'dunning'}});
 stripeMock(t, {'GET subscriptions': {data: [current]}, 'GET invoices': () => ({data: unpaid}), 'GET invoices/in_1': {livemode: false, id: 'in_1', status: 'open', customer: CUSTOMER, subscription: 'sub_x'}, 'POST subscriptions/sub_x': {livemode: false}});
 // 停止中の通知・定期処理で、二重の停止（hold）を付けない
 await webhook(env, 'customer.subscription.updated', current);
 await runSupporterBillingSchedule(env, (SUSPEND + 43200) * 1000);
 assert.equal(store.dunning('hold:sub_x'), undefined);
 // 以前の版が付けた hold が残っていても、支払いで解ける
 insertDunning(store.raw, 'hold:sub_x', 'suspended', {suspended_at: SUSPEND});
 unpaid = [];
 await webhook(env, 'invoice.paid', {id: 'in_1', customer: CUSTOMER, subscription: 'sub_x'});
 assert.equal(store.dunning('hold:sub_x').status, 'closed');
 assert.equal(await delivered(env, store.db), 1);
 await runSupporterBillingSchedule(env, (SUSPEND + 86400) * 1000);
 assert.equal(await delivered(env, store.db), 1, '未払いが無いのに定期処理で止め直さない');
});
