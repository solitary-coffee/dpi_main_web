import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {selection,billingReady,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
test('price and channel pack limits are server controlled',()=>{
 assert.deepEqual(selection({plan:'supporter',packs:2}),{plan:'supporter',packs:2,monthly:700,channels:8});
 assert.equal(selection({plan:'plus',packs:0}).monthly,800);
 for(const v of [{plan:'plus',packs:1},{plan:'supporter',packs:3},{plan:'supporter',packs:-1},{plan:'supporter',packs:'1'},{plan:'unknown',packs:0}])assert.throws(()=>selection(v));
});
test('live secrets can never enable billing',()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_live_example',STRIPE_WEBHOOK_SECRET:'x',STRIPE_PRICE_SUPPORTER:'x',STRIPE_PRICE_PLUS:'x',STRIPE_PRICE_ADDON:'x',STRIPE_PORTAL_CONFIG:'x'};
 assert.equal(billingReady(env),false);env.STRIPE_SECRET_KEY='sk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_live_example';assert.equal(billingReady(env),false);
});
test('subscription summary includes plan, dates, amount and item details',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_supporter',STRIPE_PRICE_ADDON:'price_addon'};
 const result=subscriptionSummary({status:'active',cancel_at_period_end:false,start_date:1700000000,items:{data:[
  {quantity:1,current_period_start:1700000000,current_period_end:1702592000,price:{id:'price_supporter',unit_amount:300,currency:'jpy'}},
  {quantity:2,current_period_start:1700000000,current_period_end:1702592000,price:{id:'price_addon',unit_amount:200,currency:'jpy'}},
 ]}},env);
 assert.equal(result.plan,'Supporter');
 assert.equal(result.startedAt,1700000000);
 assert.equal(result.currentPeriodStart,1700000000);
 assert.equal(result.nextRenewalAt,1702592000);
 assert.equal(result.amount,700);
 assert.deepEqual(result.items.map(item=>[item.label,item.quantity,item.subtotal]),[['Supporter',1,300],['追加3チャンネル',2,400]]);
});
test('webhook rejects tampering stale timestamps and wrong secrets; rotation works',async()=>{
 const raw='{"livemode":false}',ts=1700000000,secret='whsec_example';
 const sig=createHmac('sha256',secret).update(`${ts}.${raw}`).digest('hex');
 const header=`t=${ts},v1=${'0'.repeat(64)},v1=${sig}`;
 assert.equal(await verifySignature(raw,header,secret,ts*1000),true);
 assert.equal(await verifySignature(raw+' ',header,secret,ts*1000),false);
 assert.equal(await verifySignature(raw,header,secret,(ts+301)*1000),false);
 assert.equal(await verifySignature(raw,header,'other',ts*1000),false);
});
