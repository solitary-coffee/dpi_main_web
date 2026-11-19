import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';

const ALLOWED = '637850681666961408';
const OUTSIDER = '737850681666961409';
const GUILD_ID = '12345678901234567';
const CHANNEL_ID = '98765432109876543';

function database(rows) {
 return {prepare(sql) {
  if (sql.includes('supporter_custom_plans')) return {async all() { return {results: []}; }};
  return {async all() { return {results: rows}; }};
 }};
}

function account(user, customer, registered) {
 return {
  discord_user_id: user, customer_id: customer, revision: 1, registered_at: registered,
  settings_json: JSON.stringify({rules: [{
   name: '関東の雨雲', guildId: GUILD_ID, channelId: CHANNEL_ID, channelIds: [CHANNEL_ID], type: 'rain-radar',
   region: 'kanto-koshin', radarCondition: 'rainfall-threshold', rainfallThresholdMmPerHour: 10,
   deliveryIntervalHours: 3, conditionLogic: 'and', conditions: [],
  }]}),
 };
}

// ALLOWED は許可リストの利用者（登録はテスト公開後）、OUTSIDER はテスト公開後に登録した外部の人、
// EARLY はテスト公開前から登録済みのアカウント。
const EARLY = '837850681666961400';
const OPENED_AT = '2026-11-19T05:00:00Z';
const rows = [account(ALLOWED, 'cus_allowed', '2026-11-20T00:00:00.000Z'), account(OUTSIDER, 'cus_outsider', '2026-11-19T06:00:00.000Z'), account(EARLY, 'cus_early', '2026-11-04T04:22:10.659Z')];
const loadSubscriptions = async () => new Map([
 ['cus_allowed', [{status: 'active', recognizedPlan: true, planId: 'plus'}]],
 ['cus_outsider', [{status: 'active', recognizedPlan: true, planId: 'plus'}]],
 ['cus_early', [{status: 'active', recognizedPlan: true, planId: 'plus'}]],
]);
const count = async env => (await buildSupporterSnapshot(database(rows), env, loadSubscriptions)).rules.length;

test('テスト公開中は、公開後に登録した外部の人の登録を配信スナップショットに含めない', async () => {
 const preview = {SUPPORTER_PREVIEW_OPEN: 'true', SUPPORTER_PREVIEW_OPENED_AT: OPENED_AT};
 assert.equal(await count({...preview, SUPPORTER_TEST_USER_IDS: ALLOWED}), 2);  // ALLOWED と EARLY
 assert.equal(await count(preview), 1);  // EARLY だけ
});

test('開始時刻が無い・不正なら、許可リストの利用者だけにする', async () => {
 assert.equal(await count({SUPPORTER_PREVIEW_OPEN: 'true'}), 0);
 assert.equal(await count({SUPPORTER_PREVIEW_OPEN: 'true', SUPPORTER_PREVIEW_OPENED_AT: 'invalid', SUPPORTER_TEST_USER_IDS: ALLOWED}), 1);
});

test('テスト公開をしていない間と一般公開後は従来どおり全員を含める', async () => {
 assert.equal(await count({}), 3);
 assert.equal(await count({SUPPORTER_PREVIEW_OPEN: 'true', SUPPORTER_PREVIEW_OPENED_AT: OPENED_AT, SUPPORTER_PUBLIC_ENABLED: 'true'}), 3);
});
