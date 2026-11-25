import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = ['site/supporter/index.html', 'site/supporter/plans.html'];

for (const page of pages) {
 test(`${page} は、カードと事前チャージの違い・引き落としの順番を示す`, async () => {
  const html = await readFile(page, 'utf8'), section = html.slice(html.indexOf('id="payment-methods-title"'), html.indexOf('カード番号はDPI-Botでは保存しません'));
  for (const brand of ['Visa', 'Mastercard', 'American Express', 'JCB', 'Diners Club', 'Discover']) assert.ok(section.includes(brand), brand);
  assert.match(section, /<h3>クレジットカード支払い式<\/h3>[\s\S]*そのまますぐに申し込めます/);
  assert.match(section, /<h3>事前チャージ式<\/h3>[\s\S]*カードが無くても使えます[\s\S]*PayPay・コンビニ払い・銀行振込・クレジットカード/);
  assert.match(section, /PayPay・コンビニ払い・銀行振込は、プランを直接支払うことはできません。いったんチャージしてから/);
  assert.match(section, /① 事前チャージの残高[\s\S]*② クレジットカード/);
  assert.match(section, /残高で全額を支払えた場合、カードには請求しません。/);
  assert.doesNotMatch(section, /<table|×/);
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
