// 本番切替の仕組み（モードだけでの切替・途中で止まった申込みの復旧・切替の道具）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { STRIPE_SETTINGS, billingMode, billingReady, liveSettingName, recoverCheckoutState, resolveBillingEnv } from '../worker/supporter-billing.js';
import { PURGE_TABLES, STAGES, purgeSql } from '../scripts/billing-cutover.mjs';
import { EVENTS, PRICES } from '../scripts/stripe-setup-lib.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const testValues = {STRIPE_SECRET_KEY: 'rk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_SUPPORTER: 'price_t1', STRIPE_PRICE_PLUS: 'price_t2', STRIPE_PRICE_PRO: 'price_t3', STRIPE_PRICE_ADDON: 'price_t4', STRIPE_PORTAL_CONFIG: 'bpc_t'};
const liveValues = Object.fromEntries(Object.entries(testValues).map(([name, value]) => [liveSettingName(name), value.replace('test', 'live').replace('_t', '_l')]));

test('決済モードだけで、テスト用と本番用のキー・料金・署名鍵が入れ替わる', () => {
 const both = {...testValues, ...liveValues, OTHER: 'keep', SUPPORTER_BILLING_MODE: 'test'};
 assert.equal(resolveBillingEnv(both), both);
 assert.equal(billingMode(resolveBillingEnv(both)), 'test');
 const live = resolveBillingEnv({...both, SUPPORTER_BILLING_MODE: 'live'});
 assert.equal(billingMode(live), 'live'); assert.equal(billingReady(live), true); assert.equal(live.OTHER, 'keep');
 for (const name of STRIPE_SETTINGS) assert.equal(live[name], liveValues[liveSettingName(name)]);
});

test('本番用の設定が 1 つでも欠けていれば、テスト用で代用せず決済を無効にする', () => {
 for (const missing of STRIPE_SETTINGS) {
  const env = resolveBillingEnv({...testValues, ...liveValues, [liveSettingName(missing)]: '', SUPPORTER_BILLING_MODE: 'live'});
  assert.equal(billingReady(env), false, missing); assert.equal(env[missing], '');
 }
 assert.equal(billingReady(resolveBillingEnv({...testValues, SUPPORTER_BILLING_MODE: 'live'})), false);
 // 本番用の欄にテストキーを入れても動かない
 assert.equal(billingReady(resolveBillingEnv({...testValues, ...liveValues, STRIPE_LIVE_SECRET_KEY: 'rk_test_example', SUPPORTER_BILLING_MODE: 'live'})), false);
});

test('Worker の入口で決済モードを解決する', async () => {
 const source = await read('../worker/index.js');
 assert.match(source, /application\.fetch\(request, resolveBillingEnv\(env\), ctx\)/);
 assert.match(source, /application\.scheduled\(controller, resolveBillingEnv\(env\)\)/);
});

test('公開設定は非公開・テストモードのまま。本番用の欄は用意済みで、キーは書かない', async () => {
 const config = JSON.parse(await read('../wrangler.jsonc'));
 assert.equal(config.vars.SUPPORTER_PUBLIC_ENABLED, 'false');
 for (const [name] of PRICES) assert.ok(liveSettingName(name) in config.vars, name);
 assert.ok('STRIPE_LIVE_PORTAL_CONFIG' in config.vars);
 assert.doesNotMatch(JSON.stringify(config), /(?:sk|rk)_(?:test|live)_|whsec_/);
 for (const values of Object.values(STAGES)) for (const name of Object.keys(values)) assert.ok(name in config.vars, name);
});

test('切替時の削除は有料プランの表をすべて含み、監査ログや二次利用の申請は含まない', async t => {
 let DatabaseSync;
 try { ({DatabaseSync} = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available'); return; }
 const raw = new DatabaseSync(':memory:');
 raw.exec('PRAGMA foreign_keys=ON');
 const dir = new URL('../migrations/', import.meta.url);
 for (const name of (await readdir(dir)).filter(item => item.endsWith('.sql')).sort()) raw.exec(await readFile(new URL(name, dir), 'utf8'));
 const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'supporter_%'").all().map(row => row.name);
 assert.deepEqual([...PURGE_TABLES].sort(), tables.sort());
 // 親子の行があっても、外部キーの順に消せる
 raw.prepare("INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES('1','a@example.jp','x','x')").run();
 raw.prepare("INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES('1','cus')").run();
 raw.prepare("INSERT INTO supporter_credit_lots(id,discord_user_id,source_type,source_id,original_amount,remaining_amount,status,created_at,updated_at) VALUES('l','1','admin','s',1,1,'active',1,1)").run();
 raw.exec(purgeSql());
 for (const name of PURGE_TABLES) assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n, 0, name);
});

test('Webhook の一覧は、Worker が受け付けるイベントと一致する', async () => {
 const source = await read('../worker/supporter-billing.js');
 const allowed = source.match(/const allowed=\[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(value => value.slice(1, -1));
 assert.deepEqual([...EVENTS].sort(), allowed.sort());
});

const env = {SUPPORTER_BILLING_MODE: 'test', ...testValues};
function recoveryDb(row) {
 const state = {row: row && {discord_user_id: '1', customer_id: 'cus_x', ...row}, cleared: 0};
 return {state, prepare(sql) { return {bind() { return this; }, async first() { return sql.includes('FROM supporter_billing') ? state.row : null; }, async all() { return {results: []}; },
  async run() { if (sql.startsWith('UPDATE supporter_billing SET checkout_key=NULL')) state.cleared += 1; return {meta: {changes: 1}}; }}; }};
}
function stripeMock(t, routes) {
 const calls = [], original = globalThis.fetch;
 t.after(() => { globalThis.fetch = original; });
 globalThis.fetch = async (url, init = {}) => {
  const key = `${init.method || 'GET'} ${new URL(url).pathname.replace('/v1/', '')}`; calls.push(key);
  const value = routes[key] ?? {livemode: false, data: []};
  return value.httpStatus ? Response.json({error: {message: 'x'}}, {status: value.httpStatus}) : Response.json(value);
 };
 return calls;
}

test('途中で止まった申込み: 開いたままの支払い画面は失効させてから消す', async t => {
 const db = recoveryDb({checkout_key: 'k', checkout_id: 'cs_1'});
 const calls = stripeMock(t, {'GET checkout/sessions/cs_1': {livemode: false, id: 'cs_1', status: 'open', customer: 'cus_x'}, 'POST checkout/sessions/cs_1/expire': {livemode: false}});
 assert.equal((await recoverCheckoutState(env, db, '1')).changed, 1);
 assert.ok(calls.includes('POST checkout/sessions/cs_1/expire'));
});

test('途中で止まった申込み: 支払いの確認待ち・別の顧客・作成中・Stripeの障害では消さない', async t => {
 const sessions = {cs_wait: {status: 'complete', payment_status: 'unpaid', customer: 'cus_x'}, cs_other: {status: 'open', customer: 'cus_other'}};
 stripeMock(t, {...Object.fromEntries(Object.entries(sessions).map(([id, value]) => [`GET checkout/sessions/${id}`, {livemode: false, id, ...value}])), 'GET checkout/sessions/cs_down': {httpStatus: 500}});
 for (const row of [{checkout_key: 'k', checkout_id: 'cs_wait'}, {checkout_key: 'k', checkout_id: 'cs_other'}, {checkout_key: 'k', checkout_id: 'cs_down'}, {checkout_key: 'k', checkout_params: JSON.stringify({expires_at: Math.floor(Date.now() / 1000) + 600})}]) {
  const db = recoveryDb(row);
  await assert.rejects(() => recoverCheckoutState(env, db, '1'));
  assert.equal(db.state.cleared, 0);
 }
});

test('途中で止まった申込み: 失効済み・存在しないもの・記録なし', async t => {
 stripeMock(t, {'GET checkout/sessions/cs_old': {livemode: false, id: 'cs_old', status: 'expired', customer: 'cus_x'}, 'GET checkout/sessions/cs_gone': {httpStatus: 404}});
 for (const id of ['cs_old', 'cs_gone']) assert.equal((await recoverCheckoutState(env, recoveryDb({checkout_key: 'k', checkout_id: id}), '1')).changed, 1);
 assert.equal((await recoverCheckoutState(env, recoveryDb({checkout_key: 'k', checkout_params: '{}'}), '1')).changed, 1);
 assert.equal((await recoverCheckoutState(env, recoveryDb({}), '1')).changed, 0);
});
