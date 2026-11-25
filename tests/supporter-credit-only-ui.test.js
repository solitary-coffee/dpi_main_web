import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('カードなしの申込み・変更・未払い支払いを画面から案内する',async()=>{
 const app=await read('site/supporter/app.js');
 for(const text of ['カードなどで支払う','チャージ済みクレジットで支払う（カード不要）','creditBalanceLoaded','paymentMethodRegistered','creditShortage','/api/supporter/billing/pay-unpaid','expectedTotal','未払いは一部だけ支払えません'])assert.match(app,new RegExp(text,'u'));
 assert.match(app,/useCredits:creditPaymentInput\.checked/u);
 assert.doesNotMatch(app,/innerHTML/u);
});

test('公開案内と規約・特商法にクレジットだけの利用条件を記載する',async()=>{
 const files=await Promise.all(['site/supporter/index.html','site/supporter/plans.html','terms/terms.md','terms/spec.md'].map(read));
 for(const html of files.slice(0,2))assert.match(html,/カードが無くても使えます。[\s\S]*残高で全額を支払えた場合、カードには請求しません。/u);
 for(const legal of files.slice(2)){assert.match(legal,/カード(?:情報)?を登録せず[\s\S]*申込み、プラン変更(?:および|・)毎月の更新/u);assert.match(legal,/未払いの請求[\s\S]*画面の操作または月末の再決済[\s\S]*一部だけの充当はしません/u);}
});
