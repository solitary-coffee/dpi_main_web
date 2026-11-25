import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = ['site/supporter/index.html', 'site/supporter/plans.html'];

for (const page of pages) {
 test(`${page} に支払い方法表がある`, async () => {
  const html = await readFile(page, 'utf8');
  assert.match(html, /id="payment-methods-title"/);
  assert.match(html, /<caption>支払い方法ごとの利用可否<\/caption>/);
  assert.match(html, /<th scope="col">プランの申込み・毎月の支払い<\/th>/);
  assert.match(html, /<th scope="row">PayPay<\/th><td>×<\/td><td>○<\/td>/);
  assert.match(html, /<th scope="row">銀行振込<\/th><td>×<\/td>/);
  assert.match(html, /<th scope="row">コンビニ払い<\/th><td>×<\/td>/);
 });
}

test('基本プランの画像配信要約が比較表の段階差と一致する', async () => {
 const [index, plans] = await Promise.all(pages.map(page => readFile(page, 'utf8')));
 assert.match(index, /data-plan="supporter"[\s\S]*?画像配信：[\s\S]*?緊急地震速報（全国）[\s\S]*?津波の全国地図[\s\S]*?<\/article>/);
 assert.match(index, /data-plan="plus"[\s\S]*?画像配信：Basicの種類に加え[\s\S]*?警報の地図[\s\S]*?地震情報の全国図[\s\S]*?<\/article>/);
 assert.match(index, /data-plan="pro"[\s\S]*?画像配信：Plusの全種類に加え[\s\S]*?時系列予想[\s\S]*?市区町村指定[\s\S]*?<\/article>/);
 assert.match(plans, /緊急地震速報（警報）の図[\s\S]*?<th scope="row">全国<\/th><td>○<\/td><td>○<\/td><td>○<\/td>/);
 assert.match(plans, /気象警報・注意報の時系列予想[\s\S]*?<th scope="row">地方<\/th><td>—<\/td><td>—<\/td><td>○<\/td>/);
});
