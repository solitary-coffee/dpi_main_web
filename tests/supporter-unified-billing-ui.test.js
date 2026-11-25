import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('申込み・変更と事前チャージを一画面に統合する',async()=>{
 const [app,css,index,plans]=await Promise.all([
  read('../site/supporter/app.js'),read('../site/supporter/style.css'),read('../site/supporter/index.html'),read('../site/supporter/plans.html'),
 ]);
 for(const text of ['プランの申込み・変更','お支払い方法を選ぶ','クレジットカードで申し込む','事前チャージして申し込む','変更内容と料金を確認','事前チャージ','dpi-supporter-pending-plan','30*60*1000','残高が足りました。','入金の確認後に、残高で申し込めます。'])assert.ok(app.includes(text),text);
 assert.doesNotMatch(app,/setBillingMode|topupModeButton|paymentModeButton|topupSignup|topupPlan|innerHTML/u);
 assert.match(app,/sessionStorage\.setItem/u);
 assert.match(app,/scrollIntoView[\s\S]*focus/u);
 assert.match(app,/new URLSearchParams\(location\.search\)\.has\('credit'\)/u);
 assert.doesNotMatch(css,/billing-mode|credit-signup/u);
 assert.match(css,/@media\(max-width:600px\)[^{]*\{\.payment-choice-actions\{flex-direction:column/u);
 for(const html of [index,plans]){
  assert.match(html,/「クレジットカードで申し込む」を押す/u);
  assert.match(html,/「事前チャージして申し込む」を押す/u);
  assert.match(html,/入金の確認後「残高で申し込む」を押す/u);
 }
});
