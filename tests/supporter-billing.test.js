import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {selection,billingReady,billingSchedule,creditsFromBalance,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
import {supporterAdminAccount} from '../worker/supporter.js';
import {readFile} from 'node:fs/promises';
test('plan, channel and server add-ons are server controlled',()=>{
 assert.deepEqual(selection({plan:'supporter',channelPacks:2,serverPacks:1}),{plan:'supporter',packs:2,channelPacks:2,serverPacks:1,monthly:900,channels:8,servers:2});
 assert.deepEqual(selection({plan:'plus',channelPacks:1,serverPacks:0}),{plan:'plus',packs:1,channelPacks:1,serverPacks:0,monthly:1000,channels:13,servers:1});
 for(const v of [{plan:'supporter',channelPacks:6,serverPacks:0},{plan:'supporter',channelPacks:0,serverPacks:-1},{plan:'supporter',channelPacks:'1',serverPacks:0},{plan:'unknown',channelPacks:0,serverPacks:0}])assert.throws(()=>selection(v));
});
test('billing is anchored to the 26th JST and late-month signup charges two months',()=>{
 const before=billingSchedule(Date.parse('2026-11-25T03:00:00Z'));
 assert.deepEqual(before,{billingDay:26,anchor:Math.floor(Date.parse('2026-11-25T15:00:00Z')/1000),initialMonths:1,lateMonth:false});
 const after=billingSchedule(Date.parse('2026-11-25T15:00:00Z'));
 assert.deepEqual(after,{billingDay:26,anchor:Math.floor(Date.parse('2026-12-25T15:00:00Z')/1000),initialMonths:2,lateMonth:true});
 const yearEnd=billingSchedule(Date.parse('2026-12-31T03:00:00Z'));
 assert.equal(yearEnd.anchor,Math.floor(Date.parse('2027-01-25T15:00:00Z')/1000));
});
test('live secrets can never enable billing',()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_live_example',STRIPE_WEBHOOK_SECRET:'x',STRIPE_PRICE_SUPPORTER:'x',STRIPE_PRICE_PLUS:'x',STRIPE_PRICE_ADDON:'x',STRIPE_PORTAL_CONFIG:'x'};
 assert.equal(billingReady(env),false);env.STRIPE_SECRET_KEY='sk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_live_example';assert.equal(billingReady(env),false);
});
test('subscription summary includes plan, dates, amount and item details',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_supporter',STRIPE_PRICE_ADDON:'price_addon'};
 const result=subscriptionSummary({status:'active',cancel_at_period_end:false,start_date:1700000000,metadata:{dpi_channel_packs:'1',dpi_server_packs:'1'},items:{data:[
  {quantity:1,current_period_start:1700000000,current_period_end:1702592000,price:{id:'price_supporter',unit_amount:300,currency:'jpy'}},
  {quantity:2,current_period_start:1700000000,current_period_end:1702592000,price:{id:'price_addon',unit_amount:200,currency:'jpy'}},
 ]}},env);
 assert.equal(result.plan,'BASIC');
 assert.equal(result.startedAt,1700000000);
 assert.equal(result.currentPeriodStart,1700000000);
 assert.equal(result.nextRenewalAt,1702592000);
 assert.equal(result.amount,700);
 assert.equal(result.channels,5);
 assert.equal(result.servers,2);
 assert.deepEqual(result.items.map(item=>[item.label,item.quantity,item.subtotal]),[['BASIC',1,300],['追加オプション',2,400]]);
});
test('admin contract data excludes Stripe identifiers and counts rules',()=>{
 const account=supporterAdminAccount({discord_user_id:'123',billing_email:'user@example.jp',registered_at:'2026-01-01',updated_at:'2026-01-02',revision:2,settings_json:'{"rules":[{},{}]}',customer_id:'cus_private'},[{status:'active',amount:300}],'',500);
 assert.equal(account.discordUserId,'123');
 assert.equal(account.billingEmail,'user@example.jp');
 assert.equal(account.credits,500);
 assert.equal(account.ruleCount,2);
 assert.equal(account.subscriptions[0].amount,300);
 assert.equal('customer_id' in account,false);
});
test('paid plans stay separate from secondary-use applications and private in navigation',async()=>{
 const [reuseHtml,reuseScript,basicHtml,billingSource]=await Promise.all([
  readFile(new URL('../site/reuse/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/reuse/script.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/index.html',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
 ]);
 assert.doesNotMatch(reuseHtml,/basic-dashboard-card|BASIC/);
 assert.doesNotMatch(reuseScript,/api\/supporter/);
 assert.match(basicHtml,/BASIC/);
 assert.doesNotMatch(basicHtml,/service-dashboard/);
 assert.doesNotMatch(basicHtml,/<nav[\s\S]*?<a href="\/site\/supporter\//);
 assert.doesNotMatch(billingSource,/payment_method_types/);
 assert.match(billingSource,/subscription_data\[billing_cycle_anchor\]/);
 assert.match(billingSource,/subscription_data\[proration_behavior\].*none/);
 assert.match(billingSource,/初回利用料（当月分・翌月分の2か月分）/);
 assert.match(basicHtml,/26〜31日の申込/);
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
 for(const action of ['change_subscription','grant_credit','remove_credit','create_payment_link','refund_latest','cancel_at_period_end','cancel_immediately'])assert.match(html,new RegExp(`value="${action}"`));
 assert.match(script,/crypto\.randomUUID\(\)/);
 assert.doesNotMatch(script,/\.innerHTML\s*=/);
});
test('Stripe customer balance converts to non-negative yen credits',()=>{
 assert.equal(creditsFromBalance(-500),500);
 assert.equal(creditsFromBalance(0),0);
 assert.equal(creditsFromBalance(200),0);
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
 assert.doesNotMatch(source,/magnitudeMax/);
 assert.match(source,/rule\.magnitudeMode==='threshold'/);
 assert.match(source,/rule\.intensityMode==='threshold'/);
 assert.match(source,/server-warning/);
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
