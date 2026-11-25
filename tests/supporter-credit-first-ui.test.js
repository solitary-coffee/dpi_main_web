import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {creditFirstPayment} from '../site/supporter/credit-first.js';

test('申込みは残高を優先し、カード最低額50円を守る',()=>{
 assert.deepEqual(creditFirstPayment(300,0),{state:'card',creditApplied:0,cardCharge:300,remainingCredits:0,topupNeeded:300});
 assert.deepEqual(creditFirstPayment(300,100),{state:'split',creditApplied:100,cardCharge:200,remainingCredits:0,topupNeeded:200});
 assert.deepEqual(creditFirstPayment(300,280),{state:'split',creditApplied:250,cardCharge:50,remainingCredits:30,topupNeeded:20});
 assert.deepEqual(creditFirstPayment(300,300),{state:'credits',creditApplied:300,cardCharge:0,remainingCredits:0,topupNeeded:0});
 assert.equal(creditFirstPayment(300,100,false).state,'checking');
});

test('申込みUIは自動決定の表示と送信値を持ち、支払い方法ラジオを持たない',async()=>{
 const app=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 for(const text of ['クレジットカードで申し込む','事前チャージの残高から','カードへの請求','支払い後の残高','残高を使って申し込む','カードを使わない場合は、あと','残高で申し込む（カード請求なし）','applyCredits:true','expectedCreditApplied:payment.creditApplied'])assert.ok(app.includes(text),text);
 assert.doesNotMatch(app,/signup-payment-method|type='radio'/u);
 assert.doesNotMatch(app,/innerHTML/u);
});
