// Stripe の本番環境に、有料プランに必要な設定を作る。本番決済はまだ始まらない（SUPPORTER_BILLING_MODE は変えない）。
//
//   node scripts/stripe-live-setup.mjs
//
// 1. キーを 2 つ入力する（画面には表示しない。ファイルにも残さない）。
//    - 設定用: 料金・ポータル・Webhook を作るためのキー（sk_live_ または必要な権限の rk_live_）。保存しない。
//    - 運用用: Worker が使う制限付きキー（rk_live_）。権限は docs/billing-cutover.md。
// 2. 料金 4 つ（内容が違う既存の料金があれば止まる）・カスタマーポータル・Webhook を作る。
// 3. 運用用キーで読み取れるかを確かめる。
// 4. wrangler.jsonc の STRIPE_LIVE_* と、Worker Secrets の STRIPE_LIVE_SECRET_KEY・STRIPE_LIVE_WEBHOOK_SECRET を登録する。
// 支払い方法（カード・PayPay など）・領収書メール・自動再試行は変えない。ダッシュボードで設定する（docs/billing-cutover.md）。
import { ask, askHidden, ensurePortal, ensurePrices, findWebhooks, putSecret, stripeClient, verifyStripeWritePermissions, webhookParams, writeConfigValues, EVENTS } from './stripe-setup-lib.mjs';

const READS = ['customers', 'subscriptions', 'subscription_schedules', 'invoices', 'checkout/sessions', 'payment_intents', 'charges', 'disputes', 'refunds', 'prices', 'products', 'billing_portal/configurations'];

async function main() {
 console.log('Stripe の本番環境を設定します。本番決済はまだ始まりません。');
 const setupKey = await askHidden('設定用のキー（sk_live_... / rk_live_...、保存しません）: ');
 if (!/^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(setupKey)) throw new Error('本番のキー（sk_live_ / rk_live_）を入力してください。');
 const runtimeKey = await askHidden('運用用の制限付きキー（rk_live_...、Worker に登録します）: ');
 if (!/^rk_live_[A-Za-z0-9]+$/.test(runtimeKey)) throw new Error('運用用には制限付きキー（rk_live_）を使ってください。');
 const stripe = stripeClient(setupKey), runtime = stripeClient(runtimeKey);

 const account = await stripe('GET', 'account').catch(() => null);
 if (account) {
  console.log(`アカウント: ${account.settings?.dashboard?.display_name || account.id}（${account.country}・${account.default_currency}）`);
  if (account.charges_enabled === false) throw new Error('このアカウントではまだ決済を受け付けられません（本人確認などの審査を確認してください）。');
  if (account.payouts_enabled === false) console.log('注意: 入金がまだ有効ではありません。');
 }
 if (await ask('このアカウントに作成します。よければ「はい」と入力してください: ') !== 'はい') throw new Error('中止しました（何も作っていません）。');

 const denied = [];
 for (const path of READS) await runtime('GET', `${path}?limit=1`).catch(error => denied.push(`${path}（${error.status || error.message}）`));
 if (denied.length) throw new Error(`運用用キーで読み取れないものがあります: ${denied.join('、')}。権限を足してからやり直してください（まだ何も作っていません）。`);
 console.log(`確認: 運用用キーの読み取り ${READS.length} 種類`);

 const writeChecks = await verifyStripeWritePermissions(runtimeKey);
 console.log(`確認: 運用用キーの書き込み ${writeChecks} 種類（副作用のない失敗要求）`);

 const prices = await ensurePrices(stripe);
 const portal = await ensurePortal(stripe);
 const existing = await findWebhooks(stripe);
 if (existing.length) {
  console.log(`同じ URL の Webhook 送信先が ${existing.length} 件あります。署名シークレットは作成時にしか取得できないため、作り直す必要があります。`);
  if (await ask('作り直してよければ「作り直す」と入力してください: ') !== '作り直す') throw new Error('中止しました（料金・ポータルは作成済み。もう一度実行すると続きから行えます）。');
 }
 // 新しい送信先と署名鍵を登録してから古い送信先を消す（受信が途切れない）。
 const webhook = await stripe('POST', 'webhook_endpoints', webhookParams());
 console.log(`作成: Webhook 送信先 → ${webhook.id}（${EVENTS.length} イベント）`);
 try {
  putSecret('STRIPE_LIVE_SECRET_KEY', runtimeKey);
  putSecret('STRIPE_LIVE_WEBHOOK_SECRET', webhook.secret);
 } catch (error) {
  await stripe('DELETE', `webhook_endpoints/${webhook.id}`).catch(() => {});
  throw error;
 }
 for (const endpoint of existing) { await stripe('DELETE', `webhook_endpoints/${endpoint.id}`); console.log(`削除: 古い Webhook 送信先 ${endpoint.id}`); }
 await writeConfigValues({...Object.fromEntries(Object.entries(prices).map(([name, id]) => [name.replace('STRIPE_', 'STRIPE_LIVE_'), id])), STRIPE_LIVE_PORTAL_CONFIG: portal});
 console.log('登録: Worker Secrets の STRIPE_LIVE_SECRET_KEY・STRIPE_LIVE_WEBHOOK_SECRET（値は表示しません）');
 console.log('更新: wrangler.jsonc の STRIPE_LIVE_*');
 console.log('\n完了しました。wrangler.jsonc の変更を PR にしてマージし、`node scripts/billing-cutover.mjs status` で確認してください。');
}
main().catch(error => { console.error(`\nエラー: ${error.message}`); process.exitCode = 1; });
