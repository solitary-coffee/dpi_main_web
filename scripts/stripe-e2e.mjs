// 有料プランの通し試験。本物の Stripe（通し試験専用のサンドボックス・テストモード）と、手元の D1（node:sqlite）で、
// Worker の処理をそのまま動かす。本番の Worker・D1・Discord・AWS には一切つながらない。
//
//   node scripts/stripe-e2e.mjs                 … 全部
//   node scripts/stripe-e2e.mjs 更新 異議       … 名前に含むものだけ
//   node scripts/stripe-e2e.mjs --shared        … 本番サイトと同じサンドボックスで行う（試験の間だけ Webhook 送信先を止めて、終わったら戻す）
//   node scripts/stripe-e2e.mjs --browser       … 支払い画面（Stripe Checkout）の実操作も行う（puppeteer-core と Chrome が必要。scripts/e2e-checkout.mjs）
//
// キーは scripts/e2e-key.mjs（テストキーだけ）。Webhook は Stripe のイベントを取得し、手元の鍵で署名して渡す。
// 時間はテストクロックで進め、手元の時刻（Date）も合わせる。結果は %LOCALAPPDATA%\dpi-bot\stripe-e2e-report.json。
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeBrowser, payInBrowser } from './e2e-checkout.mjs';
import { e2eKey } from './e2e-key.mjs';
import { EVENTS, PRICES, ROOT, ensurePortal, ensurePrices, findWebhooks, stripeClient } from './stripe-setup-lib.mjs';
import * as billing from '../worker/supporter-billing.js';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';

const KEY = e2eKey();
const stripe = stripeClient(KEY);
const args = process.argv.slice(2);
const useBrowser = args.includes('--browser');
const filters = args.filter(item => !item.startsWith('--'));
const GUILD = '12345678901234567', CHANNEL = '98765432109876543';
const DAY = 86400;

// --- 時刻 ---
const RealDate = Date;
let shiftMs = 0;
class ShiftedDate extends RealDate {
 constructor(...values) { if (values.length) super(...values); else super(RealDate.now() + shiftMs); }
 static now() { return RealDate.now() + shiftMs; }
}
globalThis.Date = ShiftedDate;
const now = () => Math.floor(Date.now() / 1000);
const setNow = seconds => { shiftMs = seconds * 1000 - RealDate.now(); };
const resetNow = () => { shiftMs = 0; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jstParts = seconds => { const d = new RealDate((seconds + 32400) * 1000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const jst = (year, month, day, hour = 0, minute = 0) => Math.floor(RealDate.UTC(year, month, day, hour, minute) / 1000) - 32400;

// --- 手元の D1 ---
async function database() {
 const raw = new DatabaseSync(':memory:');
 const dir = path.join(ROOT, 'migrations');
 for (const name of (await readdir(dir)).filter(item => item.endsWith('.sql')).sort()) raw.exec(await readFile(path.join(dir, name), 'utf8'));
 const statement = (sql, values = []) => ({
  bind(...input) { return statement(sql, input.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)); },
  async first() { return raw.prepare(sql).get(...values) ?? null; },
  async all() { return {results: raw.prepare(sql).all(...values)}; },
  async run() { return {meta: {changes: Number(raw.prepare(sql).run(...values).changes)}}; },
 });
 return {raw, db: {prepare: sql => statement(sql), async batch(list) { const out = []; for (const item of list) out.push(await item.run()); return out; }}};
}

// --- 1 つの試験の環境（利用者 1 人・テストクロック 1 つ） ---
let seedIds = {}, portalId = '', userSeq = 0;
const clocks = [], seenEvents = new Set();
class World {
 static async create({pm = 'pm_card_visa', clock = true} = {}) {
  const world = new World();
  resetNow();
  Object.assign(world, await database());
  world.uid = String(100000000000000000n + BigInt(RealDate.now()) * 10n + BigInt(userSeq += 1));
  world.mails = [];
  world.env = {SUPPORTER_BILLING_MODE: 'test', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', ...seedIds, STRIPE_PORTAL_CONFIG: portalId, SUPPORTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
   SUPPORTER_PUBLIC_ENABLED: 'true', REUSE_DB: world.db, NOTICE_FROM_EMAIL: 'notice@dpi-bot.com', NOTICE_EMAIL: {send: async mail => { world.mails.push(mail.subject); }}};
  const params = {name: `e2e ${world.uid}`, email: `e2e-${world.uid}@example.com`, 'metadata[dpi_user]': world.uid};
  if (clock) {
   const created = await stripe('POST', 'test_helpers/test_clocks', {frozen_time: String(now()), name: `dpi-e2e ${world.uid}`});
   world.clock = created.id; clocks.push(created.id); params.test_clock = created.id;
  }
  world.customer = (await stripe('POST', 'customers', params)).id;
  world.raw.prepare('INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at,settings_json) VALUES(?,?,?,?,?)').run(world.uid, params.email, '2026-01-01', '2026-01-01',
   JSON.stringify({rules: [{name: 'R1', guildId: GUILD, channelId: CHANNEL, channelIds: [CHANNEL], type: 'earthquake', detail: 'all', region: 'all'}]}));
  world.raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(world.uid, world.customer);
  world.card = pm;
  return world;
 }
 async advance(to) {
  // テストクロックは一度に進められる幅に上限があるため、月ごとに進める。
  while (true) {
   const current = (await stripe('GET', `test_helpers/test_clocks/${this.clock}`)).frozen_time;
   if (current >= to) break;
   const target = Math.min(to, current + 25 * DAY);
   await stripe('POST', `test_helpers/test_clocks/${this.clock}/advance`, {frozen_time: String(target)});
   for (let i = 0; ; i += 1) {
    const state = await stripe('GET', `test_helpers/test_clocks/${this.clock}`);
    if (state.status === 'ready') break;
    if (state.status === 'internal_failure' || i > 120) throw new Error(`テストクロックが進みません: ${state.status}`);
    await sleep(1500);
   }
  }
  setNow(to);
  await this.pump();
 }
 async deliver(event) {
  const body = JSON.stringify(event), ts = now();
  const signature = createHmac('sha256', 'whsec_e2e').update(`${ts}.${body}`).digest('hex');
  const response = await billing.billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook', {method: 'POST', body, headers: {'stripe-signature': `t=${ts},v1=${signature}`}}), this.env);
  if (response.status !== 200) throw new Error(`Webhook ${event.type} が ${response.status} を返しました: ${await response.text()}`);
 }
 // この利用者に関係するイベントを、届いた順に 1 回ずつ渡す。
 async pump() {
  const pending = [];
  for (let page = 0, after = ''; page < 5; page += 1) {
   const list = await stripe('GET', `events?limit=100${after ? `&starting_after=${after}` : ''}`);
   for (const event of list.data) {
    if (seenEvents.has(`${this.uid}:${event.id}`)) continue;
    seenEvents.add(`${this.uid}:${event.id}`);
    if (EVENTS.includes(event.type) && JSON.stringify(event.data.object).includes(this.customer)) pending.push(event);
   }
   if (!list.has_more) break;
   after = list.data.at(-1).id;
  }
  for (const event of pending.reverse()) await this.deliver(event);
  return pending.length;
 }
 async settle(ms = 4000) { await sleep(ms); return await this.pump(); }
 async cron(at = now()) { setNow(at); return await billing.runSupporterBillingSchedule(this.env, at * 1000); }
 async act(action, input = {}) {
  const response = await billing.billingAction(new Request(`https://dpi-bot.com/api/supporter/billing/${action}`), this.env, this.db, this.uid, {legalConsentVersion: 'e2e', ...input});
  return {status: response.status, body: await response.json()};
 }
 async rules() { return (await buildSupporterSnapshot(this.db, this.env, billing.subscriptionSummariesByCustomer, Date.now())).rules.length; }
 async subs() { return (await stripe('GET', `subscriptions?customer=${this.customer}&status=all&limit=20`)).data; }
 async sub() { return (await this.subs()).find(item => !['canceled', 'incomplete_expired'].includes(item.status)); }
 dunning() { return this.raw.prepare('SELECT * FROM supporter_dunning ORDER BY initial_failed_at').all(); }
 // 支払い画面の代わりに、同じ内容の支払いを API で完了させ、完了の通知を渡す（画面の実操作は --browser で確かめる）。
 async pay(amount, metadata, card = this.card) {
  const intent = await stripe('POST', 'payment_intents', {amount: String(amount), currency: 'jpy', customer: this.customer, payment_method: card, confirm: 'true', setup_future_usage: 'off_session',
   'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'});
  assert.equal(intent.status, 'succeeded');
  const session = {id: `cs_test_e2e${randomUUID().replaceAll('-', '')}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', livemode: false, customer: this.customer, client_reference_id: this.uid,
   payment_intent: intent.id, amount_total: amount, currency: 'jpy', created: now(), metadata: {dpi_user: this.uid, dpi_legal_consent_version: 'e2e', ...metadata}};
  await this.deliver({id: `evt_e2e${randomUUID().replaceAll('-', '')}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
  return {session, intent};
 }
 async subscribe(plan = 'supporter', packs = {}) {
  const choice = billing.selection({plan, channelPacks: packs.channel || 0, serverPacks: packs.server || 0, rulePacks: packs.rule || 0});
  const schedule = billing.billingSchedule(Date.now());
  const paid = await this.pay(choice.monthly * schedule.initialMonths, {dpi_checkout_kind: 'initial_subscription', dpi_plan: plan, dpi_channel_packs: String(choice.channelPacks), dpi_server_packs: String(choice.serverPacks), dpi_rule_packs: String(choice.rulePacks), dpi_billing_anchor: String(schedule.anchor)});
  await this.settle(2500);
  return {...paid, choice, schedule, sub: await this.sub()};
 }
 async useCard(card) {
  const method = await stripe('POST', `payment_methods/${card}/attach`, {customer: this.customer});
  await stripe('POST', `customers/${this.customer}`, {'invoice_settings[default_payment_method]': method.id});
  await this.settle();
  return method.id;
 }
}
// 26 日の更新（請求の作成 0:00 → 確定・支払い 1 時間後）まで進める。
const renewal = anchor => anchor + 3 * 3600;
function dunningTimes(anchor) { const [y, m] = jstParts(anchor); return {retry: jst(y, m + 1, 0, 12), stop: jst(y, m + 1, 1), next: jst(y, m + 1, 26), cancel: jst(y, m + 2, 1)}; }

// --- 支払い画面（任意） ---
const stopped = [];
async function restoreWebhooks() {
 while (stopped.length) {
  const id = stopped[0];
  await stripe('POST', `webhook_endpoints/${id}`, {disabled: 'false'});
  stopped.shift(); console.log(`Webhook 送信先 ${id} を再開しました。`);
 }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => restoreWebhooks().finally(() => process.exit(130)));
// --- 試験 ---
const tests = [];
const test = (name, run, options = {}) => tests.push({name, run, ...options});

test('申込み・更新: 初回 → 26日の更新 → 明細と配信', async () => {
 const world = await World.create();
 const {sub, choice, schedule} = await world.subscribe('supporter', {channel: 1});
 assert.ok(sub, '契約が作られていない');
 assert.equal(sub.metadata.dpi_user, world.uid);
 assert.equal(await world.rules(), 1);
 const status = await world.act('status');
 assert.equal(status.status, 200); assert.equal(status.body.subscriptions[0].planId, 'supporter'); assert.equal(status.body.subscriptions[0].channels, 5);
 // 同じ完了通知がもう一度届いても、契約は増えない
 assert.equal((await world.subs()).length, 1);
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const invoices = (await stripe('GET', `invoices?customer=${world.customer}&limit=10`)).data;
 const paid = invoices.find(item => item.status === 'paid' && item.amount_paid === choice.monthly);
 assert.ok(paid, `更新の請求が支払われていない: ${JSON.stringify(invoices.map(item => [item.status, item.amount_due]))}`);
 assert.equal((await world.sub()).status, 'active');
 assert.equal(new Set(invoices.map(item => item.id)).size, invoices.length);
 assert.ok(world.mails.some(subject => subject.includes('お支払い完了')));
 assert.equal(await world.rules(), 1);
});

test('二重処理: 完了通知の再送・順序逆転でも契約は1つ', async () => {
 const world = await World.create();
 const {session} = await world.subscribe('plus');
 for (let i = 0; i < 2; i += 1) await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
 assert.equal((await world.subs()).length, 1);
 // 解約した後に古い通知が届いても作り直さない
 await stripe('DELETE', `subscriptions/${(await world.sub()).id}`); await world.settle();
 await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
 assert.equal((await world.subs()).filter(item => item.status !== 'canceled').length, 0);
 assert.equal(await world.rules(), 0);
});

test('未払い: 失敗 → 月末の再決済 → 翌月1日0時に停止 → 停止中は請求なし → カード変更・支払いで再開 → 次の26日から請求', async () => {
 const world = await World.create();
 const {schedule} = await world.subscribe('supporter');
 await world.useCard('pm_card_chargeCustomerFail');
 const method = (await stripe('GET', `customers/${world.customer}`)).invoice_settings.default_payment_method;
 assert.equal((await world.sub()).default_payment_method, method, '契約管理画面のカード変更が契約に反映されていない');
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const times = dunningTimes(schedule.anchor);
 assert.deepEqual(world.dunning().filter(row => !row.invoice_id.startsWith('hold:')).map(row => row.status), ['retry_scheduled']);
 assert.equal((await world.sub()).status, 'past_due');
 const invoiceId = world.dunning()[0].invoice_id;
 assert.equal((await stripe('GET', `invoices/${invoiceId}`)).auto_advance, false, 'Stripe の自動再試行が止まっていない');
 assert.equal(await world.rules(), 1);
 await world.advance(times.retry); await world.cron(times.retry); await world.settle();
 assert.equal(world.dunning().find(row => row.invoice_id === invoiceId).status, 'suspend_scheduled');
 assert.equal(await world.rules(), 1, '1日0時より前に止まっている');
 await world.advance(times.stop); await world.cron(times.stop);
 assert.equal(world.dunning().find(row => row.invoice_id === invoiceId).status, 'suspended');
 assert.equal(await world.rules(), 0);
 assert.equal((await world.sub()).pause_collection?.behavior, 'void', '停止中の請求が止まっていない');
 const before = (await stripe('GET', `invoices?customer=${world.customer}&limit=20`)).data.length;
 await world.advance(renewal(times.next)); await world.settle();
 const during = (await stripe('GET', `invoices?customer=${world.customer}&limit=20`)).data;
 assert.ok(during.length >= before);
 assert.ok(during.filter(item => item.created >= times.next - 60).every(item => item.status === 'void'), `停止中の請求が取り消されていない: ${JSON.stringify(during.map(item => [item.status, item.created]))}`);
 assert.equal((await stripe('GET', `invoices/${invoiceId}`)).status, 'open', '停止前の請求書まで消えている');
 await world.cron(renewal(times.next));
 assert.equal(await world.rules(), 0, '支払っていないのに再開している');
 // 支払って再開
 const good = await world.useCard('pm_card_visa');
 await stripe('POST', `invoices/${invoiceId}/pay`, {payment_method: good}); await world.settle();
 assert.equal(world.dunning().find(row => row.invoice_id === invoiceId).status, 'paid');
 assert.equal(await world.rules(), 1, '支払い後に再開していない');
 assert.equal((await world.sub()).pause_collection, null, '請求が再開していない');
 const [y, m] = jstParts(times.next);
 await world.advance(renewal(jst(y, m + 1, 26))); await world.settle();
 const last = (await stripe('GET', `invoices?customer=${world.customer}&limit=1`)).data[0];
 assert.equal(last.status, 'paid', `再開後の更新: ${last.status}`);
});

test('自動解約: 停止から1か月後の1日0時に解約し、未払いの請求を取り消す', async () => {
 const world = await World.create();
 const {schedule} = await world.subscribe('plus');
 await world.useCard('pm_card_chargeCustomerFail');
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const times = dunningTimes(schedule.anchor), invoiceId = world.dunning()[0].invoice_id;
 await world.advance(times.retry); await world.cron(times.retry); await world.settle();
 await world.advance(times.stop); await world.cron(times.stop); await world.settle();
 await world.advance(times.cancel - 12 * 3600); assert.equal((await world.cron(times.cancel - 12 * 3600)).autoCanceled, 0);
 await world.advance(times.cancel); assert.equal((await world.cron(times.cancel)).autoCanceled, 1);
 await world.settle();
 assert.equal((await stripe('GET', `invoices/${invoiceId}`)).status, 'void');
 assert.equal((await world.subs())[0].status, 'canceled');
 assert.ok(world.mails.some(subject => subject.includes('自動解約')));
 // 改めて申し込めて、前の未払いは条件にならない
 world.card = 'pm_card_visa';
 await world.subscribe('supporter');
 assert.equal(await world.rules(), 1);
});

test('3Dセキュア: 更新で本人確認を求められたら失敗として扱い、月末まで配信を続ける', async () => {
 const world = await World.create();
 const {schedule} = await world.subscribe('supporter');
 await world.useCard('pm_card_authenticationRequired');
 await world.advance(renewal(schedule.anchor)); await world.settle();
 assert.equal(world.dunning().filter(row => !row.invoice_id.startsWith('hold:'))[0]?.status, 'retry_scheduled');
 assert.equal(await world.rules(), 1);
});

test('手動の一時停止: 翌月1日0時に停止し、解除で再開', async () => {
 const world = await World.create();
 const {sub} = await world.subscribe('supporter');
 await stripe('POST', `subscriptions/${sub.id}`, {'pause_collection[behavior]': 'void'}); await world.settle();
 const hold = world.dunning().find(row => row.invoice_id === `hold:${sub.id}`);
 assert.ok(hold, '一時停止を検知していない');
 assert.equal(await world.rules(), 1);
 await world.advance(hold.suspend_at); await world.cron(hold.suspend_at);
 assert.equal(await world.rules(), 0);
 assert.notEqual((await world.sub()).metadata.dpi_service_pause, 'dunning', '利用者の一時停止に当方の印を付けている');
 await stripe('POST', `subscriptions/${sub.id}`, {pause_collection: ''}); await world.settle();
 assert.equal(await world.rules(), 1);
});

test('変更: アップグレードは即時・差額、ダウングレードは次回26日', async () => {
 const world = await World.create();
 const {schedule} = await world.subscribe('supporter');
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const update = async (selection) => {
  const preview = await world.act('preview-update', selection); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const result = await world.act('update', {...selection, requestId: randomUUID(), prorationDate: preview.body.prorationDate, expectedCreditApplied: preview.body.creditApplied, useCredits: preview.body.creditApplied > 0});
  assert.equal(result.status, 200, JSON.stringify(result.body)); await world.settle(); return {preview: preview.body, result: result.body};
 };
 const up = await update({plan: 'pro', channelPacks: 0, serverPacks: 0, rulePacks: 1});
 assert.equal(up.preview.changeTiming, 'immediate'); assert.ok(up.preview.planProration > 0);
 let state = (await world.act('status')).body.subscriptions[0];
 assert.equal(state.planId, 'pro'); assert.equal(state.rulePacks, 1);
 const down = await update({plan: 'plus', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 assert.equal(down.preview.changeTiming, 'next_period'); assert.equal(down.preview.immediateDue, 0);
 state = (await world.act('status')).body.subscriptions[0];
 assert.equal(state.planId, 'pro'); assert.equal(state.scheduledChange?.planId, 'plus');
 // 予約の後のカード変更が、切替の後も効く
 const method = await world.useCard('pm_card_mastercard');
 const [y, m] = jstParts(schedule.anchor);
 await world.advance(renewal(jst(y, m + 1, 26))); await world.settle();
 const sub = await world.sub();
 state = (await world.act('status')).body.subscriptions[0];
 assert.equal(state.planId, 'plus'); assert.equal(state.rulePacks, 0);
 assert.equal(sub.default_payment_method, method, '予約した切替で古いカードに戻っている');
 const last = (await stripe('GET', `invoices?customer=${world.customer}&limit=1`)).data[0];
 assert.equal(last.amount_paid, 800, `切替後の請求: ${last.amount_paid}`);
});

test('解約: 期間末まで配信し、終わったら止まる。再契約できる', async () => {
 const world = await World.create();
 const {sub, schedule} = await world.subscribe('supporter');
 const portal = await world.act('portal'); assert.equal(portal.status, 200); assert.match(portal.body.url, /^https:\/\/billing\.stripe\.com\//);
 await stripe('POST', `subscriptions/${sub.id}`, {cancel_at_period_end: 'true'}); await world.settle();
 assert.equal((await world.act('status')).body.subscriptions[0].cancelAtPeriodEnd, true);
 assert.equal(await world.rules(), 1);
 await world.advance(renewal(schedule.anchor)); await world.settle();
 assert.equal((await world.subs())[0].status, 'canceled'); assert.equal(await world.rules(), 0);
 await world.subscribe('plus');
 assert.equal(await world.rules(), 1);
});

test('クレジット: チャージは1回だけ付与 → 全額払いの申込み → 次回の請求に充当 → 返金で取消', async () => {
 const world = await World.create();
 const topup = async amount => {
  const requestId = randomUUID(), at = now();
  world.raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,amount,currency,status,created_at,updated_at) VALUES(?,?,?,?,'jpy','pending',?,?)`).run(requestId, world.uid, world.customer, amount, at, at);
  return await world.pay(amount, {dpi_checkout_kind: 'credit_topup', dpi_credit_amount: String(amount), dpi_topup_request_id: requestId});
 };
 const {session} = await topup(1000);
 await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
 assert.equal(await billing.customerCredits(world.env, world.customer), 1000, '二重に付与された');
 const signup = await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0, useCredits: true, requestId: randomUUID()});
 assert.equal(signup.status, 200, JSON.stringify(signup.body)); await world.settle();
 const months = billing.billingSchedule(Date.now()).initialMonths;
 assert.equal(await billing.customerCredits(world.env, world.customer), 1000 - 300 * months);
 assert.equal(await world.rules(), 1);
 const anchor = billing.billingSchedule(Date.now()).anchor;
 await world.advance(renewal(anchor)); await world.settle();
 assert.equal(await billing.customerCredits(world.env, world.customer), 1000 - 300 * (months + 1), '更新にクレジットが使われていない');
 assert.equal((await world.sub()).status, 'active');
 const second = await topup(500);
 const balance = await billing.customerCredits(world.env, world.customer);
 await stripe('POST', 'refunds', {payment_intent: second.intent.id}); await world.settle();
 assert.equal(await billing.customerCredits(world.env, world.customer), balance - 500, '返金したチャージが取り消されていない');
});

test('返金: 初回利用料を管理画面から返金でき、明細に反映される（支払い画面の実操作）', async () => {
 const world = await World.create({clock: false});
 const started = await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 assert.equal(started.status, 200, JSON.stringify(started.body));
 // 同じ操作をもう一度しても、同じ支払い画面になる
 assert.equal((await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0})).body.url, started.body.url);
 await payInBrowser(started.body.url); await world.settle(6000);
 assert.ok(await world.sub(), '支払い後に契約が作られていない');
 const invoices = await billing.customerInvoices(world.env, world.customer);
 assert.equal(invoices[0].label, '初回利用料'); assert.match(invoices[0].receiptUrl, /^https:\/\/pay\.stripe\.com\//);
 const amount = invoices[0].total;
 await billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'refund_latest', amount, requestId: randomUUID(), reason: '通し試験の返金'}); await world.settle();
 assert.equal((await billing.customerInvoices(world.env, world.customer))[0].status, 'refunded');
 assert.equal(world.raw.prepare("SELECT COUNT(*) AS n FROM supporter_payment_alerts WHERE kind='refunded'").get().n, 1);
 assert.equal((await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0})).status, 409, '契約中に二重申込みできる');
}, {browser: true});

test('支払い画面: 拒否されたカードでは契約されない。途中で止まった申込みを復旧できる', async () => {
 const world = await World.create({clock: false});
 const started = await world.act('checkout', {plan: 'plus', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 await assert.rejects(() => payInBrowser(started.body.url, '4000000000000002'));
 await world.settle();
 assert.equal((await world.subs()).length, 0); assert.equal(await world.rules(), 0);
 const recovered = await billing.recoverCheckoutState(world.env, world.db, world.uid);
 assert.equal(recovered.changed, 1);
 assert.equal((await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=1`)).data[0].status, 'expired');
 // 支払ったのに通知が届かなかった場合も、復旧で契約を作る
 const again = await world.act('checkout', {plan: 'plus', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 await payInBrowser(again.body.url); await sleep(4000);
 assert.equal((await world.subs()).length, 0);
 assert.match((await billing.recoverCheckoutState(world.env, world.db, world.uid)).message, /契約を作成/);
 assert.equal(await world.rules(), 1);
}, {browser: true});

test('支払い画面: クレジットチャージ', async () => {
 const world = await World.create({clock: false});
 const started = await world.act('topup', {amount: 500, requestId: randomUUID()});
 assert.equal(started.status, 200, JSON.stringify(started.body));
 await payInBrowser(started.body.url); await world.settle(6000);
 assert.equal(await billing.customerCredits(world.env, world.customer), 500);
 assert.equal((await world.act('status')).body.creditDetails.purchasedBalance, 500);
}, {browser: true});

test('復旧: 支払い画面を開いたままの申込みは失効させてから消す', async () => {
 const world = await World.create({clock: false});
 const started = await world.act('checkout', {plan: 'plus', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 assert.equal(started.status, 200, JSON.stringify(started.body));
 assert.match(started.body.url, /^https:\/\/checkout\.stripe\.com\//);
 assert.equal((await billing.recoverCheckoutState(world.env, world.db, world.uid)).changed, 1);
 assert.equal((await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=1`)).data[0].status, 'expired');
 assert.equal((await billing.recoverCheckoutState(world.env, world.db, world.uid)).changed, 0);
 assert.equal((await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0})).status, 200);
});

for (const [label, evidence, outcome] of [['勝ち', 'winning_evidence', 'won'], ['負け', 'losing_evidence', 'lost']]) {
 test(`異議（${label}）: 申立てで停止${outcome === 'won' ? 'し、勝ちで再開' : 'し、負けたら止めたまま。管理者が解除できる'}`, async () => {
  const world = await World.create({clock: false, pm: 'pm_card_createDispute'});
  const {intent} = await world.subscribe('supporter');
  let dispute = null;
  for (let i = 0; i < 20 && !dispute; i += 1) { await sleep(2000); dispute = (await stripe('GET', `disputes?payment_intent=${intent.id}`)).data[0]; }
  assert.ok(dispute, '異議が作られていない');
  await world.settle(5000);
  // 異議のイベントには顧客が入らないため、対象の通知だけを渡す
  const send = async type => world.deliver({id: `evt_e2e${randomUUID()}`, type, livemode: false, created: now(), data: {object: await stripe('GET', `disputes/${dispute.id}`)}});
  await send('charge.dispute.created');
  assert.equal(await world.rules(), 0, '異議で止まっていない');
  await world.cron();
  assert.equal((await world.sub()).pause_collection?.behavior, 'void');
  await stripe('POST', `disputes/${dispute.id}`, {'evidence[uncategorized_text]': evidence, submit: 'true'});
  for (let i = 0; i < 30; i += 1) { await sleep(2000); if ((await stripe('GET', `disputes/${dispute.id}`)).status === outcome) break; }
  assert.equal((await stripe('GET', `disputes/${dispute.id}`)).status, outcome);
  await send('charge.dispute.closed');
  if (outcome === 'won') assert.equal(await world.rules(), 1, '勝ったのに再開していない');
  else {
   assert.equal(await world.rules(), 0);
   assert.equal(await billing.releaseDisputeHolds(world.env, world.db, world.customer), 1);
   assert.equal(await world.rules(), 1);
  }
  assert.equal((await world.sub()).pause_collection, null, '請求が再開していない');
 });
}

test('カスタム: 初回決済 → 26日の更新 → 増額の差額決済 → 解約専用の画面', async () => {
 const world = await World.create();
 const at = new Date().toISOString(), plan = {id: randomUUID(), revision: 1};
 const columns = world.raw.prepare('PRAGMA table_info(supporter_custom_plans)').all();
 const values = {discord_user_id: world.uid, id: plan.id, name: 'E2E', status: 'offered', revision: 1, confirmed_yen: 1000, estimated_yen: 1000, channel_limit: 10, server_limit: 3, rule_limit: 10, created_at: at, updated_at: at};
 const used = columns.filter(column => column.name in values || (column.notnull && column.dflt_value === null));
 world.raw.prepare(`INSERT INTO supporter_custom_plans(${used.map(column => column.name).join(',')}) VALUES(${used.map(() => '?').join(',')})`).run(...used.map(column => values[column.name] ?? (/INT/i.test(column.type) ? 0 : at)));
 const offer = world.raw.prepare('SELECT * FROM supporter_custom_plans').get();
 const created = await billing.createCustomCheckout(world.env, world.customer, world.uid, offer, randomUUID());
 assert.match(created.url, /^https:\/\/checkout\.stripe\.com\//);
 world.raw.prepare('UPDATE supporter_custom_plans SET stripe_checkout_id=?').run(created.id);
 const params = billing.customInitialCheckoutParams(world.customer, world.uid, offer, randomUUID(), Date.now());
 const metadata = Object.fromEntries(Object.entries(params).filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value]));
 // 支払い画面の代わり: 決済は本物、完了通知の内容は支払い画面と同じ
 const intent = await stripe('POST', 'payment_intents', {amount: params['line_items[0][price_data][unit_amount]'], currency: 'jpy', customer: world.customer, payment_method: 'pm_card_visa', confirm: 'true', setup_future_usage: 'off_session', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'});
 const session = {id: created.id, mode: 'payment', status: 'complete', payment_status: 'paid', livemode: false, customer: world.customer, client_reference_id: world.uid, payment_intent: intent.id, amount_total: Number(params['line_items[0][price_data][unit_amount]']), currency: 'jpy', created: now(), metadata};
 await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
 await world.settle();
 assert.equal(world.raw.prepare('SELECT status FROM supporter_custom_plans').get().status, 'active');
 assert.equal(await world.rules(), 1);
 for (const action of ['checkout', 'update', 'preview-update']) assert.equal((await world.act(action, {plan: 'plus'})).status, 403);
 const anchor = billing.billingSchedule(Date.now()).anchor;
 await world.advance(renewal(anchor)); await world.settle();
 assert.equal((await stripe('GET', `invoices?customer=${world.customer}&limit=1`)).data[0].amount_paid, 1000);
 assert.equal(await world.rules(), 1);
 const portal = await world.act('portal');
 assert.equal(portal.status, 200, JSON.stringify(portal.body)); assert.match(portal.body.url, /\/flow|billing\.stripe\.com/);
 await stripe('POST', `subscriptions/${(await world.sub()).id}`, {cancel_at_period_end: 'true'}); await world.settle();
 assert.equal((await world.act('portal')).status, 409);
});

test('安全: 署名の誤り・本番のイベント・別の顧客の請求を受け付けない', async () => {
 const world = await World.create({clock: false});
 const body = JSON.stringify({id: 'evt_x', type: 'invoice.paid', livemode: false, data: {object: {}}});
 const bad = await billing.billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook', {method: 'POST', body, headers: {'stripe-signature': `t=${now()},v1=${'0'.repeat(64)}`}}), world.env);
 assert.equal(bad.status, 400);
 await assert.rejects(() => world.deliver({id: `evt_${randomUUID()}`, type: 'invoice.paid', livemode: true, data: {object: {}}}));
 const other = (await stripe('POST', 'customers', {name: 'other'})).id;
 await world.deliver({id: `evt_${randomUUID()}`, type: 'invoice.payment_failed', livemode: false, created: now(), data: {object: {id: 'in_other', customer: other, subscription: 'sub_other', billing_reason: 'subscription_cycle', created: now()}}});
 assert.equal(world.dunning().length, 0);
 assert.equal(billing.billingReady({...world.env, SUPPORTER_BILLING_MODE: 'live'}), false, 'テストキーで本番モードになる');
 assert.equal(billing.billingReady(billing.resolveBillingEnv({...world.env, SUPPORTER_BILLING_MODE: 'live'})), false);
 await stripe('DELETE', `customers/${other}`);
});

async function main() {
 const endpoints = (await findWebhooks(stripe)).filter(item => item.status === 'enabled');
 if (endpoints.length && !args.includes('--shared')) throw new Error('このサンドボックスには本番サイトの Webhook 送信先があります。--shared を付けると、試験の間だけ送信先を止めて実行します（本番サイトが受付停止・テストモードのときだけ）。');
 if (endpoints.length) {
  const state = await (await fetch('https://dpi-bot.com/api/supporter/plans', {signal: AbortSignal.timeout(20000)})).json();
  if (state.mode === 'live' ? false : state.intakePaused !== true) throw new Error('本番サイトがテストモードで受付中のため、送信先を止められません。');
  for (const endpoint of endpoints) await stripe('POST', `webhook_endpoints/${endpoint.id}`, {disabled: 'true'});
  console.log(`試験の間、Webhook 送信先 ${endpoints.length} 件を止めます。`);
  stopped.push(...endpoints.map(item => item.id));
 }
 const quiet = () => {};
 seedIds = await ensurePrices(stripe, quiet); portalId = await ensurePortal(stripe, quiet);
 assert.deepEqual(Object.keys(seedIds).sort(), PRICES.map(([name]) => name).sort());
 const errors = console.error, warns = console.warn, logs = console.log;
 const results = [];
 for (const item of tests) {
  if (filters.length && !filters.some(word => item.name.includes(word))) continue;
  if (item.browser && !useBrowser) { results.push({name: item.name, result: 'skipped'}); logs(`－ ${item.name}（支払い画面の実操作は --browser のとき）`); continue; }
  const started = RealDate.now(), captured = [];
  console.error = (...values) => captured.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')); console.warn = console.error;
  try { await item.run(); results.push({name: item.name, result: 'passed'}); logs(`✔ ${item.name}（${Math.round((RealDate.now() - started) / 1000)}秒）`); }
  catch (error) { results.push({name: item.name, result: 'failed', error: error.message}); logs(`✖ ${item.name}\n   ${String(error.stack || error).split('\n').slice(0, 6).join('\n   ')}\n   ${captured.slice(-4).join('\n   ').slice(0, 900)}`); }
  finally { console.error = errors; console.warn = warns; resetNow(); }
 }
 for (const id of clocks) await stripe('DELETE', `test_helpers/test_clocks/${id}`).catch(() => {});
 await closeBrowser();
 const count = kind => results.filter(item => item.result === kind).length;
 const report = {finishedAt: new RealDate().toISOString(), passed: count('passed'), failed: count('failed'), skipped: count('skipped'), filtered: filters.length > 0, results};
 logs(`\n合格 ${report.passed}・失敗 ${report.failed}・未実施 ${report.skipped}`);
 if (!report.filtered) {
  const dir = path.join(process.env.LOCALAPPDATA || tmpdir(), 'dpi-bot');
  await mkdir(dir, {recursive: true}); await writeFile(path.join(dir, 'stripe-e2e-report.json'), JSON.stringify(report, null, 1));
 }
 process.exitCode = report.failed ? 1 : 0;
}
main().catch(error => { console.error(`エラー: ${error.message}`); process.exitCode = 1; })
 .finally(() => restoreWebhooks().catch(error => { console.error(`重要: Webhook 送信先を再開できませんでした（${stopped.join('、')}）。Stripe のダッシュボードで有効に戻してください: ${error.message}`); process.exitCode = 1; }));
