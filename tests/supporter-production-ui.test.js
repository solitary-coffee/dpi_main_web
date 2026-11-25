// 非公開の間も、画面の表記と機能は本番と同じ（決済だけ Stripe のテストモード）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import * as billing from '../worker/supporter-billing.js';
import { handleSupporterRequest } from '../worker/supporter.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('画面に、テスト段階の案内やログイン不要のテスト支払いが残っていない', async () => {
 for (const file of ['index.html', 'plans.html', 'app.js', 'plans-previews.js', 'style.css', 'plans.css']) {
  const source = await read(`../site/supporter/${file}`);
  assert.doesNotMatch(source, /テスト段階|テスト公開|テスト運用|テスト支払い|テストモード|preview-checkout|preview-only|billing-live|preview-closed|data-preview-plan="(?:supporter|plus|pro|credit)"/, file);
 }
 await assert.rejects(() => access(new URL('../site/supporter/preview-checkout.js', import.meta.url)));
});

test('契約変更の確認画面の注意文は、本番でも表示される', async () => {
 assert.match(await read('../site/supporter/app.js'), /optionNote\.className='preview-notice'/);
 assert.match(await read('../site/supporter/style.css'), /\.preview-notice\{padding/);
 assert.doesNotMatch(await read('../site/supporter/style.css'), /\.preview-notice[^{]*\{display:none/);
});

test('ログイン不要の支払いを作る入口は無い（公開設定によらず404または未ログイン）', async () => {
 assert.equal(billing.createPreviewCheckout, undefined);
 for (const env of [{}, {SUPPORTER_PREVIEW_OPEN: 'true'}, {SUPPORTER_PUBLIC_ENABLED: 'true'}]) {
  const response = await handleSupporterRequest(new Request('https://dpi-bot.com/api/supporter/preview-checkout', {method: 'POST', body: '{"plan":"plus"}', headers: {'Content-Type': 'application/json', Origin: 'https://dpi-bot.com'}}), {REUSE_DB: {}, ...env});
  assert.ok([401, 404, 503].includes(response.status), String(response.status));
 }
});

test('公開設定: 非公開・本番決済で、許可リストの利用者は受付中', async () => {
 const {vars} = JSON.parse(await read('../wrangler.jsonc'));
 assert.deepEqual([vars.SUPPORTER_BILLING_MODE, vars.SUPPORTER_PUBLIC_ENABLED, vars.SUPPORTER_PREVIEW_OPEN, vars.SUPPORTER_INTAKE_PAUSED], ['live', 'false', 'false', 'false']);
});

test('以前のテスト支払いの完了通知が遅れて届いても、何にも反映しない', async () => {
 const source = await read('../worker/supporter-billing.js');
 const index = source.indexOf("dpi_checkout_kind==='preview_demo'){");
 assert.ok(index > 0);
 assert.doesNotMatch(source.slice(index, source.indexOf('}else if(await rejectDisciplinedCheckout', index)), /db\.|provision|grant|stripe\(/);
});

test('プランの支払いページでは PayPay を除外する（申込み・カスタムの初回・差額）', async () => {
 const source = await read('../worker/supporter-billing.js');
 assert.equal((source.match(/\.\.\.SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS/g) || []).length, 3);
 assert.equal(billing.SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS['excluded_payment_method_types[0]'], 'paypay');
});
