import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {selection,billingReady,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
import {supporterAdminAccount} from '../worker/supporter.js';
import {readFile} from 'node:fs/promises';
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
 assert.equal(result.plan,'BASIC');
 assert.equal(result.startedAt,1700000000);
 assert.equal(result.currentPeriodStart,1700000000);
 assert.equal(result.nextRenewalAt,1702592000);
 assert.equal(result.amount,700);
 assert.deepEqual(result.items.map(item=>[item.label,item.quantity,item.subtotal]),[['BASIC',1,300],['追加3チャンネル',2,400]]);
});
test('admin contract data excludes Stripe identifiers and counts rules',()=>{
 const account=supporterAdminAccount({discord_user_id:'123',registered_at:'2026-01-01',updated_at:'2026-01-02',revision:2,settings_json:'{"rules":[{},{}]}',customer_id:'cus_private'},[{status:'active',amount:300}]);
 assert.equal(account.discordUserId,'123');
 assert.equal(account.ruleCount,2);
 assert.equal(account.subscriptions[0].amount,300);
 assert.equal('customer_id' in account,false);
});
test('BASIC is private in public navigation and revealed from authenticated dashboard',async()=>{
 const [reuseHtml,reuseScript,basicHtml,billingSource]=await Promise.all([
  readFile(new URL('../site/reuse/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/reuse/script.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/index.html',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
 ]);
 assert.match(reuseHtml,/id="basic-dashboard-card" class="service-card hidden"/);
 assert.match(reuseScript,/api\('\/api\/supporter\/account'\)/);
 assert.match(basicHtml,/BASIC/);
 assert.doesNotMatch(basicHtml,/<nav[\s\S]*?<a href="\/site\/supporter\//);
 assert.doesNotMatch(billingSource,/payment_method_types/);
});
test('admin billing operations require confirmation, reason, same-origin and audit logging',async()=>{
 const [worker,html,script]=await Promise.all([
  readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/app.js',import.meta.url),'utf8'),
 ]);
 assert.match(worker,/assertAdminOrigin\(request\)/);
 assert.match(worker,/input\.confirmDiscordUserId !== uid/);
 assert.match(worker,/writeSupporterAudit/);
 for(const action of ['change_subscription','create_payment_link','refund_latest','cancel_at_period_end','cancel_immediately'])assert.match(html,new RegExp(`value="${action}"`));
 assert.match(script,/crypto\.randomUUID\(\)/);
 assert.doesNotMatch(script,/\.innerHTML\s*=/);
});
test('supporter UI avoids WebKit URL constructor errors for Stripe redirects',async()=>{
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.match(source,/function stripeDestination\(value\)/);
 assert.doesNotMatch(source,/new URL\(result\.url\)/);
 assert.match(source,/checkout\.stripe\.com/);
 assert.match(source,/billing\.stripe\.com/);
});
test('supporter rule creation is resilient to WebKit input and channel errors',async()=>{
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/type:'number'/);
 assert.match(source,/inputmode:'decimal'/);
 assert.match(source,/rules\.push\(normalizeRule[\s\S]+render\(\);[\s\S]+await loadChannels/);
 assert.match(source,/チャンネルを再取得/);
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
