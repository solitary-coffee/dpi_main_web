// Stripe のテストサンドボックス（または通常のテストモード）に、有料プランに必要な設定を一括で作る。
//
//   node scripts/stripe-sandbox-setup.mjs
//
// 1. サンドボックスのシークレットキー（sk_test_... / rk_test_...）を入力する（画面には表示しない）。
// 2. 次を作成する（同じキーで再実行しても料金は重複して作らない）。
//    - 月額の料金 4 つ（BASIC 300 円・Plus 800 円・Pro 1,280 円・追加オプション 200 円、税込・JPY）
//    - カスタマーポータルの設定（支払い方法の変更・請求履歴・期間末解約。プラン変更は無効）
//    - Webhook の送信先（https://dpi-bot.com/api/supporter/stripe/webhook、15 イベント）
//    - 既定の支払い方法の設定で、設定できる支払い方法をすべて有効化（PayPay を含む）
// 3. wrangler.jsonc の料金 ID・ポータル ID を書き換え、Worker Secrets の
//    STRIPE_SECRET_KEY と STRIPE_WEBHOOK_SECRET を登録する（値は画面に出さない）。
// 本番キー（sk_live_ / rk_live_）は受け付けない。
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const STRIPE_VERSION = '2026-09-30.endive'; // worker/supporter-billing.js と同じ
const ORIGIN = 'https://dpi-bot.com';
const WEBHOOK_URL = `${ORIGIN}/api/supporter/stripe/webhook`;
const EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
 'checkout.session.expired', 'customer.updated', 'customer.subscription.created', 'customer.subscription.updated',
 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created',
 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'radar.early_fraud_warning.created'];
const PRICES = [
 ['STRIPE_PRICE_SUPPORTER', 'dpi_supporter_basic_monthly', 'DPI-Bot BASIC プラン', 300],
 ['STRIPE_PRICE_PLUS', 'dpi_supporter_plus_monthly', 'DPI-Bot Plus プラン', 800],
 ['STRIPE_PRICE_PRO', 'dpi_supporter_pro_monthly', 'DPI-Bot Pro プラン', 1280],
 ['STRIPE_PRICE_ADDON', 'dpi_supporter_addon_monthly', 'DPI-Bot 追加オプション（1パック）', 200],
];

function askHidden(question) {
 if (process.env.STRIPE_SANDBOX_KEY) return Promise.resolve(process.env.STRIPE_SANDBOX_KEY.trim());
 return new Promise(resolve => {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
  rl.stdoutMuted = false;
  rl._writeToOutput = text => { if (!rl.stdoutMuted) process.stdout.write(text); };
  rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  rl.stdoutMuted = true;
 });
}

let KEY = '';
async function stripe(method, apiPath, params) {
 const body = params ? new URLSearchParams(params) : undefined;
 const response = await fetch(`https://api.stripe.com/v1/${apiPath}`, {
  method, body,
  headers: {Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_VERSION,
   ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
 });
 const data = await response.json().catch(() => ({}));
 if (!response.ok) {
  const message = data?.error?.message || `HTTP ${response.status}`;
  throw new Error(`Stripe API（${method} ${apiPath}）でエラー: ${message}`);
 }
 return data;
}

function putSecret(name, value) {
 const result = spawnSync('npx', ['--yes', 'wrangler@4.157.0', 'secret', 'put', name], {
  cwd: root, input: value, encoding: 'utf8', shell: process.platform === 'win32',
 });
 if (result.status !== 0) throw new Error(`${name} の登録に失敗しました: ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
}

// 既定の支払い方法の設定（Checkout がコードで方法を指定しないときに使われる）で、
// 設定できる支払い方法をすべて「オン」にする。実際に表示されるかは Stripe が決済ごとに判断する
// （例：PayPay は 1 回払いのクレジットチャージでは表示、次回以降の自動課金が必要なプラン申込みでは非表示）。
async function enableAllPaymentMethods() {
 const list = await stripe('GET', 'payment_method_configurations?limit=100');
 const config = (list.data || []).find(item => item.is_default && !item.parent) || (list.data || []).find(item => item.is_default);
 if (!config) {
  console.log('注意: 既定の支払い方法の設定が見つかりません。ダッシュボードの「設定 → 支払い方法」で有効化してください。');
  return;
 }
 const enabled = [], failed = [];
 for (const [method, value] of Object.entries(config)) {
  if (!value || typeof value !== 'object' || !value.display_preference) continue;
  if (value.display_preference.value === 'on') { enabled.push(method); continue; }
  try {
   await stripe('POST', `payment_method_configurations/${config.id}`, {[`${method}[display_preference][preference]`]: 'on'});
   enabled.push(method);
  } catch (error) {
   failed.push(`${method}（${error.message.replace(/^.*でエラー: /, '').slice(0, 80)}）`);
  }
 }
 console.log(`有効化: 支払い方法 ${enabled.length} 種類 → ${enabled.join(', ')}`);
 if (enabled.includes('paypay')) console.log('  PayPay は有効です（クレジットチャージなどの 1 回払いで表示されます）。');
 else console.log('  注意: PayPay を有効にできませんでした。ダッシュボードの「設定 → 支払い方法」で確認してください。');
 if (failed.length) console.log(`  有効にできなかったもの（この国・通貨では使えない等）: ${failed.join(' / ')}`);
}

async function main() {
 KEY = await askHidden('Stripe サンドボックスのシークレットキー（sk_test_... / rk_test_...）: ');
 if (/^(?:sk|rk)_live_/.test(KEY)) throw new Error('本番キーは使えません。サンドボックス（テスト）のキーを入力してください。');
 if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(KEY)) throw new Error('キーの形式が正しくありません（sk_test_ または rk_test_ で始まるキー）。');

 const ids = {};
 const found = await stripe('GET', `prices?${new URLSearchParams(PRICES.map(([, lookup]) => ['lookup_keys[]', lookup])).toString()}&limit=10`);
 for (const [env, lookup, name, yen] of PRICES) {
  const existing = (found.data || []).find(price => price.lookup_key === lookup && price.active);
  const price = existing || await stripe('POST', 'prices', {
   currency: 'jpy', unit_amount: String(yen), 'recurring[interval]': 'month', tax_behavior: 'inclusive',
   lookup_key: lookup, 'product_data[name]': name,
  });
  ids[env] = price.id;
  console.log(`${existing ? '既存' : '作成'}: ${name} 月額${yen}円 → ${price.id}`);
 }

 const portal = await stripe('POST', 'billing_portal/configurations', {
  'business_profile[headline]': 'DPI-Bot 有料プランの契約管理',
  default_return_url: `${ORIGIN}/site/supporter/`,
  'features[payment_method_update][enabled]': 'true',
  'features[invoice_history][enabled]': 'true',
  'features[subscription_cancel][enabled]': 'true',
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_cancel][proration_behavior]': 'none',
  'features[subscription_update][enabled]': 'false',
  'features[customer_update][enabled]': 'false',
 });
 ids.STRIPE_PORTAL_CONFIG = portal.id;
 console.log(`作成: カスタマーポータル設定 → ${portal.id}`);

 // 同じ URL の送信先が既にあれば作り直す（署名シークレットは作成時にしか取得できないため）。
 const endpoints = await stripe('GET', 'webhook_endpoints?limit=100');
 for (const endpoint of endpoints.data || []) {
  if (endpoint.url === WEBHOOK_URL) {
   await stripe('DELETE', `webhook_endpoints/${endpoint.id}`);
   console.log(`削除: 既存の Webhook 送信先 ${endpoint.id}（作り直します）`);
  }
 }
 const webhookParams = {url: WEBHOOK_URL, api_version: STRIPE_VERSION, description: 'DPI-Bot 有料プラン（dpi-bot.com）'};
 EVENTS.forEach((event, index) => { webhookParams[`enabled_events[${index}]`] = event; });
 const webhook = await stripe('POST', 'webhook_endpoints', webhookParams);
 console.log(`作成: Webhook 送信先 → ${webhook.id}（${EVENTS.length} イベント）`);

 try { await enableAllPaymentMethods(); }
 catch (error) { console.log(`注意: 支払い方法を有効化できませんでした（${error.message}）。ダッシュボードの「設定 → 支払い方法」で有効にしてください。`); }

 const configPath = path.join(root, 'wrangler.jsonc');
 let config = await readFile(configPath, 'utf8');
 for (const [name, value] of Object.entries(ids)) {
  const pattern = new RegExp(`("${name}"\\s*:\\s*")[^"]*(")`);
  if (!pattern.test(config)) throw new Error(`wrangler.jsonc に ${name} が見つかりません。`);
  config = config.replace(pattern, `$1${value}$2`);
 }
 await writeFile(configPath, config);
 console.log('更新: wrangler.jsonc の料金 ID・ポータル ID');

 putSecret('STRIPE_SECRET_KEY', KEY);
 putSecret('STRIPE_WEBHOOK_SECRET', webhook.secret);
 console.log('登録: Worker Secrets の STRIPE_SECRET_KEY と STRIPE_WEBHOOK_SECRET（値は表示しません）');
 console.log('\n完了しました。wrangler.jsonc の変更を反映（デプロイ）すると、新しいサンドボックスの支払いページに切り替わります。');
}

main().catch(error => { console.error(`\nエラー: ${error.message}`); process.exitCode = 1; });
