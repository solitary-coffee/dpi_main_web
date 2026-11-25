// 運営向けの Discord 通知（支払い・加入/変更/解約）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { billingWebhook, runSupporterBillingSchedule } from '../worker/supporter-billing.js';
import { flushNotices, jstDate, queueNotice } from '../worker/supporter-ops-notice.js';

const UID = '123456789012345678', CUSTOMER = 'cus_x';
const BILLING = `https://discord.com/api/webhooks/111111111111111111/${'b'.repeat(60)}`, MEMBERSHIP = `https://discord.com/api/webhooks/222222222222222222/${'m'.repeat(60)}`;
const jst = text => Math.floor(Date.parse(`${text}+09:00`) / 1000);

async function database(t, name = 'テスト利用者') {
 let DatabaseSync;
 try { ({DatabaseSync} = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available'); return null; }
 const raw = new DatabaseSync(':memory:');
 const dir = new URL('../migrations/', import.meta.url);
 for (const file of (await readdir(dir)).filter(item => item.endsWith('.sql')).sort()) raw.exec(await readFile(new URL(file, dir), 'utf8'));
 const statement = (sql, values = []) => ({
  bind(...input) { return statement(sql, input); },
  async first() { return raw.prepare(sql).get(...values) ?? null; },
  async all() { return {results: raw.prepare(sql).all(...values)}; },
  async run() { return {meta: {changes: Number(raw.prepare(sql).run(...values).changes)}}; },
 });
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at) VALUES(?,?,?,?,?)').run(UID, name, 'secret@example.jp', 'x', 'x');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID, CUSTOMER);
 return {raw, db: {prepare: sql => statement(sql), async batch(list) { const out = []; for (const item of list) out.push(await item.run()); return out; }},
  notices: () => raw.prepare('SELECT * FROM supporter_ops_notices ORDER BY created_at,id').all().map(row => ({...row, payload: JSON.parse(row.payload_json)}))};
}
const envFor = (db, extra = {}) => ({SUPPORTER_BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_example', STRIPE_PRICE_SUPPORTER: 'price_basic', STRIPE_PRICE_PLUS: 'price_plus',
 STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ADDON: 'price_addon', STRIPE_PORTAL_CONFIG: 'bpc_x', SUPPORTER_PUBLIC_ORIGIN: 'https://dpi-bot.com', REUSE_DB: db, BILLING_NOTICE_WEBHOOK: BILLING, MEMBERSHIP_NOTICE_WEBHOOK: MEMBERSHIP,
 NOTICE_FROM_EMAIL: 'notice@dpi-bot.com', NOTICE_EMAIL: {async send() {}}, ...extra});
const item = (price, amount, quantity = 1, period = {}) => ({id: `si_${price}`, quantity, current_period_start: 1, current_period_end: 4e9, ...period, price: {id: price, unit_amount: amount, currency: 'jpy', recurring: {interval: 'month'}}});
const subscription = extra => ({id: 'sub_x', status: 'active', customer: CUSTOMER, livemode: true, metadata: {}, items: {data: [item('price_basic', 300)]}, ...extra});
function mock(t, {stripe = {}, discord = () => new Response(null, {status: 204})} = {}) {
 const posts = [], original = globalThis.fetch;
 t.after(() => { globalThis.fetch = original; });
 globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url);
  if (target.hostname === 'discord.com') { const body = JSON.parse(init.body); posts.push({channel: url === BILLING ? 'billing' : 'membership', body, embed: body.embeds[0]}); return discord(posts.length); }
  const value = stripe[`${init.method || 'GET'} ${target.pathname.replace('/v1/', '')}`];
  const data = typeof value === 'function' ? value() : value;
  return data?.httpStatus ? Response.json(data.body, {status: data.httpStatus}) : Response.json(data ?? {data: []});
 };
 return posts;
}
async function webhook(env, type, object, {id = `evt_${Math.random()}`, previous, created = jst('2026-12-10T12:00:00')} = {}) {
 const raw = JSON.stringify({id, type, livemode: true, created, data: {object, previous_attributes: previous}});
 const ts = Math.floor(Date.now() / 1000), sig = createHmac('sha256', 'whsec_example').update(`${ts}.${raw}`).digest('hex');
 return billingWebhook(new Request('https://dpi-bot.com/x', {method: 'POST', body: raw, headers: {'stripe-signature': `t=${ts},v1=${sig}`}}), env);
}

test('加入・変更・変更予約・解約予約・取消・解約・再加入を、加入/解約チャンネルへ1回ずつ送る', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 let current = subscription();
 const schedule = {livemode: true, phases: [{start_date: 4e9, items: [{price: 'price_basic', quantity: 1}], metadata: {dpi_channel_packs: '0', dpi_server_packs: '0'}}]};
 const posts = mock(t, {stripe: {'GET subscriptions': () => ({data: [current]}), 'GET subscription_schedules/sub_sched': schedule}});
 await webhook(env, 'customer.subscription.created', current, {id: 'evt_join'});
 await webhook(env, 'customer.subscription.created', current, {id: 'evt_join'});
 current = subscription({items: {data: [item('price_plus', 800), item('price_addon', 200, 2)]}, metadata: {dpi_channel_packs: '2', dpi_server_packs: '0', dpi_rule_packs: '0'}});
 await webhook(env, 'customer.subscription.updated', current, {previous: {items: {data: [item('price_basic', 300)]}, metadata: {dpi_channel_packs: null, dpi_server_packs: null, dpi_rule_packs: null}}});
 await webhook(env, 'customer.subscription.updated', {...current, schedule: 'sub_sched'}, {previous: {schedule: null}});
 await webhook(env, 'customer.subscription.updated', {...current, cancel_at: 4e9}, {previous: {cancel_at: null}});
 await webhook(env, 'customer.subscription.updated', current, {previous: {cancel_at: 4e9}});
 await webhook(env, 'customer.subscription.deleted', {...current, status: 'canceled', cancel_at_period_end: true});
 await webhook(env, 'customer.subscription.deleted', {...current, id: 'sub_auto', status: 'canceled', metadata: {...current.metadata, dpi_auto_cancel: 'in_1'}});
 await webhook(env, 'customer.subscription.created', subscription({id: 'sub_y'}));
 assert.deepEqual(posts.map(post => [post.channel, post.embed.title]), [['membership', '新規加入'], ['membership', 'プラン変更'], ['membership', '変更の予約'], ['membership', '解約の予約'], ['membership', '解約の予約の取り消し'], ['membership', '解約'], ['membership', '解約（自動）'], ['membership', '再加入']]);
 assert.match(posts[0].embed.description, /テスト利用者（ID 123456789012345678）[\s\S]*BASIC（月額 300円）/);
 assert.match(posts[1].embed.description, /変更前: BASIC（月額 300円）\n変更後: Plus（月額 1,200円、チャンネル追加×2）/);
 assert.match(posts[2].embed.description, /から: BASIC/);
 assert.ok(posts.every(post => !JSON.stringify(post.body).includes('secret@example.jp') && !/cus_|sub_|evt_/.test(JSON.stringify(post.body))), 'メールや Stripe の ID を載せない');
 assert.ok(posts.every(post => JSON.stringify(post.body.allowed_mentions) === '{"parse":[]}'));
});

test('毎月の更新・当方の一時停止の印・別の顧客・メールの変更では、加入/解約の通知を出さない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), current = subscription();
 const posts = mock(t, {stripe: {'GET subscriptions': {data: [current]}, 'GET customers/cus_x': {livemode: true, id: CUSTOMER}}});
 await webhook(env, 'customer.subscription.updated', current, {previous: {items: {data: [item('price_basic', 300, 1, {current_period_end: 3e9})]}, latest_invoice: 'in_0'}});
 await webhook(env, 'customer.subscription.updated', {...current, metadata: {dpi_service_pause: 'dunning'}, pause_collection: {behavior: 'void'}}, {previous: {pause_collection: null, metadata: {dpi_service_pause: null}}});
 await webhook(env, 'customer.subscription.created', subscription({customer: 'cus_other'}));
 await webhook(env, 'customer.updated', {id: CUSTOMER, email: 'new@example.jp'}, {previous: {email: 'old@example.jp'}});
 assert.deepEqual(posts, []);
});

test('26日: 0時に請求の開始、12時に結果（成功・クレジット・失敗・停止中）を1回ずつ', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), start = jst('2026-12-26T00:00:00');
 const due = extra => subscription({items: {data: [item('price_basic', 300, 1, {current_period_end: start})]}, start_date: 1, ...extra});
 const invoice = (status, extra = {}) => ({id: `in_${Math.random()}`, customer: CUSTOMER, billing_reason: 'subscription_cycle', created: start, status, amount_paid: 0, attempt_count: 0, ...extra});
 const posts = mock(t, {stripe: {'GET subscriptions': {data: [due(), due({id: 'sub_pause', metadata: {dpi_service_pause: 'dunning'}, pause_collection: {behavior: 'void'}}), due({id: 'sub_cancel', cancel_at_period_end: true}), subscription({id: 'sub_later'})]},
  'GET invoices': {data: [invoice('paid', {amount_paid: 300}), invoice('paid', {amount_paid: 800}), invoice('paid'), invoice('open', {attempt_count: 1, amount_remaining: 300}), invoice('void'), invoice('draft'), invoice('paid', {amount_paid: 9999, customer: 'cus_other'}), invoice('paid', {amount_paid: 500, billing_reason: 'subscription_update'}), invoice('paid', {amount_paid: 700, created: start - 86400})]}}});
 for (let i = 0; i < 2; i += 1) await runSupporterBillingSchedule(env, (start + 5) * 1000);
 await runSupporterBillingSchedule(env, (start + 12 * 3600) * 1000);
 const billing = posts.filter(post => post.channel === 'billing');
 assert.deepEqual(billing.map(post => post.embed.title), ['12月26日の請求を開始', '12月26日の請求結果']);
 assert.match(billing[0].embed.description, /対象: 1件（合計 300円）\n停止中のため請求しない契約: 1件/);
 assert.match(billing[1].embed.description, /成功: 2件（1,100円）\nクレジットで全額支払い: 1件\n失敗: 1件（300円）\n停止中のため取り消し: 1件\n確認中: 1件\n失敗した分は、12月31日 12時に再請求します。/);
});

test('月末: 再請求の開始と結果。翌月1日: 停止・自動解約・前月の集計', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db), retry = jst('2026-12-31T12:00:00'), stop = jst('2027-01-01T00:00:00');
 const insert = id => store.raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES(?,?,'sub_x',300,'jpy','retry_scheduled',1,?,?,1)`).run(id, CUSTOMER, retry, stop);
 insert('in_ok'); insert('in_ng'); insert('in_down');
 await queueNotice(env, store.db, {id: 'old-join', channel: 'membership', kind: 'join', title: '新規加入', at: jst('2026-12-05T00:00:00')});
 await queueNotice(env, store.db, {id: 'nov-join', channel: 'membership', kind: 'join', title: '新規加入', at: jst('2026-11-30T23:59:59')});
 const open = id => ({livemode: true, id, status: 'open', customer: CUSTOMER, subscription: 'sub_x'});
 const posts = mock(t, {stripe: {'GET subscriptions': {data: [subscription({status: 'past_due'})]}, 'POST subscriptions/sub_x': {livemode: true}, 'GET invoices/in_ok': open('in_ok'), 'GET invoices/in_ng': open('in_ng'), 'GET invoices/in_down': open('in_down'),
  'POST invoices/in_ok/pay': {livemode: true, id: 'in_ok', status: 'paid', amount_paid: 300, customer: CUSTOMER, subscription: 'sub_x'}, 'POST invoices/in_ng/pay': {httpStatus: 402, body: {error: {code: 'card_declined'}}}, 'POST invoices/in_down/pay': {httpStatus: 500, body: {}}}});
 await runSupporterBillingSchedule(env, retry * 1000);
 await runSupporterBillingSchedule(env, stop * 1000);
 const billing = posts.filter(post => post.channel === 'billing').map(post => post.embed);
 assert.deepEqual(billing.map(embed => embed.title), ['再請求を開始', '再請求の結果', '再請求を開始', '再請求の結果', '1月1日の停止・解約の結果']);
 assert.match(billing[0].description, /対象: 3件（合計 900円）/);
 assert.match(billing[1].description, /成功: 1件（300円）\n失敗: 1件（300円）\nStripeの障害などで保留: 1件/);
 assert.match(billing[4].description, /今回停止したもの: 2件\n停止中のアカウント: 1件\n支払いを確認できず自動解約: 0件\n12月の集計: 加入 1件、変更 0件、解約の予約 0件、解約 0件/);
});

test('返金・支払異議を支払いチャンネルへ送り、チャージは送らない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 const posts = mock(t, {stripe: {'GET subscriptions': {data: [subscription()]}, 'GET charges/ch_x': {livemode: true, id: 'ch_x', customer: CUSTOMER, payment_intent: 'pi_x'}, 'GET disputes/dp_x': {livemode: true, id: 'dp_x', status: 'needs_response', charge: 'ch_x', amount: 300}, 'POST subscriptions/sub_x': {livemode: true},
  'GET customers/cus_x': {livemode: true, balance: -500}, 'POST customers/cus_x/balance_transactions': {livemode: true, id: 'cbtxn', ending_balance: -500}}});
 await webhook(env, 'charge.refunded', {id: 'ch_x', customer: CUSTOMER, payment_intent: 'pi_x', amount_refunded: 300});
 await webhook(env, 'charge.dispute.created', {id: 'dp_x', charge: 'ch_x', status: 'needs_response', amount: 300});
 const request = '00000000-0000-4000-8000-000000000001';
 const session = {id: 'cs_live_x', mode: 'payment', status: 'complete', payment_status: 'paid', customer: CUSTOMER, client_reference_id: UID, payment_intent: 'pi_top', amount_total: 500, currency: 'jpy', metadata: {dpi_checkout_kind: 'credit_topup', dpi_user: UID, dpi_credit_amount: '500', dpi_topup_request_id: request}};
 await webhook(env, 'checkout.session.completed', session); await webhook(env, 'checkout.session.completed', session);
 assert.deepEqual(posts.map(post => [post.channel, post.embed.title]), [['billing', '返金'], ['billing', '支払異議']]);
});

test('Discord の障害は処理を止めず後で送り直し、消えた宛先には送り続けない。未設定なら送らない', async t => {
 const store = await database(t); if (!store) return;
 const env = envFor(store.db);
 let status = 500;
 const posts = mock(t, {stripe: {'GET subscriptions': {data: [subscription()]}}, discord: () => new Response(null, {status})});
 assert.equal((await webhook(env, 'customer.subscription.created', subscription())).status, 200);
 assert.equal(store.notices()[0].status, 'pending');
 status = 204; await flushNotices(env, store.db);
 assert.equal(store.notices()[0].status, 'sent'); assert.equal(posts.length, 2);
 await queueNotice(env, store.db, {id: 'gone', channel: 'billing', kind: 'x', title: 'x'}); status = 404;
 await flushNotices(env, store.db); await flushNotices(env, store.db);
 assert.equal(posts.length, 3); assert.equal(store.notices().find(row => row.id === 'gone').status, 'failed');
 for (const value of ['', 'https://example.com/api/webhooks/1/x', 'http://discord.com/api/webhooks/111111111111111111/aaaaaaaaaaaaaaaaaaaaaaaa']) {
  await queueNotice(env, store.db, {id: `bad${value}`, channel: 'billing', kind: 'x', title: 'x'});
  await flushNotices({...env, BILLING_NOTICE_WEBHOOK: value}, store.db);
 }
 assert.equal(posts.length, 3);
});

test('名前の装飾・メンション・改行を無害にし、テストモードは題名で分かる', async t => {
 const store = await database(t, '@everyone [x](https://evil.example)\n**太字**`'); if (!store) return;
 const env = envFor(store.db, {SUPPORTER_BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_example'});
 const posts = mock(t);
 const { queueMembershipNotice } = await import('../worker/supporter-ops-notice.js');
 await queueMembershipNotice(env, store.db, {id: 'evt', type: 'customer.subscription.created', created: 1, data: {object: subscription()}}, {summarize: () => ({plan: 'BASIC', amount: 300}), cancelScheduled: () => false});
 await flushNotices(env, store.db);
 assert.equal(posts[0].embed.title, '【テスト】新規加入');
 assert.doesNotMatch(posts[0].embed.description, /[@[\]`*()]/);
});

test('日本時間の日付', () => {
 assert.deepEqual([jstDate(jst('2026-12-26T00:00:00')).key, jstDate(jst('2026-12-25T23:59:59')).day, jstDate(jst('2028-02-10T12:00:00')).lastDay, jstDate(jst('2027-01-01T00:00:00')).start], ['2026-12-26', 25, 29, jst('2027-01-01T00:00:00')]);
});

test('本番の Webhook で、公式サーバーのロールを付け外しする。Discord が止まっていても 200 を返す', async t => {
 for (const down of [false, true]) {
  const store = await database(t); if (!store) return;
  const env = envFor(store.db, {BILLING_NOTICE_WEBHOOK: '', MEMBERSHIP_NOTICE_WEBHOOK: '', DISCORD_BOT_TOKEN: 'token', SUPPORTER_ROLE_GUILD_ID: '123456789012345679', SUPPORTER_ROLE_MEMBER: '123456789012345671', SUPPORTER_ROLE_BASIC: '123456789012345672', SUPPORTER_ROLE_PLUS: '123456789012345673', SUPPORTER_ROLE_PRO: '123456789012345674', SUPPORTER_ROLE_CUSTOM: '123456789012345675'});
  const calls = [], original = globalThis.fetch; let current = subscription();
  globalThis.fetch = async (url, init = {}) => {
   const target = new URL(url);
   if (target.hostname !== 'discord.com') return Response.json(target.pathname === '/v1/subscriptions' ? {data: [current]} : {data: []});
   calls.push(`${init.method} ${target.pathname.split('/').slice(-3).join('/')}`);
   if (down) throw new TypeError('network');
   return new Response(null, {status: 204});
  };
  try {
   assert.equal((await webhook(env, 'customer.subscription.created', current)).status, 200);
   assert.deepEqual(calls.sort(), [`PUT ${UID}/roles/123456789012345671`, `PUT ${UID}/roles/123456789012345672`]);
   current = subscription({status: 'canceled'});
   assert.equal((await webhook(env, 'customer.subscription.deleted', current)).status, 200);
   assert.equal(calls.filter(call => call.startsWith('DELETE')).length, 2);
   calls.length = 0;
   assert.equal((await webhook({...env, SUPPORTER_ROLE_GUILD_ID: ''}, 'customer.subscription.updated', subscription())).status, 200);
   assert.equal(calls.length, 0);
  } finally { globalThis.fetch = original; }
 }
});
