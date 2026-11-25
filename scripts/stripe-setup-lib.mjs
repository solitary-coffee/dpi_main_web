// Stripe の設定（料金・カスタマーポータル・Webhook）の共通部分。
// stripe-sandbox-setup.mjs（テスト）・stripe-live-setup.mjs（本番）・stripe-e2e.mjs（通し試験）から使う。
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const STRIPE_VERSION = '2026-09-30.endive'; // worker/supporter-billing.js と同じ
export const ORIGIN = 'https://dpi-bot.com';
export const WEBHOOK_URL = `${ORIGIN}/api/supporter/stripe/webhook`;
export const WRANGLER = ['--yes', 'wrangler@4.157.0'];
export const EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
 'checkout.session.expired', 'customer.updated', 'customer.subscription.created', 'customer.subscription.updated',
 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created',
 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'radar.early_fraud_warning.created'];
// [設定名, lookup_key, 名前, 月額（税込・円）]。設定名はテスト用。本番用は STRIPE_LIVE_ で始まる。
export const PRICES = [
 ['STRIPE_PRICE_SUPPORTER', 'dpi_supporter_basic_monthly', 'DPI-Bot BASIC プラン', 300],
 ['STRIPE_PRICE_PLUS', 'dpi_supporter_plus_monthly', 'DPI-Bot Plus プラン', 800],
 ['STRIPE_PRICE_PRO', 'dpi_supporter_pro_monthly', 'DPI-Bot Pro プラン', 1280],
 ['STRIPE_PRICE_ADDON', 'dpi_supporter_addon_monthly', 'DPI-Bot 追加オプション（1パック）', 200],
];
export const PORTAL_PARAMS = {
 'business_profile[headline]': 'DPI-Bot 有料プランの契約管理',
 default_return_url: `${ORIGIN}/site/supporter/`,
 'features[payment_method_update][enabled]': 'true',
 'features[invoice_history][enabled]': 'true',
 'features[subscription_cancel][enabled]': 'true',
 'features[subscription_cancel][mode]': 'at_period_end',
 'features[subscription_cancel][proration_behavior]': 'none',
 'features[subscription_update][enabled]': 'false',
 'features[customer_update][enabled]': 'false',
 'metadata[dpi]': 'supporter',
};

export function stripeClient(key) {
 return async (method, apiPath, params, extraHeaders = {}) => {
  const body = params ? new URLSearchParams(params) : undefined;
  let response, data;
  // 混雑・一時的なロック（429）は、処理されていないことが分かっているので少し待ってやり直す。
  for (let attempt = 0; attempt < 6; attempt += 1) {
   response = await fetch(`https://api.stripe.com/v1/${apiPath}`, {
    method, body, signal: AbortSignal.timeout(60000),
    headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, ...extraHeaders,
     ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
   });
   data = await response.json().catch(() => ({}));
   if (response.status !== 429) break;
   await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (!response.ok) throw Object.assign(new Error(`Stripe API（${method} ${apiPath.split('?')[0]}）でエラー: ${data?.error?.message || `HTTP ${response.status}`}`), {status: response.status, code: data?.error?.code});
  return data;
 };
}
export function askHidden(question) {
 return new Promise(resolve => {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
  rl.stdoutMuted = false;
  rl._writeToOutput = text => { if (!rl.stdoutMuted) process.stdout.write(text); };
  rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  rl.stdoutMuted = true;
 });
}
export function ask(question) {
 return new Promise(resolve => {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
 });
}
// 料金は lookup_key で探し、金額・通貨・間隔・税込が一致するものだけを使う（違うものがあれば止める）。
export async function ensurePrices(stripe, log = console.log) {
 const ids = {};
 const found = await stripe('GET', `prices?${new URLSearchParams(PRICES.map(([, lookup]) => ['lookup_keys[]', lookup])).toString()}&limit=20`);
 for (const [name, lookup, title, yen] of PRICES) {
  const existing = (found.data || []).find(price => price.lookup_key === lookup && price.active);
  if (existing && (existing.unit_amount !== yen || existing.currency !== 'jpy' || existing.recurring?.interval !== 'month' || (existing.recurring?.interval_count ?? 1) !== 1 || existing.tax_behavior === 'exclusive'))
   throw new Error(`${title} の料金（${existing.id}）の内容が想定と違います。Stripe で確認してください。`);
  const price = existing || await stripe('POST', 'prices', {currency: 'jpy', unit_amount: String(yen), 'recurring[interval]': 'month', tax_behavior: 'inclusive', lookup_key: lookup, 'product_data[name]': title});
  ids[name] = price.id;
  log(`${existing ? '既存' : '作成'}: ${title} 月額${yen}円 → ${price.id}`);
 }
 return ids;
}
export async function ensurePortal(stripe, log = console.log) {
 const list = await stripe('GET', 'billing_portal/configurations?active=true&limit=100');
 const existing = (list.data || []).find(item => item.metadata?.dpi === 'supporter');
 const portal = existing ? await stripe('POST', `billing_portal/configurations/${existing.id}`, PORTAL_PARAMS) : await stripe('POST', 'billing_portal/configurations', PORTAL_PARAMS);
 log(`${existing ? '更新' : '作成'}: カスタマーポータル設定 → ${portal.id}`);
 return portal.id;
}
export function webhookParams() {
 const params = {url: WEBHOOK_URL, api_version: STRIPE_VERSION, description: 'DPI-Bot 有料プラン（dpi-bot.com）'};
 EVENTS.forEach((event, index) => { params[`enabled_events[${index}]`] = event; });
 return params;
}
export async function findWebhooks(stripe) {
 const list = await stripe('GET', 'webhook_endpoints?limit=100');
 return (list.data || []).filter(endpoint => endpoint.url === WEBHOOK_URL);
}
// 既にある送信先の受信イベントだけを今の一覧にそろえる（署名シークレットは変わらない）。
export async function syncWebhookEvents(stripe, log = console.log) {
 const endpoints = await findWebhooks(stripe);
 if (!endpoints.length) throw new Error('この環境に、有料プランの Webhook 送信先がありません。');
 const params = {};
 EVENTS.forEach((event, index) => { params[`enabled_events[${index}]`] = event; });
 for (const endpoint of endpoints) {
  await stripe('POST', `webhook_endpoints/${endpoint.id}`, params);
  log(`更新: Webhook 送信先 ${endpoint.id} の受信イベント（${EVENTS.length} 種）`);
 }
}
export async function writeConfigValues(values) {
 const configPath = path.join(ROOT, 'wrangler.jsonc');
 let config = await readFile(configPath, 'utf8');
 for (const [name, value] of Object.entries(values)) {
  const pattern = new RegExp(`("${name}"\\s*:\\s*")[^"]*(")`);
  if (!pattern.test(config)) throw new Error(`wrangler.jsonc に ${name} が見つかりません。`);
  config = config.replace(pattern, (_, before, after) => `${before}${value}${after}`);
 }
 await writeFile(configPath, config);
}
export async function readConfigValue(name) {
 const config = await readFile(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
 return config.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1] ?? null;
}
export function wrangler(args, options = {}) {
 return spawnSync('npx', [...WRANGLER, ...args], {cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, ...options});
}
export function putSecret(name, value) {
 const result = wrangler(['secret', 'put', name], {input: value});
 if (result.status !== 0) throw new Error(`${name} の登録に失敗しました: ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
}
