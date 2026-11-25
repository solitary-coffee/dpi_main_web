// 有料プランの本番切替の道具。手順は docs/billing-cutover.md。
//
//   node scripts/billing-cutover.mjs status          … 切替の準備がそろっているかを点検する（読み取りだけ）
//   node scripts/billing-cutover.mjs backup          … 有料プランの表を、リポジトリの外へ控える（個人情報を含む。共有しない）
//   node scripts/billing-cutover.mjs purge           … 控えを取ってから、サイトから申し込んだデバッグ分を消す（切替時に 1 回）
//   node scripts/billing-cutover.mjs switch live     … wrangler.jsonc の決済モードを本番にする（点検に通ったときだけ。反映はマージ時）
//   node scripts/billing-cutover.mjs stage invite    … 受付を開く（許可リストの人だけ）
//   node scripts/billing-cutover.mjs stage public    … 一般公開
//   node scripts/billing-cutover.mjs stage pause     … 受付だけを止める（契約者の解約・支払い方法の変更・配信は続く）
//
// purge は、テストモードで、非公開または受付停止中のときだけ動く。管理操作の監査ログ・二次利用の申請・デバッグ配信の設定は消さない。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRICES, ROOT, ask, readConfigValue, siteState, wrangler, writeConfigValues } from './stripe-setup-lib.mjs';

const DB = 'REUSE_DB';
// 子 → 親の順（外部キー）。
export const PURGE_TABLES = ['supporter_custom_plan_changes', 'supporter_custom_plans', 'supporter_credit_campaign_recipients', 'supporter_credit_campaigns',
 'supporter_credit_events', 'supporter_credit_grants', 'supporter_credit_lots', 'supporter_credit_signups', 'supporter_credit_topups', 'supporter_dunning',
 'supporter_billing_notifications', 'supporter_payment_alerts', 'supporter_ops_notices', 'supporter_disciplinary_actions', 'supporter_stripe_events', 'supporter_billing', 'supporter_accounts'];
export const purgeSql = () => `${PURGE_TABLES.map(name => `DELETE FROM ${name};`).join('\n')}\n`;
export const STAGES = {
 invite: {SUPPORTER_INTAKE_PAUSED: 'false', SUPPORTER_PREVIEW_OPEN: 'false', SUPPORTER_PUBLIC_ENABLED: 'false'},
 public: {SUPPORTER_INTAKE_PAUSED: 'false', SUPPORTER_PREVIEW_OPEN: 'false', SUPPORTER_PUBLIC_ENABLED: 'true'},
 pause: {SUPPORTER_INTAKE_PAUSED: 'true'},
};

function query(sql) {
 const result = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', `"${sql}"`]);
 if (result.status !== 0) throw new Error(`D1 の読み取りに失敗しました: ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
 return JSON.parse(result.stdout.slice(result.stdout.indexOf('[')))[0].results;
}
function counts() {
 const rows = {};
 // D1 の複合 SELECT の上限を超えないように分けて数える。
 for (let index = 0; index < PURGE_TABLES.length; index += 4)
  for (const row of query(PURGE_TABLES.slice(index, index + 4).map(name => `SELECT '${name}' AS name, COUNT(*) AS n FROM ${name}`).join(' UNION ALL '))) rows[row.name] = Number(row.n);
 return rows;
}
async function inspect() {
 const items = [];
 const add = (ok, label, detail = '') => items.push({ok, label, detail});
 const state = await siteState().catch(() => null);
 add(!!state, '本番サイトの状態を取得できる', state ? `${state.published ? '公開' : '非公開'}・モード ${state.mode || '無効'}・受付停止 ${state.intakePaused}・テスト公開 ${state.previewOpen}` : '');
 for (const [name] of PRICES) { const key = name.replace('STRIPE_', 'STRIPE_LIVE_'); const value = await readConfigValue(key); add(/^price_\w+$/.test(value || ''), `${key} が設定済み`); }
 add(/^bpc_\w+$/.test(await readConfigValue('STRIPE_LIVE_PORTAL_CONFIG') || ''), 'STRIPE_LIVE_PORTAL_CONFIG が設定済み');
 const secrets = wrangler(['secret', 'list']);
 const names = secrets.status === 0 ? [...secrets.stdout.matchAll(/"name":\s*"([^"]+)"/g)].map(match => match[1]) : [];
 for (const name of ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_WEBHOOK_SECRET']) add(names.includes(name), `Worker Secrets に ${name} がある`);
 const migrations = wrangler(['d1', 'migrations', 'list', DB, '--remote']);
 add(migrations.status === 0 && /No migrations to apply/.test(migrations.stdout), 'D1 の未適用の移行が無い');
 // 受信済みイベントの番号だけの表は、テスト支払いでも増えるので点検から除く。
 const table = counts(), total = Object.entries(table).reduce((sum, [name, n]) => sum + (['supporter_stripe_events', 'supporter_ops_notices'].includes(name) ? 0 : n), 0);
 add(total === 0, '有料プランの表が空（デバッグ分を削除済み）', total ? Object.entries(table).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join('、') : '');
 const report = JSON.parse(await readFile(path.join(process.env.LOCALAPPDATA || tmpdir(), 'dpi-bot', 'stripe-e2e-report.json'), 'utf8').catch(() => 'null'));
 add(report?.failed === 0 && report?.passed > 0 && report?.skipped === 0, '通し試験に合格している', report ? `${report.finishedAt} 合格 ${report.passed}・失敗 ${report.failed}・未実施 ${report.skipped}` : '記録がありません');
 return {items, state, total};
}
function print(items) { for (const item of items) console.log(`${item.ok ? 'OK' : 'NG'}  ${item.label}${item.detail ? `（${item.detail}）` : ''}`); }
async function backup() {
 const dir = path.join(process.env.LOCALAPPDATA || tmpdir(), 'dpi-bot', `billing-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
 await mkdir(dir, {recursive: true});
 const before = counts();
 for (const name of PURGE_TABLES) {
  const rows = query(`SELECT * FROM ${name}`);
  if (rows.length !== before[name]) throw new Error(`${name} の件数が控えの途中で変わりました。やり直してください。`);
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(rows, null, 1), {mode: 0o600});
 }
 console.log(`控え: ${dir}（個人情報を含みます。共有しないでください）`);
 return {dir, before};
}
async function purge() {
 const state = await siteState();
 if (state?.mode !== 'test' || (state.published && state.intakePaused !== true)) throw new Error('テストモードで、非公開または受付停止中のときだけ削除できます。');
 const {before} = await backup();
 for (const [name, n] of Object.entries(before)) if (n) console.log(`  ${name}: ${n} 件`);
 if (await ask('サイトから申し込んだデバッグ分をすべて削除します。元に戻せません。よければ「削除する」と入力してください: ') !== '削除する') throw new Error('中止しました（何も消していません）。');
 const file = path.join(tmpdir(), `dpi-purge-${process.pid}.sql`);
 await writeFile(file, purgeSql());
 const result = wrangler(['d1', 'execute', DB, '--remote', '--yes', '--file', `"${file}"`]);
 if (result.status !== 0) throw new Error(`削除に失敗しました: ${(result.stderr || result.stdout || '').trim().slice(-400)}`);
 const left = Object.entries(counts()).filter(([, n]) => n);
 if (left.length) throw new Error(`残っている表があります: ${left.map(([name, n]) => `${name} ${n}`).join('、')}`);
 console.log('削除しました（残り 0 件）。デバッグ配信が届くことを確かめてください。');
}
async function main() {
 const [command, value] = process.argv.slice(2);
 if (command === 'status') { const {items} = await inspect(); print(items); process.exitCode = items.every(item => item.ok) ? 0 : 1; return; }
 if (command === 'backup') { await backup(); return; }
 if (command === 'purge') { await purge(); return; }
 if (command === 'switch' && ['live', 'test'].includes(value)) {
  if (value === 'live') {
   const {items, state} = await inspect(); print(items);
   if (!items.every(item => item.ok)) throw new Error('準備がそろっていないため、切り替えません。');
   if (state.published && state.intakePaused !== true) throw new Error('非公開または受付停止のまま切り替えてください。');
  } else if (await ask('契約者がいる状態でテストに戻すと、配信の設定が更新されなくなります。戻してよければ「戻す」と入力してください: ') !== '戻す') throw new Error('中止しました。');
  await writeConfigValues({SUPPORTER_BILLING_MODE: value});
  console.log(`wrangler.jsonc の SUPPORTER_BILLING_MODE を ${value} にしました。PR にしてマージすると反映されます。`);
  return;
 }
 if (command === 'stage' && STAGES[value]) {
  if (value !== 'pause' && (await siteState())?.mode !== 'live') throw new Error('本番モードに切り替わってから受付を開いてください。');
  await writeConfigValues(STAGES[value]);
  console.log(`wrangler.jsonc を ${value} の設定にしました（${Object.entries(STAGES[value]).map(([name, text]) => `${name}=${text}`).join('、')}）。PR にしてマージすると反映されます。`);
  return;
 }
 console.log('使い方: node scripts/billing-cutover.mjs status | backup | purge | switch live | stage invite|public|pause');
 process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'scripts', 'billing-cutover.mjs')) main().catch(error => { console.error(`エラー: ${error.message}`); process.exitCode = 1; });
