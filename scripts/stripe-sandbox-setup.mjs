// Stripe のテストサンドボックス（または通常のテストモード）に、有料プランに必要な設定を一括で作る。
//
//   node scripts/stripe-sandbox-setup.mjs
//   node scripts/stripe-sandbox-setup.mjs --events-only   … Webhook の受信イベントだけを今の一覧にそろえる
//
// 1. サンドボックスのシークレットキー（sk_test_... / rk_test_...）を入力する（画面には表示しない）。
//    登録済みの通し試験用キーを使うときは --e2e-key を付ける。
// 2. 次を作成する（同じキーで再実行しても料金・ポータル設定は重複して作らない）。
//    - 月額の料金 4 つ（BASIC 300 円・Plus 800 円・Pro 1,280 円・追加オプション 200 円、税込・JPY）
//    - カスタマーポータルの設定（支払い方法の変更・請求履歴・期間末解約。プラン変更は無効）
//    - Webhook の送信先（https://dpi-bot.com/api/supporter/stripe/webhook、15 イベント）
//    - 既定の支払い方法の設定で、設定できる支払い方法をすべて有効化（PayPay を含む）
// 3. wrangler.jsonc の料金 ID・ポータル ID を書き換え、Worker Secrets の
//    STRIPE_SECRET_KEY と STRIPE_WEBHOOK_SECRET を登録する（値は画面に出さない）。
// 本番キー（sk_live_ / rk_live_）は受け付けない。本番用は stripe-live-setup.mjs。
import { e2eKey } from './e2e-key.mjs';
import { EVENTS, askHidden, ensurePortal, ensurePrices, findWebhooks, putSecret, stripeClient, syncWebhookEvents, webhookParams, writeConfigValues } from './stripe-setup-lib.mjs';

let stripe = null;

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
 const key = process.argv.includes('--e2e-key') ? e2eKey() : (process.env.STRIPE_SANDBOX_KEY || '').trim() || await askHidden('Stripe サンドボックスのシークレットキー（sk_test_... / rk_test_...）: ');
 if (/^(?:sk|rk)_live_/.test(key)) throw new Error('本番キーは使えません。サンドボックス（テスト）のキーを入力してください。');
 if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key)) throw new Error('キーの形式が正しくありません（sk_test_ または rk_test_ で始まるキー）。');
 stripe = stripeClient(key);
 if (process.argv.includes('--events-only')) { await syncWebhookEvents(stripe); return; }

 const ids = await ensurePrices(stripe);
 ids.STRIPE_PORTAL_CONFIG = await ensurePortal(stripe);

 // 同じ URL の送信先が既にあれば作り直す（署名シークレットは作成時にしか取得できないため）。
 for (const endpoint of await findWebhooks(stripe)) {
  await stripe('DELETE', `webhook_endpoints/${endpoint.id}`);
  console.log(`削除: 既存の Webhook 送信先 ${endpoint.id}（作り直します）`);
 }
 const webhook = await stripe('POST', 'webhook_endpoints', webhookParams());
 console.log(`作成: Webhook 送信先 → ${webhook.id}（${EVENTS.length} イベント）`);

 try { await enableAllPaymentMethods(); }
 catch (error) { console.log(`注意: 支払い方法を有効化できませんでした（${error.message}）。ダッシュボードの「設定 → 支払い方法」で有効にしてください。`); }

 await writeConfigValues(ids);
 console.log('更新: wrangler.jsonc の料金 ID・ポータル ID');
 putSecret('STRIPE_SECRET_KEY', key);
 putSecret('STRIPE_WEBHOOK_SECRET', webhook.secret);
 console.log('登録: Worker Secrets の STRIPE_SECRET_KEY と STRIPE_WEBHOOK_SECRET（値は表示しません）');
 console.log('\n完了しました。wrangler.jsonc の変更を反映（PR のマージ）すると、新しいサンドボックスの支払いページに切り替わります。');
}

main().catch(error => { console.error(`\nエラー: ${error.message}`); process.exitCode = 1; });
