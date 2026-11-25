// 有料プランの通し試験。本物の Stripe（通し試験専用のサンドボックス・テストモード）と、手元の D1（node:sqlite）で、
// Worker の処理をそのまま動かす。本番の Worker・D1・Discord・AWS には一切つながらない（--notify のときだけ、中継を通してメールと Discord 通知を送る）。
//
//   node scripts/stripe-e2e.mjs                 … 全部
//   node scripts/stripe-e2e.mjs 更新 異議       … 名前に含むものだけ
//   node scripts/stripe-e2e.mjs --shared        … 本番サイトと同じサンドボックスで行う（試験の間だけ Webhook 送信先を止めて、終わったら戻す）
//   node scripts/stripe-e2e.mjs --notify        … メールと Discord 通知を、種類ごとに 1 回ずつ実際に送る（STRIPE_E2E_PROXY の中継が送る。宛先は中継の中で決まる）
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
import { cancelInPortal, closeBrowser, payInBrowser } from './e2e-checkout.mjs';
import { e2eKey } from './e2e-key.mjs';
import { EVENTS, PRICES, ROOT, ensurePortal, ensurePrices, findWebhooks, siteState, stripeClient } from './stripe-setup-lib.mjs';
import * as billing from '../worker/supporter-billing.js';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';
import { stageCustomChange } from '../worker/supporter-custom-change.js';

const KEY = e2eKey();
const stripe = stripeClient(KEY);
const args = process.argv.slice(2);
const useBrowser = args.includes('--browser');
const notify = args.includes('--notify');
if (notify && !process.env.STRIPE_E2E_PROXY) throw new Error('--notify には中継（STRIPE_E2E_PROXY）が必要です。');
const filters = args.filter(item => !item.startsWith('--'));
const GUILD = '12345678901234567', CHANNEL = '98765432109876543';
const DAY = 86400;

// Stripe の全体の一覧には、テストクロックの顧客の契約が出ない。試験中の利用者のテストクロックを指定して、本番と同じ見え方にする。
let currentClock = '', currentCustomer = '';
// --notify: 同じ種類（題名）は 1 回だけ送る。日付などの数字の違いは同じ種類とみなす。
const delivered = {mail: new Map(), admin: new Map(), discord: new Map()};
// 試験のメールは、件名と本文の先頭で「誰に届くものか」を示す。
const testMail = (audience, subject, note, text, headers) => ({headers, subject: `【通し試験｜${audience}】${subject}`,
 text: `━━━━━━━━━━━━━━━━━━━━
【${audience}】${note}
これは有料プランの通し試験です。実際の請求・契約・処分ではありません。
━━━━━━━━━━━━━━━━━━━━

${text}`});
const kindOf = text => String(text).replace(/\d+/g, '#');
async function relay(path, body) {
 const response = await fetch(`${new URL(process.env.STRIPE_E2E_PROXY).origin}${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'x-e2e-token': process.env.STRIPE_E2E_PROXY_TOKEN || '', 'content-type': 'application/json'}, signal: AbortSignal.timeout(60000)});
 if (!response.ok) throw new Error(`${path} ${response.status} ${(await response.text()).slice(0, 200)}`);
}
async function sendOnce(kind, key, path, body) {
 if (delivered[kind].has(key)) return;
 delivered[kind].set(key, 'sending');
 try { await relay(path, body); delivered[kind].set(key, 'sent'); }
 catch (error) { delivered[kind].set(key, `failed: ${error.message}`); }
}
const baseFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
 const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
 if (notify && url.hostname === 'discord.com' && url.pathname.startsWith('/api/webhooks/')) {
  const channel = url.pathname.includes('membership') ? 'membership' : 'billing', body = JSON.parse(init.body);
  const {title, description} = body.embeds[0], label = channel === 'billing' ? '支払い' : '加入・変更・解約', key = `${label}: ${kindOf(title)}`;
  return sendOnce('discord', key, '/__notice', {channel, body})
   .then(() => sendOnce('admin', key, '/__mail', testMail('管理者向け', title, `運営の Discord「${label}」チャンネルに届く通知と同じ内容です。利用者には送られません。`, description)))
   .then(() => new Response(null, {status: 204}));
 }
 if (currentClock && url.hostname === 'api.stripe.com' && url.pathname === '/v1/subscriptions' && (init.method || 'GET') === 'GET' && !url.searchParams.has('customer')) {
  url.searchParams.set('test_clock', currentClock);
  return baseFetch(url.href, init);
 }
 // 請求書の全体の一覧（26日の結果の集計）も同じ。試験中の利用者の請求書だけにする。
 if (currentClock && url.hostname === 'api.stripe.com' && url.pathname === '/v1/invoices' && (init.method || 'GET') === 'GET' && !url.searchParams.has('customer') && !url.searchParams.has('subscription')) {
  url.searchParams.set('customer', currentCustomer);
  url.searchParams.delete('created[gte]'); // テストクロックの請求書は、作成日の絞り込みだけ実際の時刻で働く（Worker 側でも作成日を確かめる）
  return baseFetch(url.href, init);
 }
 return baseFetch(input, init);
};

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
const clocks = [], plainCustomers = [], seenEvents = new Set();
class World {
 static async create({pm = 'pm_card_visa', clock = true} = {}) {
  const world = new World();
  resetNow();
  Object.assign(world, await database());
  currentClock = '';
  world.uid = String(100000000000000000n + BigInt(RealDate.now()) * 10n + BigInt(userSeq += 1));
  world.mails = [];
  world.env = {SUPPORTER_BILLING_MODE: 'test', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', ...seedIds, STRIPE_PORTAL_CONFIG: portalId, SUPPORTER_PUBLIC_ORIGIN: 'https://dpi-bot.com',
   SUPPORTER_PUBLIC_ENABLED: 'true', REUSE_DB: world.db, NOTICE_FROM_EMAIL: 'notice@dpi-bot.com', NOTICE_EMAIL: {send: async mail => {
    world.mails.push(mail.subject);
    if (notify) await sendOnce('mail', kindOf(mail.subject), '/__mail', testMail('ユーザー向け', mail.subject, '有料プランの利用者に届くメールです。', mail.text, mail.headers));
   }},
   ...(notify ? {BILLING_NOTICE_WEBHOOK: `https://discord.com/api/webhooks/111111111111111111/${'billing'.padEnd(30, '_')}`, MEMBERSHIP_NOTICE_WEBHOOK: `https://discord.com/api/webhooks/222222222222222222/${'membership'.padEnd(30, '_')}`} : {})};
  const params = {name: `e2e ${world.uid}`, email: `e2e-${world.uid}@example.com`, 'metadata[dpi_user]': world.uid};
  if (clock) {
   const created = await stripe('POST', 'test_helpers/test_clocks', {frozen_time: String(now()), name: `dpi-e2e ${world.uid}`});
   world.clock = currentClock = created.id; clocks.push(created.id); params.test_clock = created.id;
  }
  world.customer = (await stripe('POST', 'customers', params)).id;
  currentCustomer = world.customer;
  if (!clock) plainCustomers.push(world.customer);
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
  const response = await this.deliverResponse(event);
  if (response.status !== 200) throw new Error(`Webhook ${event.type} が ${response.status} を返しました: ${await response.text()}`);
 }
 async deliverResponse(event) {
  const body = JSON.stringify(event), ts = now();
  const signature = createHmac('sha256', 'whsec_e2e').update(`${ts}.${body}`).digest('hex');
  return billing.billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook', {method: 'POST', body, headers: {'stripe-signature': `t=${ts},v1=${signature}`}}), this.env);
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
 notices() { return this.raw.prepare('SELECT kind,payload_json FROM supporter_ops_notices ORDER BY created_at,rowid').all().map(row => ({kind: row.kind, ...JSON.parse(row.payload_json)})); }
 kinds() { return this.notices().map(row => row.kind); }
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
 assert.deepEqual(world.kinds(), ['join']);
 await world.advance(schedule.anchor + 10); await world.cron(schedule.anchor + 10);
 await world.advance(renewal(schedule.anchor)); await world.settle();
 await world.advance(schedule.anchor + 12 * 3600); await world.cron(schedule.anchor + 12 * 3600);
 assert.deepEqual(world.kinds(), ['join', 'renewal_start', 'renewal_result']);
 assert.match(world.notices()[1].description, /対象: 1件（合計 500円）/); assert.match(world.notices()[2].description, /成功: 1件（500円）/);
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
 assert.deepEqual(world.kinds().filter(kind => kind !== 'join'), ['retry_start', 'retry_result', 'month_start']);
 assert.match(world.notices().find(row => row.kind === 'retry_result').description, /失敗: 1件（300円）/);
 assert.match(world.notices().find(row => row.kind === 'month_start').description, /今回停止したもの: 1件\n停止中のアカウント: 1件/);
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
 { const sub = await world.sub(); const rows = world.dunning().map(row => [row.invoice_id.slice(0, 12), row.status]); assert.equal(await world.rules(), 1, `支払い後に再開していない: ${JSON.stringify({status: sub.status, pause: sub.pause_collection, mark: sub.metadata.dpi_service_pause, rows})}`); }
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
 assert.ok(world.notices().some(row => row.kind === 'leave' && row.title.includes('自動')), '自動解約の通知が無い');
 assert.ok(world.notices().some(row => row.kind === 'month_start' && row.description.includes('自動解約: 1件')));
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
 assert.ok(world.kinds().includes('change') && world.kinds().includes('change_reserved'), `変更の通知: ${world.kinds()}`);
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
 assert.deepEqual(world.notices().map(row => row.title.replace('【テスト】', '')), ['新規加入', '解約の予約', '解約', '再加入']);
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

test('カスタム: 初回決済 → 26日の更新 → 解約専用の画面', async () => {
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

test('カスタムの料金変更: 増額は差額の支払い後、減額は次回から（支払い画面の実操作）', async () => {
 const world = await World.create({clock: false});
 const at = new Date().toISOString();
 const columns = world.raw.prepare('PRAGMA table_info(supporter_custom_plans)').all();
 const values = {discord_user_id: world.uid, id: randomUUID(), name: 'E2E', status: 'offered', revision: 1, confirmed_yen: 1000, estimated_yen: 1000, channel_limit: 10, server_limit: 3, rule_limit: 10, created_at: at, updated_at: at};
 const used = columns.filter(column => column.name in values || (column.notnull && column.dflt_value === null));
 world.raw.prepare(`INSERT INTO supporter_custom_plans(${used.map(column => column.name).join(',')}) VALUES(${used.map(() => '?').join(',')})`).run(...used.map(column => values[column.name] ?? (/INT/i.test(column.type) ? 0 : at)));
 const plan = () => world.raw.prepare('SELECT * FROM supporter_custom_plans').get();
 const initial = await billing.createCustomCheckout(world.env, world.customer, world.uid, plan(), randomUUID());
 world.raw.prepare('UPDATE supporter_custom_plans SET stripe_checkout_id=?').run(initial.id);
 await payInBrowser(initial.url); await world.settle(6000);
 assert.equal(plan().status, 'active', '初回決済の後に契約が有効になっていない');
 const next = monthlyYen => ({name: 'E2E', channels: 10, servers: 3, rules: 10, features: [], monthlyYen, secondaryReuse: false, reason: 'e2e'});
 const stage = monthlyYen => stageCustomChange(world.db, world.uid, world.customer, plan(), next(monthlyYen), 'e2e@example.com', '通し試験の変更', randomUUID());
 const up = await stage(1600);
 const checkout = await billing.createCustomDifferenceCheckout(world.env, world.customer, world.uid, plan(), up);
 world.raw.prepare('UPDATE supporter_custom_plan_changes SET checkout_session_id=?,checkout_expires_at=? WHERE request_id=?').run(checkout.id, checkout.expiresAt, up.request_id);
 assert.equal(Number(plan().confirmed_yen), 1000, '支払い前に新しい条件になっている');
 await payInBrowser(checkout.url); await world.settle(6000);
 assert.equal(Number(plan().confirmed_yen), 1600); assert.equal((await world.sub()).items.data[0].price.unit_amount, 1600);
 assert.equal((await stripe('GET', `checkout/sessions/${checkout.id}`)).amount_total, 600);
 const down = await stage(1000);
 await billing.settleCustomPriceChange(world.env, world.db, world.uid, down.request_id); await world.settle();
 assert.equal(Number(plan().confirmed_yen), 1000); assert.equal((await world.sub()).items.data[0].price.unit_amount, 1000);
 assert.equal(await world.rules(), 1);
 assert.equal(world.kinds().filter(kind => kind === 'change').length, 2, `変更の通知: ${world.kinds()}`);
 const labels = (await billing.customerInvoices(world.env, world.customer)).map(item => item.label).filter(Boolean);
 assert.ok(labels.includes('初回利用料') && labels.includes('カスタムプランの差額'));
}, {browser: true});

test('管理操作: クレジットの付与・削除・失効、支払いURL、契約変更、期間末・即時の終了、処分', async () => {
 const world = await World.create({clock: false});
 const admin = (action, extra = {}) => billing.adminBillingAction(world.env, world.customer, world.uid, {action, requestId: randomUUID(), reason: '通し試験の操作', ...extra});
 const credits = () => billing.customerCredits(world.env, world.customer);
 await admin('grant_credit', {amount: 700}); assert.equal(await credits(), 700);
 await admin('remove_credit', {amount: 200}); assert.equal(await credits(), 500);
 await assert.rejects(() => admin('remove_credit', {amount: 501}));
 // 失効: 期限を過ぎた購入分だけを取り消す
 const at = now();
 world.raw.prepare("INSERT INTO supporter_credit_lots(id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at) VALUES(?,?,'purchase','cs_e2e',300,300,?,'active',?,?)").run(`lot-${randomUUID()}`, world.uid, at - 10, at - 100, at - 100);
 assert.equal((await world.cron(at)).expiredCredits, 1); assert.equal(await credits(), 200);
 assert.match((await admin('create_payment_link', {amount: 500, description: '通し試験'})).url, /^https:\/\/checkout\.stripe\.com\//);
 await world.subscribe('supporter');
 await admin('change_subscription', {plan: 'plus', channelPacks: 1, serverPacks: 0, rulePacks: 0}); await world.settle();
 let state = (await world.act('status')).body.subscriptions[0];
 assert.deepEqual([state.planId, state.channelPacks], ['plus', 1]);
 await admin('cancel_at_period_end'); await world.settle();
 assert.equal((await world.act('status')).body.subscriptions[0].cancelAtPeriodEnd, true);
 await admin('cancel_immediately'); await world.settle();
 assert.equal(await world.rules(), 0);
 await world.subscribe('pro'); await admin('grant_credit', {amount: 300});
 const result = await billing.adminDisciplinaryBillingAction(world.env, world.customer, world.uid, {action: 'disciplinary_cancel', requestId: randomUUID(), reason: '通し試験の処分'}); await world.settle();
 assert.equal(result.canceledSubscriptions, 1); assert.equal(await credits(), 0); assert.equal(await world.rules(), 0);
 const open = await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0}); assert.equal(open.status, 200, JSON.stringify(open.body));
 assert.equal(await billing.expireSupporterPendingCheckouts(world.env, world.db, world.uid, randomUUID()), 1);
});

test('通知: ほかの試験に無い種類（チャージ失敗・不正の警告・解約予約の取り消し・月の途中の停止・処分）', async () => {
 const world = await World.create({clock: false});
 await world.subscribe('supporter');
 const send = (type, object, previous) => world.deliver({id: `evt_e2e${randomUUID().replaceAll('-', '')}`, type, livemode: false, created: now(), data: {object, previous_attributes: previous}});
 const requestId = randomUUID(), at = now();
 world.raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,checkout_session_id,amount,currency,status,created_at,updated_at) VALUES(?,?,?,?,500,'jpy','pending',?,?)`).run(requestId, world.uid, world.customer, `cs_test_fail${requestId}`, at, at);
 await send('checkout.session.async_payment_failed', {id: `cs_test_fail${requestId}`, mode: 'payment', payment_status: 'unpaid', customer: world.customer, amount_total: 500, currency: 'jpy', metadata: {dpi_checkout_kind: 'credit_topup', dpi_user: world.uid}});
 const charge = (await stripe('GET', `charges?customer=${world.customer}&limit=1`)).data[0];
 await send('radar.early_fraud_warning.created', {id: `issfr_${randomUUID()}`, charge: charge.id});
 const sub = await world.sub();
 await stripe('POST', `subscriptions/${sub.id}`, {cancel_at_period_end: 'true'}); await world.settle();
 await stripe('POST', `subscriptions/${sub.id}`, {cancel_at_period_end: 'false'}); await world.settle();
 assert.ok(!world.kinds().includes('topup_failed'), 'チャージの Discord 通知が作られた');
 for (const kind of ['fraud_warning', 'leave_reserved', 'leave_reserved_canceled']) assert.ok(world.kinds().includes(kind), `${kind}: ${world.kinds()}`);
 // 月の途中の停止（督促の行だけを作る。請求書は無いので Stripe 側は変わらない）
 world.raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,retry_attempted_at,suspend_at,updated_at) VALUES('in_e2e_stop',?,NULL,300,'jpy','suspend_scheduled',1,1,1,?,1)`).run(world.customer, at - 10);
 const [year, month] = jstParts(at);
 await world.cron(jst(year, month + 1, 10, 12));
 assert.ok(world.kinds().includes('stop'), `stop: ${world.kinds()}`);
 for (const kind of ['disciplinary_cancel', 'ban_account', 'unban_account'])
  assert.equal(await billing.sendSupporterDisciplinaryNotification(world.env, world.db, kind, {requestId: randomUUID(), uid: world.uid, email: 'e2e@example.com', reason: '通し試験のお知らせ（実際の処分ではありません）', canceledSubscriptions: 1, confiscatedCredits: 0}), true);
 assert.ok(world.mails.some(subject => subject.includes('チャージ失敗')), `メール: ${world.mails}`);
});

const financialState = async world => ({
 subscriptions: (await world.subs()).filter(item => !['canceled', 'incomplete_expired'].includes(item.status)).length,
 invoices: (await stripe('GET', `invoices?customer=${world.customer}&limit=100`)).data,
 credits: await billing.customerCredits(world.env, world.customer),
});
const assertUniqueInvoices = invoices => assert.equal(new Set(invoices.map(item => item.id)).size, invoices.length, '請求書が重複している');

test('事例: 定期処理の二重起動', async () => {
 const world = await World.create(), previousFetch = globalThis.fetch;
 let payRequests = 0;
 try {
  globalThis.fetch = async (input, init) => {
   const url = new URL(typeof input === 'string' ? input : input.url);
   if (url.hostname === 'api.stripe.com' && /\/invoices\/[^/]+\/pay$/u.test(url.pathname)) payRequests += 1;
   return previousFetch(input, init);
  };
  const {schedule} = await world.subscribe('supporter');
  await world.useCard('pm_card_chargeCustomerFail');
  await world.advance(renewal(schedule.anchor)); await world.settle();
  const times = dunningTimes(schedule.anchor);
  await Promise.all([world.cron(schedule.anchor + 12 * 3600), world.cron(schedule.anchor + 12 * 3600)]);
  await world.advance(times.retry); await Promise.all([world.cron(times.retry), world.cron(times.retry)]); await world.settle();
  await world.advance(times.stop); await Promise.all([world.cron(times.stop), world.cron(times.stop)]);
  await world.advance(times.cancel); await Promise.all([world.cron(times.cancel), world.cron(times.cancel)]); await world.settle();
  const state = await financialState(world); assertUniqueInvoices(state.invoices);
  assert.equal(payRequests, 1); assert.equal(state.subscriptions, 0); assert.equal(state.credits, 0);
  assert.equal(world.dunning().length, 1); assert.equal(world.dunning()[0].status, 'closed');
  // 1日0時の通知は、停止した月と自動解約した月の 2 回
  assert.equal(world.kinds().filter(value => value === 'month_start').length, 2, '月初の通知が二重');
  for (const kind of ['renewal_result', 'retry_start', 'retry_result']) assert.equal(world.kinds().filter(value => value === kind).length, 1, `${kind} が二重`);
  assert.equal(world.mails.filter(subject => subject.includes('自動解約')).length, 1);
  assert.equal(new Set(world.mails).size, world.mails.length, `メールが二重: ${world.mails}`);
 } finally { globalThis.fetch = previousFetch; }
});

test('事例: 同時申込み', async () => {
 const world = await World.create({clock: false});
 const input = {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0};
 const [one, two] = await Promise.all([world.act('checkout', {...input, requestId: randomUUID()}), world.act('checkout', {...input, requestId: randomUUID()})]);
 assert.equal(one.status, 200); assert.equal(two.status, 200); assert.equal(one.body.url, two.body.url);
 assert.equal((await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=10`)).data.filter(item => item.status === 'open').length, 1);
 await payInBrowser(one.body.url); await world.settle(6000);
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
}, {browser: true});

test('事例: Webhook の欠落', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('supporter');
 await world.useCard('pm_card_chargeCustomerFail');
 const pump = world.pump; world.pump = async () => 0;
 try { await world.advance(renewal(schedule.anchor)); await world.cron(schedule.anchor + 12 * 3600); }
 finally { world.pump = pump; }
 // 失敗の Webhook が届かなくても、定期処理が支払い不能の契約を見つけ、翌月1日0時の停止を予約する。
 assert.deepEqual(world.dunning().map(row => row.invoice_id.startsWith('hold:')), [true]);
 await world.pump();
 assert.equal(world.dunning().filter(row => !row.invoice_id.startsWith('hold:')).length, 1);
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: Webhook の遅延・順序逆転', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('supporter');
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const invoice = (await stripe('GET', `invoices?customer=${world.customer}&limit=10`)).data.find(item => item.billing_reason === 'subscription_cycle');
 assert.equal(invoice.status, 'paid');
 await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'invoice.payment_failed', livemode: false, created: invoice.created - 1, data: {object: {...invoice, status: 'open', amount_remaining: invoice.total}}});
 await world.cron(dunningTimes(schedule.anchor).stop);
 const state = await financialState(world); assert.equal(await world.rules(), 1); assert.equal(state.subscriptions, 1); assert.equal(world.dunning().length, 0); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: メールの失敗', async () => {
 const world = await World.create({clock: false}); let fail = true, sent = 0;
 world.env.NOTICE_EMAIL = {send: async () => { if (fail) throw new Error('e2e mail outage'); sent += 1; }};
 const amount = billing.selection({plan: 'supporter'}).monthly * billing.billingSchedule(Date.now()).initialMonths;
 const intent = await stripe('POST', 'payment_intents', {amount: String(amount), currency: 'jpy', customer: world.customer, payment_method: 'pm_card_visa', confirm: 'true', setup_future_usage: 'off_session', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'});
 const session = {id: `cs_test_e2e${randomUUID().replaceAll('-', '')}`, mode: 'payment', status: 'complete', payment_status: 'paid', customer: world.customer, client_reference_id: world.uid, payment_intent: intent.id, amount_total: amount, currency: 'jpy', created: now(), metadata: {dpi_checkout_kind: 'initial_subscription', dpi_user: world.uid, dpi_plan: 'supporter', dpi_channel_packs: '0', dpi_server_packs: '0', dpi_rule_packs: '0', dpi_billing_anchor: String(billing.billingSchedule(Date.now()).anchor), dpi_legal_consent_version: 'e2e'}};
 const response = await world.deliverResponse({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}});
 assert.equal(response.status, 200, '修正中仕様: メール例外でも Webhook は 200');
 assert.equal(await world.rules(), 1); assert.equal(world.raw.prepare('SELECT COUNT(*) AS n FROM supporter_stripe_events').get().n, 1);
 fail = false;
 const previousFetch = globalThis.fetch;
 try {
  globalThis.fetch = (input, init) => new URL(typeof input === 'string' ? input : input.url).pathname === `/v1/checkout/sessions/${session.id}` ? Promise.resolve(Response.json(session)) : previousFetch(input, init);
  await world.cron(); assert.equal(sent, 1); await world.cron(); assert.equal(sent, 1, '2 回送った');
 } finally { globalThis.fetch = previousFetch; }
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: Discord の失敗', async () => {
 const world = await World.create({clock: false}), previousFetch = globalThis.fetch;
 world.env.MEMBERSHIP_NOTICE_WEBHOOK = `https://discord.com/api/webhooks/12345678901234567/${'x'.repeat(30)}`;
 let attempts = 0;
 try {
  globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url); if (url.hostname === 'discord.com') { attempts += 1; if (attempts === 1) throw new TypeError('e2e network failure'); return new Response(null, {status: attempts === 2 ? 500 : 204}); } return previousFetch(input, init); };
  await world.subscribe('supporter'); assert.equal(await world.rules(), 1);
  assert.equal(world.raw.prepare("SELECT status FROM supporter_ops_notices WHERE kind='join'").get().status, 'pending');
  await world.cron(); assert.equal(world.raw.prepare("SELECT status FROM supporter_ops_notices WHERE kind='join'").get().status, 'pending');
  await world.cron(); assert.equal(world.raw.prepare("SELECT status FROM supporter_ops_notices WHERE kind='join'").get().status, 'sent');
  const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
 } finally { globalThis.fetch = previousFetch; }
});

test('事例: カードの削除', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('supporter');
 const method = (await world.sub()).default_payment_method; assert.match(method, /^pm_/);
 await stripe('POST', `payment_methods/${method}/detach`);
 await world.advance(renewal(schedule.anchor)); await world.settle();
 assert.equal(world.dunning()[0]?.status, 'retry_scheduled');
 const good = await world.useCard('pm_card_visa'); const invoice = world.dunning()[0]; await stripe('POST', `invoices/${invoice.invoice_id}/pay`, {payment_method: good}); await world.settle();
 const state = await financialState(world); assert.equal(await world.rules(), 1); assert.equal(state.subscriptions, 1); assert.equal(world.dunning()[0].status, 'paid'); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: クレジットの一部充当', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('supporter');
 await billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'grant_credit', amount: 100, requestId: randomUUID(), reason: '一部充当試験'});
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const invoice = (await stripe('GET', `invoices?customer=${world.customer}&limit=10`)).data.find(item => item.billing_reason === 'subscription_cycle');
 assert.equal(invoice.total, 300); assert.equal(invoice.amount_paid, 200); assert.equal(await billing.customerCredits(world.env, world.customer), 0);
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices);
});

test('事例: クレジットの期限切れ', async () => {
 const world = await World.create({clock: false}), at = now();
 world.raw.prepare("INSERT INTO supporter_credit_lots(id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run('used', world.uid, 'purchase', 'pi_used', 300, 0, at - 1, 'consumed', at - DAY, at - DAY);
 world.raw.prepare("INSERT INTO supporter_credit_lots(id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run('active', world.uid, 'purchase', 'pi_active', 200, 200, at + 1, 'active', at - DAY, at - DAY);
 await billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'grant_credit', amount: 200, requestId: randomUUID(), reason: '期限切れの試験'});
 assert.equal((await world.cron(at)).expiredCredits, 0); assert.equal((await world.cron(at + 2)).expiredCredits, 1); assert.equal((await world.cron(at + 3)).expiredCredits, 0);
 assert.equal(world.raw.prepare("SELECT status FROM supporter_credit_lots WHERE id='used'").get().status, 'consumed');
 const state = await financialState(world); assert.equal(state.subscriptions, 0); assert.equal(state.invoices.length, 0); assert.equal(state.credits, 0);
});

test('事例: 返金', async () => {
 const world = await World.create({clock: false});
 await payInBrowser((await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0})).body.url); await world.settle(6000);
 const total = billing.billingSchedule(Date.now()).initialMonths * 300;
 const intent = {id: (await stripe('GET', `payment_intents?customer=${world.customer}&limit=5`)).data.find(item => item.amount === total && item.status === 'succeeded').id};
 await billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'refund_latest', amount: 100, requestId: randomUUID(), reason: '一部返金の試験'}); await world.settle();
 await billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'refund_latest', amount: total - 100, requestId: randomUUID(), reason: '残額返金の試験'}); await world.settle();
 await assert.rejects(() => billing.adminBillingAction(world.env, world.customer, world.uid, {action: 'refund_latest', amount: 1, requestId: randomUUID(), reason: '三回目の返金の試験'}));
 assert.equal((await stripe('GET', `payment_intents/${intent.id}`)).amount_received, total);
 const requestId = randomUUID(), at = now();
 world.raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,amount,currency,status,created_at,updated_at) VALUES(?,?,?,500,'jpy','pending',?,?)`).run(requestId, world.uid, world.customer, at, at);
 const topup = await world.pay(500, {dpi_checkout_kind: 'credit_topup', dpi_credit_amount: '500', dpi_topup_request_id: requestId});
 await stripe('POST', 'refunds', {payment_intent: topup.intent.id, amount: '200'}); await world.settle();
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 300, 'チャージの一部返金だけ残高から差し引く');
}, {browser: true});

test('事例: 申込日の境目', async () => {
 const cases = [[2027, 0, 25, 1, 2027, 0, 26], [2027, 0, 26, 2, 2027, 1, 26], [2027, 0, 27, 2, 2027, 1, 26], [2027, 11, 31, 2, 2028, 0, 26], [2028, 1, 29, 2, 2028, 2, 26], [2027, 1, 28, 2, 2027, 2, 26]];
 for (const [year, month, day, months, ay, am, ad] of cases) { const value = billing.billingSchedule(jst(year, month, day, 12) * 1000); assert.equal(value.initialMonths, months); assert.equal(value.anchor, jst(ay, am, ad)); }
 for (const [year, month, last] of [[2027, 1, 28], [2028, 1, 29], [2027, 3, 30], [2027, 0, 31]]) assert.equal(billing.dunningSchedule(jst(year, month, 26)).retryAt, jst(year, month, last, 12));
});

const reserveIn = world => async plan => {
 const choice = {plan, channelPacks: 0, serverPacks: 0, rulePacks: 0}, preview = await world.act('preview-update', choice);
 return world.act('update', {...choice, requestId: randomUUID(), prorationDate: preview.body.prorationDate, expectedCreditApplied: preview.body.creditApplied, useCredits: preview.body.creditApplied > 0});
};
test('事例: 変更の予約中の解約（契約管理画面の実操作）', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('pro');
 assert.equal((await reserveIn(world)('plus')).status, 200); await world.settle();
 const text = await cancelInPortal((await world.act('portal')).body.url); await world.settle(6000);
 const item = (await world.act('status')).body.subscriptions[0];
 assert.equal(item.cancelAtPeriodEnd, true, `解約が予約されていない: ${text.slice(0, 600)}`);
 const before = (await financialState(world)).invoices.length;
 await world.advance(renewal(schedule.anchor)); await world.settle();
 const state = await financialState(world); assert.equal(state.subscriptions, 0, '解約後も契約が残っている'); assert.equal(state.invoices.length, before, '解約後に請求された'); assert.equal(await world.rules(), 0);
}, {browser: true});

test('事例: 変更の予約中の未払い、解約予約中の変更', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('pro');
 assert.equal((await reserveIn(world)('plus')).status, 200);
 await world.useCard('pm_card_chargeCustomerFail'); await world.advance(renewal(schedule.anchor)); await world.settle();
 const row = world.dunning().find(item => !item.invoice_id.startsWith('hold:'));
 assert.equal(row?.amount_due, 800, '変更の適用時の未払いを、変更後の料金で記録する');
 const good = await world.useCard('pm_card_visa'); await stripe('POST', `invoices/${row.invoice_id}/pay`, {payment_method: good}); await world.settle();
 const sub = await world.sub(); if (sub.schedule) await stripe('POST', `subscription_schedules/${sub.schedule}/release`, {});
 await stripe('POST', `subscriptions/${sub.id}`, {cancel_at_period_end: 'true'}); await world.settle();
 const changed = await reserveIn(world)('supporter').catch(error => ({status: error.status || 0, body: {message: error.message}})), state = await financialState(world);
 assert.equal(changed.status, 409);
 const preview = await world.act('preview-update', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0});
 assert.equal(preview.status, 409); assert.match(preview.body.message, /解約の予約を取り消して/);
 assert.equal((await world.act('status')).body.subscriptions[0].cancelAtPeriodEnd, true, '変更で解約の予約が消えた');
 assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: 停止中（未払い）', async () => {
 const world = await World.create(); const {schedule} = await world.subscribe('supporter'); await world.useCard('pm_card_chargeCustomerFail');
 await world.advance(renewal(schedule.anchor)); await world.settle(); const times = dunningTimes(schedule.anchor); await world.advance(times.retry); await world.cron(times.retry); await world.advance(times.stop); await world.cron(times.stop);
 // チャージは停止中も使える（決定済み。時刻を進めているため、ここでは支払い画面を作れない）。変更で停止が解けないことを確かめる。
 const changed = await reserveIn(world)('plus').catch(error => ({status: error.status || 0, body: {message: error.message}})); await world.settle();
 console.log(`  停止中の変更: ${changed.status} ${String(changed.body.message || '').slice(0, 80)}`);
 assert.equal(await world.rules(), 0, '停止中の変更で配信が再開した');
 assert.notEqual(world.dunning().find(row => !row.invoice_id.startsWith('hold:')).status, 'paid');
 assert.equal((await world.act('portal')).status, 200, '解約用の契約管理だけは可能');
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: アカウント', async () => {
 const world = await World.create({clock: false}); await world.subscribe('supporter');
 const email = `changed-${world.uid}@example.com`; await world.deliver({id: `evt_e2e${randomUUID()}`, type: 'customer.updated', livemode: false, created: now(), data: {object: {id: world.customer, email}}});
 assert.equal(world.raw.prepare('SELECT billing_email FROM supporter_accounts WHERE discord_user_id=?').get(world.uid).billing_email, email);
 // 退会・削除の処理は supporter-billing.js / supporter.js に存在しないため、ここでは契約が残ることを固定する。
 const state = await financialState(world); assert.equal(state.subscriptions, 1); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
});

test('事例: 顧客の取り違え', async () => {
 const world = await World.create({clock: false}), other = (await stripe('POST', 'customers', {name: 'other', 'metadata[dpi_user]': '999999999999999999'})).id; plainCustomers.push(other);
 const intent = await stripe('POST', 'payment_intents', {amount: '300', currency: 'jpy', customer: other, payment_method: 'pm_card_visa', confirm: 'true', setup_future_usage: 'off_session', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'});
 const session = {id: `cs_test_e2e${randomUUID().replaceAll('-', '')}`, mode: 'payment', status: 'complete', payment_status: 'paid', customer: other, client_reference_id: world.uid, payment_intent: intent.id, amount_total: 300, currency: 'jpy', created: now(), metadata: {dpi_checkout_kind: 'initial_subscription', dpi_user: world.uid, dpi_plan: 'supporter', dpi_channel_packs: '0', dpi_server_packs: '0', dpi_rule_packs: '0', dpi_billing_anchor: String(billing.billingSchedule(Date.now()).anchor), dpi_legal_consent_version: 'e2e'}};
 await assert.rejects(() => world.deliverResponse({id: `evt_e2e${randomUUID()}`, type: 'checkout.session.completed', livemode: false, created: now(), data: {object: session}}), /利用者を確認できません/);
 assert.equal((await stripe('GET', `subscriptions?customer=${other}&status=all&limit=10`)).data.length, 0, '他人の customer に契約を作ってはならない');
 const state = await financialState(world); assert.equal(state.subscriptions, 0); assert.equal(state.invoices.length, 0); assert.equal(state.credits, 0);
});

test('事例: Stripe の一時障害', async () => {
 const world = await World.create({clock: false}), cronWorld = await World.create(), previousFetch = globalThis.fetch; let failures = 0, payFailures = 0;
 const {schedule} = await cronWorld.subscribe('supporter'); await cronWorld.useCard('pm_card_chargeCustomerFail'); await cronWorld.advance(renewal(schedule.anchor)); await cronWorld.settle();
 try {
  globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url); if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/checkout/sessions' && failures < 2) { failures += 1; if (failures === 2) throw new DOMException('e2e timeout', 'TimeoutError'); return new Response(JSON.stringify({error: {message: 'temporary'}}), {status: 500, headers: {'content-type': 'application/json'}}); } if (url.hostname === 'api.stripe.com' && /\/invoices\/[^/]+\/pay$/u.test(url.pathname) && payFailures++ === 0) return new Response(JSON.stringify({error: {message: 'temporary'}}), {status: 500, headers: {'content-type': 'application/json'}}); return previousFetch(input, init); };
  const input = {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0, requestId: randomUUID()};
  await assert.rejects(() => world.act('checkout', input));
  await assert.rejects(() => world.act('checkout', input));
  const recovered = await world.act('checkout', input); assert.equal(recovered.status, 200);
  assert.equal((await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=10`)).data.length, 1);
  const state = await financialState(world); assert.equal(state.subscriptions, 0); assertUniqueInvoices(state.invoices); assert.equal(state.credits, 0);
  await cronWorld.useCard('pm_card_visa'); const retryAt = cronWorld.dunning()[0].retry_at;
  await cronWorld.cron(retryAt); assert.equal(cronWorld.dunning()[0].status, 'retry_scheduled');
  await cronWorld.cron(retryAt + 1); await cronWorld.settle();
  const cronState = await financialState(cronWorld); assert.equal(cronWorld.dunning()[0].status, 'paid'); assert.equal(cronState.subscriptions, 1); assertUniqueInvoices(cronState.invoices); assert.equal(cronState.credits, 0);
 } finally { globalThis.fetch = previousFetch; }
});

test('事例: チャージの支払い方法', async () => {
 const world = await World.create({clock: false});
 const topup = await world.act('topup', {amount: 500, requestId: randomUUID()}); assert.equal(topup.status, 200);
 const session = (await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=10`)).data.find(item => item.url === topup.body.url);
 for (const type of ['card', 'customer_balance', 'konbini', 'paypay']) assert.ok(session.payment_method_types.includes(type), `${type} が表示されない: ${session.payment_method_types}`);
 const initial = await world.act('checkout', {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0, requestId: randomUUID()}); assert.equal(initial.status, 200);
 const first = (await stripe('GET', `checkout/sessions?customer=${world.customer}&limit=10`)).data.find(item => item.url === initial.body.url);
 for (const type of ['customer_balance', 'konbini', 'paypay']) assert.ok(!first.payment_method_types.includes(type), `毎月の課金に使えない ${type} が表示された`);
});

// 銀行振込・コンビニ払い: 入金前は付与しない → 入金で 1 回だけ付与 → クレジットで申し込める。期限切れなら付与しない。
const delayedTopup = async (world, kind, amount = 700) => {
 const requestId = randomUUID(), at = now();
 world.raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,amount,currency,status,created_at,updated_at) VALUES(?,?,?,?,'jpy','pending',?,?)`).run(requestId, world.uid, world.customer, amount, at, at);
 const metadata = {dpi_checkout_kind: 'credit_topup', dpi_user: world.uid, dpi_credit_amount: String(amount), dpi_topup_request_id: requestId, dpi_legal_consent_version: 'e2e'};
 const common = {amount: String(amount), currency: 'jpy', customer: world.customer, confirm: 'true', 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never'};
 const intent = kind === 'bank'
  ? await stripe('POST', 'payment_intents', {...common, 'payment_method_data[type]': 'customer_balance', 'payment_method_options[customer_balance][funding_type]': 'bank_transfer', 'payment_method_options[customer_balance][bank_transfer][type]': 'jp_bank_transfer'})
  : await stripe('POST', 'payment_intents', {...common, 'payment_method_data[type]': 'konbini', 'payment_method_data[billing_details][name]': 'E2E TEST', 'payment_method_data[billing_details][email]': kind});
 const session = {id: `cs_test_e2e${randomUUID().replaceAll('-', '')}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'unpaid', livemode: false, customer: world.customer, client_reference_id: world.uid, payment_intent: intent.id, amount_total: amount, currency: 'jpy', created: at, metadata};
 const send = (type, change = {}, created = now()) => world.deliver({id: `evt_e2e${randomUUID().replaceAll('-', '')}`, type, livemode: false, created, data: {object: {...session, ...change}}});
 world.raw.prepare('UPDATE supporter_credit_topups SET checkout_session_id=? WHERE request_id=?').run(session.id, requestId);
 const row = () => world.raw.prepare('SELECT * FROM supporter_credit_topups WHERE request_id=?').get(requestId);
 const wait = async status => { for (let i = 0; i < 30; i += 1) { const value = await stripe('GET', `payment_intents/${intent.id}`); if (value.status === status) return value; await sleep(2000); } throw new Error(`支払いが ${status} になりません`); };
 return {session, intent, send, row, wait};
};
test('事例: 銀行振込は入金を確認してから付与する', async () => {
 const world = await World.create({clock: false}), topup = await delayedTopup(world, 'bank');
 assert.equal(topup.intent.status, 'requires_action');
 await topup.send('checkout.session.completed');
 assert.equal(await billing.customerCredits(world.env, world.customer), 0, '入金前に付与された'); assert.equal(topup.row().status, 'pending'); assert.equal(world.mails.length, 0);
 const choice = {plan: 'supporter', channelPacks: 0, serverPacks: 0, rulePacks: 0};
 // 一部だけの入金では付与しない
 await stripe('POST', `test_helpers/customers/${world.customer}/fund_cash_balance`, {amount: '300', currency: 'jpy'}); await sleep(5000);
 assert.notEqual((await stripe('GET', `payment_intents/${topup.intent.id}`)).status, 'succeeded', '一部の入金で完了した');
 assert.equal(await billing.customerCredits(world.env, world.customer), 0);
 await stripe('POST', `test_helpers/customers/${world.customer}/fund_cash_balance`, {amount: '400', currency: 'jpy'});
 await topup.wait('succeeded');
 await topup.send('checkout.session.async_payment_succeeded', {payment_status: 'paid'}); await topup.send('checkout.session.async_payment_succeeded', {payment_status: 'paid'});
 assert.equal(await billing.customerCredits(world.env, world.customer), 700, '付与が 1 回でない'); assert.equal(topup.row().status, 'credited');
 assert.equal(world.mails.filter(subject => subject.includes('チャージ完了')).length, 1);
 assert.ok(!world.kinds().some(kind => kind.startsWith('topup')), 'チャージの Discord 通知が作られた');
 if (billing.billingSchedule(Date.now()).initialMonths * 300 <= 700) {
  const signed = await world.act('checkout', {...choice, useCredits: true, requestId: randomUUID()}); assert.equal(signed.status, 200, JSON.stringify(signed.body)); await world.settle();
  assert.equal(await world.rules(), 1, '入金後のクレジットで利用を開始できない');
 }
});
test('事例: コンビニ払いは入金を確認してから付与する。期限切れは付与しない', async () => {
 const world = await World.create({clock: false}), paid = await delayedTopup(world, 'succeed_immediately@example.com');
 await paid.send('checkout.session.completed');
 assert.equal(await billing.customerCredits(world.env, world.customer), 0, '入金前に付与された');
 await paid.wait('succeeded'); await paid.send('checkout.session.async_payment_succeeded', {payment_status: 'paid'});
 assert.equal(await billing.customerCredits(world.env, world.customer), 700);
 const expired = await delayedTopup(world, 'expire_immediately@example.com');
 await expired.send('checkout.session.completed'); await expired.wait('requires_payment_method');
 await expired.send('checkout.session.async_payment_failed');
 assert.equal(expired.row().status, 'failed'); assert.equal(await billing.customerCredits(world.env, world.customer), 700);
 assert.equal(world.mails.filter(subject => subject.includes('チャージ失敗')).length, 1);
 assert.ok(!world.kinds().some(kind => kind.startsWith('topup')));
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
  const state = await siteState();
  if (!state || (state.mode !== 'live' && state.published && state.intakePaused !== true)) throw new Error('本番サイトがテストモードで受付中のため、送信先を止められません。');
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
 for (const id of plainCustomers) await stripe('DELETE', `customers/${id}`).catch(() => {});
 await closeBrowser();
 if (notify) {
  for (const [label, map] of [['メール（ユーザー向け）', delivered.mail], ['メール（管理者向け）', delivered.admin], ['Discord', delivered.discord]]) {
   logs(`\n${label}: ${[...map.values()].filter(value => value === 'sent').length}／${map.size} 種類を送信`);
   for (const [key, value] of map) logs(` ${value === 'sent' ? '✔' : '✖'} ${key}${value === 'sent' ? '' : `（${value}）`}`);
  }
 }
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
