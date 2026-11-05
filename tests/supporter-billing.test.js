import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {billingAction,selection,billingReady,billingSchedule,creditApplication,creditsFromBalance,customerInvoices,dunningSchedule,paidCheckoutSubscriptionParams,provisionPaidCheckoutSubscription,prorationBreakdown,reconcilePaidCheckoutSubscription,scheduledChangeSummary,staleCheckoutAttempt,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
import {supporterAdminAccount,supporterAdminDetails} from '../worker/supporter.js';
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
test('failed 26th payment retries at noon on the final JST day and suspends next month',()=>{
 const feb=dunningSchedule(Math.floor(Date.parse('2026-02-25T15:00:00Z')/1000));
 assert.deepEqual(feb,{retryAt:Math.floor(Date.parse('2026-02-28T03:00:00Z')/1000),suspendAt:Math.floor(Date.parse('2026-02-28T15:00:00Z')/1000)});
 const leap=dunningSchedule(Math.floor(Date.parse('2028-02-25T15:00:00Z')/1000));
 assert.equal(leap.retryAt,Math.floor(Date.parse('2028-02-29T03:00:00Z')/1000));
 const december=dunningSchedule(Math.floor(Date.parse('2026-12-25T15:00:00Z')/1000));
 assert.equal(december.suspendAt,Math.floor(Date.parse('2026-12-31T15:00:00Z')/1000));
});
test('abandoned pre-Checkout state is detected without touching created sessions',()=>{
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:null,checkout_params:'{"expires_at":"100"}'},101),true);
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:null,checkout_params:'{"expires_at":"200"}'},101),false);
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:null,checkout_params:'invalid'},101),true);
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:'cs_test_x',checkout_params:'{"expires_at":"100"}'},101),false);
 assert.equal(staleCheckoutAttempt({checkout_key:null,checkout_id:null,checkout_params:null},101),false);
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:null,checkout_params:'{"expires_at":"200","subscription_data[proration_behavior]":"none","subscription_data[billing_cycle_anchor]":"150"}'},101),true);
 assert.equal(staleCheckoutAttempt({checkout_key:'key',checkout_id:'cs_test_old',checkout_params:'{"mode":"subscription","expires_at":"200","subscription_data[trial_end]":"150"}'},101),true);
});
test('new Checkout charges the stated initial fee without a free trial',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 const row={discord_user_id:'123',customer_id:'cus_x',checkout_id:null,checkout_key:null,checkout_params:null};
 const db={prepare(sql){return{values:[],bind(...values){this.values=values;return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:'user@example.jp'};if(sql.includes('supporter_billing'))return{...row};return null;},async run(){if(sql.includes('SET checkout_key=')){row.checkout_key=this.values[0];row.checkout_params=this.values[1];}if(sql.includes('SET checkout_id='))row.checkout_id=this.values[0];return{meta:{changes:1}};}};}};
 const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,params});let data={livemode:false,id:'cus_x'};if(path==='/v1/subscriptions')data={livemode:false,data:[]};if(path==='/v1/checkout/sessions')data={livemode:false,id:'cs_test_x',status:'open',url:'https://checkout.stripe.com/c/pay/cs_test_x'};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/checkout'),env,db,'123',{plan:'supporter',channelPacks:0,serverPacks:0,legalConsentVersion:'2026-11-04'});
  assert.equal(response.status,200);
  const checkout=calls.find(call=>call.path==='/v1/checkout/sessions'&&call.params.get('mode')==='payment');
  assert.equal(checkout.params.get('mode'),'payment');
  assert.equal(checkout.params.get('payment_intent_data[setup_future_usage]'),'off_session');
  assert.ok(Number(checkout.params.get('metadata[dpi_billing_anchor]'))>Math.floor(Date.now()/1000));
  assert.equal(checkout.params.get('subscription_data[trial_end]'),null);
  assert.equal(checkout.params.get('subscription_data[billing_cycle_anchor]'),null);
  assert.equal(checkout.params.get('subscription_data[proration_behavior]'),null);
  assert.equal(checkout.params.get('line_items[0][price_data][unit_amount]'),'300');
 }finally{globalThis.fetch=originalFetch;}
});
test('paid initial Checkout creates a fixed-26th subscription without trial',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon'};
 const anchor=Math.floor(Date.now()/1000)+86400;
 const params=paidCheckoutSubscriptionParams(env,{mode:'payment',payment_status:'paid',customer:'cus_x',client_reference_id:'123',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123',dpi_plan:'plus',dpi_channel_packs:'1',dpi_server_packs:'1',dpi_billing_anchor:String(anchor),dpi_legal_consent_version:'v1'}},{payment_method:'pm_x'});
 assert.equal(params.customer,'cus_x');assert.equal(params.default_payment_method,'pm_x');assert.equal(params.billing_cycle_anchor,String(anchor));assert.equal(params.proration_behavior,'none');
 assert.equal(params['items[0][price]'],'price_plus');assert.equal(params['items[1][price]'],'price_addon');assert.equal(params['items[1][quantity]'],'2');
 assert.equal(params.trial_end,undefined);assert.equal(params['trial_settings[end_behavior][missing_payment_method]'],undefined);
});
test('paid Checkout provisioning is idempotent and uses the saved payment method',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,params,key:init.headers?.['Idempotency-Key']});let data={livemode:false};if(path==='/v1/subscriptions'&&init.method==='GET')data={livemode:false,data:[]};if(path==='/v1/payment_intents/pi_x')data={livemode:false,id:'pi_x',payment_method:'pm_x'};if(path==='/v1/subscriptions'&&init.method==='POST')data={livemode:false,id:'sub_x',status:'active'};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const anchor=Math.floor(Date.now()/1000)+86400;
  const result=await provisionPaidCheckoutSubscription(env,{id:'cs_test_x',mode:'payment',payment_status:'paid',customer:'cus_x',payment_intent:'pi_x',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123',dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(anchor),dpi_legal_consent_version:'v1'}});
  assert.equal(result.id,'sub_x');const create=calls.find(call=>call.path==='/v1/subscriptions'&&call.params.size);assert.equal(create.key,'dpi-initial-subscription-v2-cs_test_x');assert.equal(create.params.get('default_payment_method'),'pm_x');assert.equal(create.params.get('billing_cycle_anchor'),String(anchor));assert.equal(create.params.get('proration_behavior'),'none');assert.equal(create.params.get('trial_end'),null);
 }finally{globalThis.fetch=originalFetch;}
});
test('missing subscription is recovered from the newest paid Checkout for the same user',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const anchor=Math.floor(Date.now()/1000)+86400;const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,params,key:init.headers?.['Idempotency-Key']});let data={livemode:false};
  if(path==='/v1/subscriptions'&&(init.method||'GET')==='GET')data={livemode:false,data:[]};
  else if(path==='/v1/checkout/sessions')data={livemode:false,data:[
   {id:'cs_old',created:10,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_x',payment_intent:'pi_old',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123',dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(anchor)}},
   {id:'cs_latest',created:20,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_x',payment_intent:'pi_latest',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123',dpi_plan:'plus',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(anchor)}},
   {id:'cs_other',created:30,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_x',payment_intent:'pi_other',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'999',dpi_plan:'pro',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(anchor)}},
  ]};
  else if(path==='/v1/payment_intents/pi_latest')data={livemode:false,id:'pi_latest',payment_method:'pm_latest'};
  else if(path==='/v1/subscriptions'&&init.method==='POST')data={livemode:false,id:'sub_recovered',status:'active'};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const result=await reconcilePaidCheckoutSubscription(env,'cus_x','123');assert.equal(result.recovered,true);assert.equal(result.checkoutId,'cs_latest');assert.equal(result.subscription.id,'sub_recovered');
  const create=calls.find(call=>call.path==='/v1/subscriptions'&&call.params.size);assert.equal(create.params.get('items[0][price]'),'price_plus');assert.equal(create.key,'dpi-initial-subscription-v2-cs_latest');
 }finally{globalThis.fetch=originalFetch;}
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
 const account=supporterAdminAccount({discord_user_id:'123',discord_name:'DPI利用者',billing_email:'user@example.jp',registered_at:'2026-01-01',updated_at:'2026-01-02',revision:2,settings_json:'{"rules":[{},{}]}',customer_id:'cus_private'},[{status:'active',amount:300}],'',500);
 assert.equal(account.discordUserId,'123');
 assert.equal(account.discordName,'DPI利用者');
 assert.equal(account.billingEmail,'user@example.jp');
 assert.equal(account.credits,500);
 assert.equal(account.ruleCount,2);
 assert.equal(account.subscriptions[0].amount,300);
 assert.equal('customer_id' in account,false);
});
test('admin rule details expose subscriber, server, channel names and readable conditions',()=>{
 const settings={rules:[{name:'首都圏EEW',guildId:'11111111111111111',channelId:'22222222222222222',channelIds:['22222222222222222','33333333333333333'],type:'eew',detail:'warning',region:'kanto-koshin',conditionLogic:'or',intensityMode:'threshold',intensity:'5-',magnitudeMode:'increase',magnitudeMin:null,eewWarningAreaMode:'target-only',conditions:[{kind:'magnitude',operator:'at_least',value:6.5}]}]};
 const account=supporterAdminDetails({discord_user_id:'123',discord_name:'DPI利用者',settings_json:JSON.stringify(settings),guilds_json:JSON.stringify([{id:'11111111111111111',name:'防災サーバー'}])},{'11111111111111111':[{id:'22222222222222222',name:'地震速報'}]});
 assert.equal(account.discordName,'DPI利用者');
 assert.equal(account.rules[0].name,'首都圏EEW');
 assert.equal(account.rules[0].guildName,'防災サーバー');
 assert.deepEqual(account.rules[0].channels,[{id:'22222222222222222',name:'地震速報'},{id:'33333333333333333',name:''}]);
 assert.deepEqual(account.rules[0].details.map(item=>item.value),['緊急地震速報','緊急地震速報（警報）','関東甲信地方','いずれかを満たす（OR）','震度5弱以上','上昇時のみ','対象警報地方のみ','マグニチュード：M6.5以上']);
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
 assert.match(billingSource,/payment_intent_data\[setup_future_usage\].*off_session/);
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
 for(const action of ['change_subscription','grant_credit','remove_credit','create_payment_link','refund_latest','cancel_at_period_end','cancel_immediately','reset_checkout_state'])assert.match(html,new RegExp(`value="${action}"`));
 assert.match(worker,/input\.action === 'reset_checkout_state'[\s\S]*SUPPORTER_BILLING_MODE !== 'test'/);
 assert.match(worker,/SET checkout_key=NULL, checkout_id=NULL, checkout_params=NULL/);
 assert.match(script,/Stripe Customerと契約情報は保持されます/);
 assert.match(script,/crypto\.randomUUID\(\)/);
 assert.match(script,/openDetails/);
 assert.match(html,/id="detail-dialog"/);
 assert.match(worker,/supporterAdminDetails/);
 assert.doesNotMatch(script,/\.innerHTML\s*=/);
});
test('Stripe customer balance converts to non-negative yen credits',()=>{
 assert.equal(creditsFromBalance(-500),500);
 assert.equal(creditsFromBalance(0),0);
 assert.equal(creditsFromBalance(200),0);
});
test('credits pay the immediate plan difference first and the next option invoice second',()=>{
 assert.deepEqual(creditApplication(1000,600,1480),{available:1000,immediateCreditApplied:600,nextInvoiceCreditApplied:400,totalCreditApplied:1000,immediateDue:0,nextInvoiceDue:1080,remainingAfterNext:0});
 assert.deepEqual(creditApplication(400,0,500),{available:400,immediateCreditApplied:0,nextInvoiceCreditApplied:400,totalCreditApplied:400,immediateDue:0,nextInvoiceDue:100,remainingAfterNext:0});
 assert.deepEqual(creditApplication(1000,0,500),{available:1000,immediateCreditApplied:0,nextInvoiceCreditApplied:500,totalCreditApplied:500,immediateDue:0,nextInvoiceDue:0,remainingAfterNext:500});
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
  const preview=await previewResponse.json();assert.equal(preview.planChanged,true);assert.deepEqual(preview.planProrationBreakdown,{unusedPlanCredit:100,newPlanCharge:700,net:600});assert.equal(preview.planProration,600);assert.equal(preview.creditApplied,100);assert.equal(preview.immediateCreditApplied,100);assert.equal(preview.nextInvoiceCreditApplied,0);assert.equal(preview.immediateDue,500);assert.equal(preview.nextInvoiceSubtotal,1480);assert.equal(preview.nextInvoiceDue,1480);assert.equal(preview.next.servers,5);assert.equal(preview.next.channels,23);
  const previewCall=calls.find(call=>call.path==='/v1/invoices/create_preview');assert.equal(previewCall.params.get('subscription_details[items][0][price]'),'price_pro');assert.equal(previewCall.params.get('subscription_details[items][1][price]'),null);
  calls.length=0;
  const requestId='123e4567-e89b-42d3-a456-426614174000';
  const blocked=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'pro',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,expectedCreditApplied:100,useCredits:false,requestId});
  assert.equal(blocked.status,409);assert.equal(calls.some(call=>call.path==='/v1/subscriptions/sub_x'),false);calls.length=0;
  const updateResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'pro',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,expectedCreditApplied:100,useCredits:true,requestId});
  assert.equal(updateResponse.status,200);
  const updates=calls.filter(call=>call.path==='/v1/subscriptions/sub_x');
  const base=updates.find(call=>call.params.get('proration_behavior')==='always_invoice');
  const options=updates.find(call=>call.params.get('proration_behavior')==='none');
  assert.equal(base.params.get('proration_date'),String(preview.prorationDate));assert.equal(base.params.get('items[0][price]'),'price_pro');
  assert.equal(options.params.get('items[0][price]'),'price_addon');assert.equal(options.params.get('items[0][quantity]'),'1');assert.equal(options.params.get('proration_date'),null);
 } finally {globalThis.fetch=originalFetch;}
});
test('option-only additions apply credits to the next 26th invoice after user confirmation',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 const renewal=Math.floor(Date.now()/1000)+86400;
 const current={id:'sub_options',status:'active',customer:'cus_x',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:renewal,price:{id:'price_basic',unit_amount:300,currency:'jpy'}}]}};
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:'user@example.jp'};if(sql.includes('supporter_billing'))return{discord_user_id:'123',customer_id:'cus_x'};return null;},async run(){return{meta:{changes:1}};}};}};
 const calls=[];const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;const params=new URLSearchParams(init.body||'');calls.push({path,method:init.method||'GET',params});let data={livemode:false};
  if(path==='/v1/subscriptions')data={livemode:false,data:[current]};
  else if(path==='/v1/customers/cus_x')data={livemode:false,balance:-400};
  else if(path==='/v1/subscriptions/sub_options')data={...current,livemode:false};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const previewResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0});
  const preview=await previewResponse.json();assert.equal(preview.planChanged,false);assert.equal(preview.planProration,0);assert.equal(preview.immediateCreditApplied,0);assert.equal(preview.nextInvoiceCreditApplied,400);assert.equal(preview.creditApplied,400);assert.equal(preview.immediateDue,0);assert.equal(preview.nextInvoiceSubtotal,500);assert.equal(preview.nextInvoiceDue,100);
  assert.equal(calls.some(call=>call.path==='/v1/invoices/create_preview'),false);calls.length=0;
  const requestId='123e4567-e89b-42d3-a456-426614174001';
  const blocked=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,expectedCreditApplied:400,useCredits:false,requestId});
  assert.equal(blocked.status,409);assert.equal(calls.some(call=>call.path==='/v1/subscriptions/sub_options'),false);calls.length=0;
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,expectedCreditApplied:400,useCredits:true,requestId});
  assert.equal(response.status,200);const result=await response.json();assert.match(result.message,/26日の請求書確定時に消費/);assert.deepEqual(result.creditApplication,{immediate:0,nextInvoice:400,nextInvoiceDue:100});
  const optionUpdate=calls.find(call=>call.path==='/v1/subscriptions/sub_options'&&call.method==='POST');assert.equal(optionUpdate.params.get('proration_behavior'),'none');assert.equal(optionUpdate.params.get('items[0][price]'),'price_addon');assert.equal(optionUpdate.params.get('items[0][quantity]'),'1');
 }finally{globalThis.fetch=originalFetch;}
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
 const [source,html,worker]=await Promise.all([
  readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/index.html',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),
 ]);
 assert.match(source,/function stripeDestination\(value\)/);
 assert.doesNotMatch(source,/new URL\(result\.url\)/);
 assert.match(source,/checkout\.stripe\.com/);
 assert.match(source,/billing\.stripe\.com/);
 assert.match(source,/invoice\.stripe\.com/);
 assert.match(source,/pay\.stripe\.com/);
 assert.match(source,/このプランで申し込む/);
 assert.match(source,/hasExistingContract/);
 assert.match(source,/契約済み（新規申込不可）/);
 assert.match(source,/email:billingEmail\.value/);
 assert.match(source,/legalConsent:true/);
 assert.match(source,/\/terms\/terms\.html/);
 assert.match(source,/\/terms\/policy\.html/);
 assert.match(source,/\/terms\/Specified\.html/);
 assert.match(source,/billingActionStatus\.textContent=error\.message/);
 assert.doesNotMatch(html,/id="register"/);
 assert.match(worker,/path\.endsWith\('\/checkout'\)[\s\S]*supporterConsentVersion\(input,env\)[\s\S]*legal_consent_version/);
});

test('paid plan configuration contains test catalog IDs and consent storage',async()=>{
 const [configText,migration,terms,policy,specified,billingSource]=await Promise.all([
  readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),
  readFile(new URL('../migrations/0015_supporter_legal_consent.sql',import.meta.url),'utf8'),
  readFile(new URL('../terms/terms.md',import.meta.url),'utf8'),
  readFile(new URL('../terms/policy.md',import.meta.url),'utf8'),
  readFile(new URL('../terms/spec.md',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
 ]);
 const config=JSON.parse(configText);
 assert.equal(config.vars.SUPPORTER_BILLING_MODE,'test');
 for(const key of ['STRIPE_PRICE_SUPPORTER','STRIPE_PRICE_PLUS','STRIPE_PRICE_PRO','STRIPE_PRICE_ADDON','STRIPE_PORTAL_CONFIG','SUPPORTER_CONSENT_VERSION'])assert.ok(config.vars[key]);
 assert.match(migration,/legal_consent_version/);assert.match(migration,/legal_consent_at/);
 assert.match(billingSource,/dpi_legal_consent_version/);
 assert.match(terms,/第 10 条（有料通知プラン）/);assert.match(terms,/故意または重大な過失/);
 assert.match(policy,/Stripe/);assert.match(policy,/安全管理措置/);
 for(const text of ['販売価格','支払時期・請求日','契約期間・自動更新','解約方法・条件','キャンセル・返金'])assert.match(specified,new RegExp(text));
});
test('billing dunning sends success and failure mail and blocks access after month-end failure',async()=>{
 const [billingSource,supporterSource,uiSource,migration,configText,indexSource]=await Promise.all([
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),readFile(new URL('../migrations/0017_supporter_dunning.sql',import.meta.url),'utf8'),readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),readFile(new URL('../worker/index.js',import.meta.url),'utf8'),
 ]);
 assert.match(billingSource,/invoice\.payment_failed/);assert.match(billingSource,/invoice\.paid/);assert.match(billingSource,/auto_advance:'false'/);assert.match(billingSource,/月末再決済/);assert.match(billingSource,/payment_succeeded/);assert.match(billingSource,/status='suspended'/);
 assert.match(supporterSource,/supporter_dunning[\s\S]*status='suspended'/);assert.match(uiSource,/usageSuspended/);
 assert.match(migration,/CREATE TABLE IF NOT EXISTS supporter_dunning/);assert.match(migration,/supporter_billing_notifications/);
 assert.deepEqual(JSON.parse(configText).triggers.crons,['0 3 * * *','5 15 * * *']);assert.match(indexSource,/runSupporterBillingSchedule/);
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
 assert.match(source,/expectedCreditApplied/);
 assert.match(source,/credit-consent/);
 assert.match(source,/クレジットを.*使用し、今回/);
 assert.match(source,/次回26日のお支払い見込み/);
 assert.doesNotMatch(source,/window\.confirm\('契約内容を更新/);
 assert.match(source,/rules\.push\(normalizeRule[\s\S]+render\(\);[\s\S]+await loadChannels/);
 assert.match(source,/チャンネルを再取得/);
 assert.match(source,/channel-refresh/);
 assert.match(source,/response\.text\(\)/);
 assert.match(source,/unexpected_html_response/);
 assert.match(source,/method==='GET'&&retry&&response\.status>=500/);
 assert.match(source,/rule-condition-fields/);
 assert.match(source,/magnitude-condition-row/);
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
