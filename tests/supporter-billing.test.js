import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {billingAction,selection,billingReady,billingSchedule,creditsFromBalance,customerInvoices,prorationBreakdown,scheduledChangeSummary,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
import {supporterAdminAccount} from '../worker/supporter.js';
import {readFile} from 'node:fs/promises';
test('plan, channel and server add-ons are server controlled',()=>{
 assert.deepEqual(selection({plan:'supporter',channelPacks:2,serverPacks:1}),{plan:'supporter',packs:2,channelPacks:2,serverPacks:1,baseMonthly:300,monthly:900,channels:8,servers:2,rules:5,complexConditions:false,multiDestination:false});
 assert.deepEqual(selection({plan:'plus',channelPacks:1,serverPacks:0}),{plan:'plus',packs:1,channelPacks:1,serverPacks:0,baseMonthly:800,monthly:1000,channels:13,servers:3,rules:15,complexConditions:false,multiDestination:false});
 assert.deepEqual(selection({plan:'pro',channelPacks:0,serverPacks:0}),{plan:'pro',packs:0,channelPacks:0,serverPacks:0,baseMonthly:1280,monthly:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true});
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
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_live_example',STRIPE_WEBHOOK_SECRET:'x',STRIPE_PRICE_SUPPORTER:'x',STRIPE_PRICE_PLUS:'x',STRIPE_PRICE_PRO:'x',STRIPE_PRICE_ADDON:'x',STRIPE_PORTAL_CONFIG:'x'};
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
 assert.match(billingSource,/invoices\/create_preview/);
 assert.match(billingSource,/proration_behavior:'none'/);
 assert.match(billingSource,/previewSubscriptionUpdate/);
 assert.match(basicHtml,/26〜31日の申込/);
 assert.match(basicHtml,/Pro/);
 assert.match(basicHtml,/追加オプションの変更には日割り計算を適用しません/);
 assert.match(basicHtml,/通知設定は有料プランの契約後/);
 assert.doesNotMatch(basicHtml,/通知ルールの下書き/);
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
test('plan proration separates the old-plan refund equivalent from the new-plan charge',()=>{
 assert.deepEqual(prorationBreakdown([
  {amount:-100,parent:{subscription_item_details:{proration:true}}},
  {amount:700,parent:{subscription_item_details:{proration:true}}},
  {amount:1280,parent:{subscription_item_details:{proration:false}}},
 ]),{unusedPlanCredit:100,newPlanCharge:700,net:600});
});
test('scheduled change summaries expose the next plan without Stripe identifiers',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon'};
 const current={planId:'pro',channelPacks:0,serverPacks:0,nextRenewalAt:1800000000};
 assert.deepEqual(scheduledChangeSummary({phases:[{start_date:1800000000,metadata:{dpi_channel_packs:'1',dpi_server_packs:'0'},items:[{price:'price_plus',quantity:1},{price:'price_addon',quantity:1}]}]},env,current),{effectiveAt:1800000000,plan:'Plus',planId:'plus',monthly:1000,channels:13,servers:3,rules:15,channelPacks:1,serverPacks:0});
});
test('invoice history only returns safe Stripe document links',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({livemode:false,data:[{number:'DPI-001',status:'paid',created:1700000000,currency:'jpy',total:800,amount_due:800,amount_paid:800,hosted_invoice_url:'https://invoice.stripe.com/i/test',invoice_pdf:'https://pay.stripe.com/invoice/test/pdf'},{number:'DPI-002',status:'open',created:1700000001,currency:'jpy',total:300,hosted_invoice_url:'https://evil.example/invoice'}]}),{status:200,headers:{'content-type':'application/json'}});
 try{const invoices=await customerInvoices(env,'cus_x');assert.equal(invoices[0].hostedInvoiceUrl,'https://invoice.stripe.com/i/test');assert.equal(invoices[0].invoicePdf,'https://pay.stripe.com/invoice/test/pdf');assert.equal(invoices[1].hostedInvoiceUrl,null);}finally{globalThis.fetch=originalFetch;}
});
test('update preview prorates only the base plan and confirms options without proration',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 const current={id:'sub_x',status:'active',customer:'cus_x',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:Date.now()/1000+86400,price:{id:'price_basic',unit_amount:300,currency:'jpy'}}]}};
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:'user@example.jp'};if(sql.includes('supporter_billing'))return{discord_user_id:'123',customer_id:'cus_x'};return null;},async run(){return{meta:{changes:1}};}};}};
 const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,method:init.method||'GET',params});
  let data={livemode:false};
  if(path==='/v1/subscriptions')data={livemode:false,data:[current]};
  else if(path==='/v1/invoices/create_preview')data={livemode:false,lines:{data:[{amount:-100,parent:{subscription_item_details:{proration:true}}},{amount:700,parent:{subscription_item_details:{proration:true}}},{amount:1280,parent:{subscription_item_details:{proration:false}}}]}};
  else if(path==='/v1/customers/cus_x'&&(init.method||'GET')==='GET')data={livemode:false,balance:-100};
  else if(path==='/v1/subscriptions/sub_x')data={...current,livemode:false};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const previewResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),env,db,'123',{plan:'pro',channelPacks:1,serverPacks:0});
  const preview=await previewResponse.json();assert.equal(preview.planChanged,true);assert.deepEqual(preview.planProrationBreakdown,{unusedPlanCredit:100,newPlanCharge:700,net:600});assert.equal(preview.planProration,600);assert.equal(preview.creditApplied,100);assert.equal(preview.immediateDue,500);assert.equal(preview.next.servers,5);assert.equal(preview.next.channels,23);
  const previewCall=calls.find(call=>call.path==='/v1/invoices/create_preview');assert.equal(previewCall.params.get('subscription_details[items][0][price]'),'price_pro');assert.equal(previewCall.params.get('subscription_details[items][1][price]'),null);
  calls.length=0;
  const requestId='123e4567-e89b-42d3-a456-426614174000';
  const updateResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'pro',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,requestId});
  assert.equal(updateResponse.status,200);
  const updates=calls.filter(call=>call.path==='/v1/subscriptions/sub_x');
  const base=updates.find(call=>call.params.get('proration_behavior')==='always_invoice');
  const options=updates.find(call=>call.params.get('proration_behavior')==='none');
  assert.equal(base.params.get('proration_date'),String(preview.prorationDate));assert.equal(base.params.get('items[0][price]'),'price_pro');
  assert.equal(options.params.get('items[0][price]'),'price_addon');assert.equal(options.params.get('items[0][quantity]'),'1');assert.equal(options.params.get('proration_date'),null);
 } finally {globalThis.fetch=originalFetch;}
});
test('downgrades are scheduled for the next renewal without refund or immediate invoice',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 const renewal=Math.floor(Date.now()/1000)+86400;
 const current={id:'sub_pro',status:'active',customer:'cus_x',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:renewal,price:{id:'price_pro',unit_amount:1280,currency:'jpy'}}]}};
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:'user@example.jp'};if(sql.includes('supporter_billing'))return{discord_user_id:'123',customer_id:'cus_x'};return null;},async run(){return{meta:{changes:1}};}};}};
 const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,params});let data={livemode:false};
  if(path==='/v1/subscriptions')data={livemode:false,data:[current]};
  else if(path==='/v1/subscription_schedules')data={id:'sub_sched_x',livemode:false,phases:[{start_date:1700000000,end_date:renewal,items:[{price:'price_pro',quantity:1}]}]};
  else if(path==='/v1/subscription_schedules/sub_sched_x')data={id:'sub_sched_x',livemode:false,phases:[]};
  else if(path==='/v1/customers/cus_x')data={livemode:false,balance:0};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const previewResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),env,db,'123',{plan:'supporter',channelPacks:0,serverPacks:0});
  const preview=await previewResponse.json();assert.equal(preview.changeTiming,'next_period');assert.equal(preview.immediateDue,0);assert.equal(preview.creditGenerated,0);assert.equal(preview.effectiveAt,renewal);assert.equal(calls.some(call=>call.path==='/v1/invoices/create_preview'),false);
  calls.length=0;
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'supporter',channelPacks:0,serverPacks:0,prorationDate:preview.prorationDate,requestId:'123e4567-e89b-42d3-a456-426614174000'});
  assert.equal(response.status,200);
  const create=calls.find(call=>call.path==='/v1/subscription_schedules');assert.equal(create.params.get('from_subscription'),'sub_pro');
  const update=calls.find(call=>call.path==='/v1/subscription_schedules/sub_sched_x');assert.equal(update.params.get('proration_behavior'),'none');assert.equal(update.params.get('phases[1][items][0][price]'),'price_basic');assert.equal(update.params.get('phases[1][start_date]'),String(renewal));
  assert.equal(calls.some(call=>call.path==='/v1/refunds'),false);assert.equal(calls.some(call=>call.path==='/v1/invoices/create_preview'),false);
 } finally{globalThis.fetch=originalFetch;}
});
test('supporter UI avoids WebKit URL constructor errors for Stripe redirects',async()=>{
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.match(source,/function stripeDestination\(value\)/);
 assert.doesNotMatch(source,/new URL\(result\.url\)/);
 assert.match(source,/checkout\.stripe\.com/);
 assert.match(source,/billing\.stripe\.com/);
 assert.match(source,/invoice\.stripe\.com/);
 assert.match(source,/pay\.stripe\.com/);
});
test('supporter rule creation is resilient to WebKit input and channel errors',async()=>{
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/type:'number'/);
 assert.match(source,/inputmode:'decimal'/);
 assert.doesNotMatch(source,/magnitudeMax/);
 assert.match(source,/rule\.magnitudeMode==='threshold'/);
 assert.match(source,/rule\.intensityMode==='threshold'/);
 assert.match(source,/server-warning/);
 assert.match(source,/billing\/preview-update/);
 assert.match(source,/billing-preview-dialog/);
 assert.doesNotMatch(source,/window\.confirm\('契約内容を更新/);
 assert.match(source,/rules\.push\(normalizeRule[\s\S]+render\(\);[\s\S]+await loadChannels/);
 assert.match(source,/チャンネルを再取得/);
 assert.match(source,/checkbox\.type='checkbox'/);
 assert.match(source,/rule\.channelIds=\[\.\.\.selected\]/);
 assert.doesNotMatch(source,/input\.multiple=true/);
 assert.match(source,/additionalConditionsField/);
 assert.match(source,/通知設定は有料プランの契約後/);
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
