import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {selection,billingReady,verifySignature} from '../worker/supporter-billing.js';
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
test('webhook rejects tampering stale timestamps and wrong secrets; rotation works',async()=>{
 const raw='{"livemode":false}',ts=1700000000,secret='whsec_example';
 const sig=createHmac('sha256',secret).update(`${ts}.${raw}`).digest('hex');
 const header=`t=${ts},v1=${'0'.repeat(64)},v1=${sig}`;
 assert.equal(await verifySignature(raw,header,secret,ts*1000),true);
 assert.equal(await verifySignature(raw+' ',header,secret,ts*1000),false);
 assert.equal(await verifySignature(raw,header,secret,(ts+301)*1000),false);
 assert.equal(await verifySignature(raw,header,'other',ts*1000),false);
});
