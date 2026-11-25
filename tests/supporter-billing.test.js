import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {adminBillingAction,adminDisciplinaryBillingAction,billingAction,billingWebhook,selection,billingReady,billingSchedule,creditApplication,creditExpiresAt,creditSignupSubscriptionParams,creditsFromBalance,customerInvoices,dunningSchedule,expireSupporterPendingCheckouts,normalizeCreditTopupAmount,paidCheckoutSubscriptionParams,provisionCreditFundedSignup,provisionPaidCheckoutSubscription,prorationBreakdown,reconcilePaidCheckoutSubscription,reconcilePendingCreditTopups,reconcileStoredRulesForCustomer,rejectDisciplinedCheckout,scheduledChangeSummary,sendSupporterDisciplinaryNotification,staleCheckoutAttempt,subscriptionSummary,verifySignature} from '../worker/supporter-billing.js';
import {assertSupporterAccountActive,changeSupporterAccountStatus,supporterAccountEnforcement,supporterAdminAccount,supporterAdminDetails,supporterCreditMetrics} from '../worker/supporter.js';
import {readFile} from 'node:fs/promises';
test('plan, channel and server add-ons are server controlled',()=>{
 assert.deepEqual(selection({plan:'supporter',channelPacks:2,serverPacks:1}),{plan:'supporter',packs:2,channelPacks:2,serverPacks:1,rulePacks:0,baseMonthly:300,monthly:900,channels:8,servers:3,rules:5,complexConditions:false,multiDestination:false});
 assert.deepEqual(selection({plan:'plus',channelPacks:1,serverPacks:0}),{plan:'plus',packs:1,channelPacks:1,serverPacks:0,rulePacks:0,baseMonthly:800,monthly:1000,channels:13,servers:3,rules:15,complexConditions:false,multiDestination:false});
 assert.deepEqual(selection({plan:'pro',channelPacks:0,serverPacks:0}),{plan:'pro',packs:0,channelPacks:0,serverPacks:0,rulePacks:0,baseMonthly:1280,monthly:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true});
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
test('credit-funded signup creates the fixed-26th subscription without card details or a trial',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon'};
 const choice=selection({plan:'plus',channelPacks:1,serverPacks:1}),schedule={anchor:1800000000,initialMonths:1,lateMonth:false};
 const params=creditSignupSubscriptionParams(env,'cus_credit','637850681666961408',choice,schedule,'2026-11-15','123e4567-e89b-42d3-a456-426614174100');
 assert.equal(params.customer,'cus_credit');assert.equal(params.billing_cycle_anchor,'1800000000');assert.equal(params.proration_behavior,'none');assert.equal(params.payment_behavior,'error_if_incomplete');
 assert.equal(params['items[0][price]'],'price_plus');assert.equal(params['items[1][price]'],'price_addon');assert.equal(params['items[1][quantity]'],'2');
 assert.equal(params['metadata[dpi_initial_payment_method]'],'credit_balance');assert.equal(params.default_payment_method,undefined);assert.equal(params.trial_end,undefined);assert.equal(params.payment_method_types,undefined);
});

test('sufficient charged credits can activate a plan once without opening card Checkout',async()=>{
 const uid='637850681666961408',requestId='123e4567-e89b-42d3-a456-426614174101';
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',NOTICE_EMAIL:{async send(){sent+=1;}},NOTICE_FROM_EMAIL:'notice@dpi-bot.com'};
 let attempt=null,subscription=null,balance=-1000,noticeStatus=null,sent=0;
 const db={prepare(sql){let values=[];const statement={sql,values,bind(...input){values=input;this.values=input;return this;},async first(){
   if(sql.includes('FROM supporter_credit_signups WHERE request_id='))return attempt&&attempt.request_id===values[0]?{...attempt}:null;
   if(sql.includes("FROM supporter_credit_signups WHERE discord_user_id=")&&sql.includes("status IN ('pending','debited')"))return attempt&&['pending','debited'].includes(attempt.status)?{...attempt}:null;
   if(sql.includes('JOIN supporter_billing'))return{billing_email:'credit@example.jp'};
   if(sql.includes('supporter_billing_notifications'))return noticeStatus?{status:noticeStatus}:null;
   return null;
  },async run(){
   if(sql.includes('INSERT INTO supporter_credit_signups'))attempt={request_id:values[0],discord_user_id:values[1],customer_id:values[2],plan_id:values[3],channel_packs:values[4],server_packs:values[5],rule_packs:values[6],amount:values[7],billing_anchor:values[8],legal_consent_version:values[9],status:'pending'};
   if(sql.includes("status='debited'")){attempt.balance_transaction_id=values[0];attempt.status='debited';}
   if(sql.includes("status='provisioned'")){attempt.balance_transaction_id=attempt.balance_transaction_id||values[0];attempt.subscription_id=values[1];attempt.status='provisioned';}
   if(sql.includes('INSERT INTO supporter_billing_notifications')&&!noticeStatus)noticeStatus='pending';
   if(sql.includes("SET status='sending'"))noticeStatus='sending';
   if(sql.includes("SET status='sent'"))noticeStatus='sent';
   return{meta:{changes:1}};
  }};return statement;},async batch(statements){for(const statement of statements)await statement.run();return statements.map(()=>({meta:{changes:1}}));}};
 const calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET',params=new URLSearchParams(init.body||'');calls.push({path,method,params});let data={livemode:false};
  if(path==='/v1/subscriptions'&&method==='GET')data={livemode:false,data:subscription?[subscription]:[]};
  else if(path==='/v1/customers/cus_credit'&&method==='GET')data={livemode:false,balance};
  else if(path==='/v1/customers/cus_credit/balance_transactions'){balance+=Number(params.get('amount'));data={livemode:false,id:'cbtxn_signup',ending_balance:balance};}
  else if(path==='/v1/subscriptions'&&method==='POST'){subscription={livemode:false,id:'sub_credit',status:'active',customer:'cus_credit',metadata:{dpi_credit_signup_request_id:requestId},items:{data:[]}};data=subscription;}
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const choice=selection({plan:'supporter',channelPacks:0,serverPacks:0});
  const first=await provisionCreditFundedSignup(env,db,uid,'cus_credit',choice,{requestId,legalConsentVersion:'2026-11-15'});
  assert.equal(first.amount,300);assert.equal(first.balanceAfter,700);assert.equal(attempt.status,'provisioned');assert.equal(sent,1);
  const debit=calls.find(call=>call.path.endsWith('/balance_transactions'));assert.equal(debit.params.get('amount'),'300');
  const create=calls.find(call=>call.path==='/v1/subscriptions'&&call.method==='POST');assert.equal(create.params.get('default_payment_method'),null);assert.equal(create.params.get('trial_end'),null);
  assert.equal(calls.some(call=>call.path==='/v1/checkout/sessions'),false);
  const debitCount=calls.filter(call=>call.path.endsWith('/balance_transactions')).length;
  const second=await provisionCreditFundedSignup(env,db,uid,'cus_credit',choice,{requestId,legalConsentVersion:'2026-11-15'});
  assert.equal(second.recovered,true);assert.equal(calls.filter(call=>call.path.endsWith('/balance_transactions')).length,debitCount);
 }finally{globalThis.fetch=originalFetch;}
});

test('credit-funded signup rejects insufficient balance before consuming credits',async()=>{
 const uid='637850681666961408',requestId='123e4567-e89b-42d3-a456-426614174102';let attempt=null;
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.includes('request_id='))return attempt;if(sql.includes("status IN ('pending','debited')"))return null;return null;},async run(){if(sql.includes('INSERT INTO supporter_credit_signups'))attempt={request_id:values[0],discord_user_id:values[1],customer_id:values[2],plan_id:values[3],channel_packs:values[4],server_packs:values[5],rule_packs:values[6],amount:values[7],billing_anchor:values[8],legal_consent_version:values[9],status:'pending'};if(sql.includes("status='failed'"))attempt.status='failed';return{meta:{changes:1}};}};}};
 const calls=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;calls.push(path);const data=path==='/v1/subscriptions'?{livemode:false,data:[]}:{livemode:false,balance:-100};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  await assert.rejects(()=>provisionCreditFundedSignup(env,db,uid,'cus_credit',selection({plan:'supporter',channelPacks:0,serverPacks:0}),{requestId,legalConsentVersion:'2026-11-15'}),error=>error.status===409&&/不足/.test(error.message));
  assert.equal(attempt.status,'failed');assert.equal(calls.some(path=>path.endsWith('/balance_transactions')),false);
 }finally{globalThis.fetch=originalFetch;}
});
test('credit-funded signup restores the consumed balance when subscription creation fails',async()=>{
 const uid='637850681666961408',requestId='123e4567-e89b-42d3-a456-426614174103';let attempt=null,balance=-1000;
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.includes('request_id='))return attempt;if(sql.includes("status IN ('pending','debited')"))return attempt&&['pending','debited'].includes(attempt.status)?attempt:null;return null;},async run(){if(sql.includes('INSERT INTO supporter_credit_signups'))attempt={request_id:values[0],discord_user_id:values[1],customer_id:values[2],plan_id:values[3],channel_packs:values[4],server_packs:values[5],rule_packs:values[6],amount:values[7],billing_anchor:values[8],legal_consent_version:values[9],status:'pending'};if(sql.includes("status='debited'")){attempt.balance_transaction_id=values[0];attempt.status='debited';}if(sql.includes("status='refunded'"))attempt.status='refunded';return{meta:{changes:1}};}};}};
 const balanceAmounts=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET',params=new URLSearchParams(init.body||'');let data={livemode:false};let status=200;
  if(path==='/v1/subscriptions'&&method==='GET')data={livemode:false,data:[]};
  else if(path==='/v1/subscriptions'&&method==='POST'){status=500;data={error:{message:'temporary failure'}};}
  else if(path==='/v1/customers/cus_credit'&&method==='GET')data={livemode:false,balance};
  else if(path.endsWith('/balance_transactions')){const amount=Number(params.get('amount'));balanceAmounts.push(amount);balance+=amount;data={livemode:false,id:amount>0?'cbtxn_debit':'cbtxn_reversal',ending_balance:balance};}
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 };
 try{
  await assert.rejects(()=>provisionCreditFundedSignup(env,db,uid,'cus_credit',selection({plan:'supporter',channelPacks:0,serverPacks:0}),{requestId,legalConsentVersion:'2026-11-15'}),error=>error.status===502);
  assert.deepEqual(balanceAmounts,[300,-300]);assert.equal(balance,-1000);assert.equal(attempt.status,'refunded');
 }finally{globalThis.fetch=originalFetch;}
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
test('決済はモードとキーの種類が一致したときだけ有効（既定・誤字・食い違いは無効）',()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_live_example',STRIPE_WEBHOOK_SECRET:'x',STRIPE_PRICE_SUPPORTER:'x',STRIPE_PRICE_PLUS:'x',STRIPE_PRICE_PRO:'x',STRIPE_PRICE_ADDON:'x',STRIPE_PORTAL_CONFIG:'x'};
 assert.equal(billingReady(env),false);env.STRIPE_SECRET_KEY='sk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_test_example';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_live_example';assert.equal(billingReady(env),false);
 env.SUPPORTER_BILLING_MODE='live';assert.equal(billingReady(env),true);
 env.STRIPE_SECRET_KEY='rk_test_example';assert.equal(billingReady(env),false);
 for(const mode of ['Live','LIVE','production','',undefined]){env.SUPPORTER_BILLING_MODE=mode;env.STRIPE_SECRET_KEY='sk_live_example';assert.equal(billingReady(env),false);}
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
 assert.equal(result.servers,3);
 assert.deepEqual(result.items.map(item=>[item.label,item.quantity,item.subtotal]),[['BASIC',1,300],['追加オプション',2,400]]);
});

test('未知のStripe価格は契約枠として扱わずルールを破壊しない',()=>{
 const env={STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon'};
 const summary=subscriptionSummary({status:'active',items:{data:[{quantity:1,price:{id:'price_unknown',unit_amount:999,currency:'jpy'}}]}},env);
 assert.equal(summary.recognizedPlan,false);assert.equal(summary.planId,'');assert.equal(summary.rules,0);assert.equal(summary.channels,0);assert.equal(summary.servers,0);
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
 assert.deepEqual(account.rules[0].details.map(item=>item.value),['緊急地震速報','緊急地震速報（警報）','関東甲信地方','いずれかを満たす（OR）','送信する（初期値）','震度5弱以上','上昇時のみ','対象警報地方のみ','マグニチュード：M6.5以上']);
});
test('paid plans stay separate from secondary-use applications and private in navigation',async()=>{
 const [reuseHtml,reuseScript,basicHtml,billingSource,billingUi]=await Promise.all([
  readFile(new URL('../site/reuse/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/reuse/script.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/index.html',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),
 ]);
 assert.doesNotMatch(reuseHtml,/basic-dashboard-card|BASIC/);
 assert.doesNotMatch(reuseScript,/api\/supporter/);
 assert.match(basicHtml,/BASIC/);
 assert.doesNotMatch(basicHtml,/service-dashboard/);
 assert.doesNotMatch(basicHtml,/<nav[\s\S]*?<a href="\/site\/supporter\//);
 // 支払い方法の指定はダッシュボードに任せる（コードで列挙しない）。除外（プランでの PayPay）だけは許す。
 assert.doesNotMatch(billingSource,/(?<!excluded_)payment_method_types/);
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
 assert.match(billingUi,/連絡先メールアドレス/);
 assert.match(billingUi,/契約・請求に関するお知らせに使用します/);
 assert.match(billingUi,/チャージ結果のお知らせに使用します/);
 assert.doesNotMatch(billingUi,/利用する操作を選択|ページを移動せず/);
 assert.match(billingUi,/クレジットチャージ式/);
 assert.match(billingUi,/クレジット支払い式/);
 assert.match(billingUi,/setBillingMode/);
 assert.match(billingUi,/topupEmail\.value/);
 assert.match(billingUi,/クレジットでプランを申し込む/);
 assert.match(billingUi,/残高・履歴を再読み込み/);
 assert.match(billingUi,/creditTopupRecovery/);
 assert.match(billingUi,/クレジットが.*不足しています/);
 assert.match(billingUi,/selectedInitialCharge/);
 assert.match(billingUi,/email:topupEmail\.value[\s\S]*useCredits:true/);
 assert.match(billingUi,/クレジットで全額支払う/);
 assert.match(billingUi,/useCredits:creditPaymentInput\.checked/);
 assert.match(billingUi,/クレジット＋登録済みのお支払い方法/);
 assert.match(billingUi,/クレジットを使って変更を確定/);
 assert.match(billingUi,/hasExistingContract[\s\S]*残クレジットでプラン・オプションを変更[\s\S]*preview-update/);
 assert.match(billingUi,/アップグレード差額と次回26日の請求に利用できます/);
});
test('admin billing operations require confirmation, reason, same-origin and audit logging',async()=>{
 const [worker,html,script,statistics]=await Promise.all([
  readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/app.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/stats.js',import.meta.url),'utf8'),
 ]);
 assert.match(worker,/assertAdminOrigin\(request\)/);
 assert.match(worker,/input\.confirmDiscordUserId !== uid/);
 assert.match(worker,/writeSupporterAudit/);
 for(const action of ['change_subscription','grant_credit','remove_credit','confiscate_credit','disciplinary_cancel','ban_account','unban_account','create_payment_link','refund_latest','cancel_at_period_end','cancel_immediately','reset_checkout_state'])assert.match(html,new RegExp(`value="${action}"`));
 assert.match(worker,/input\.action === 'reset_checkout_state'[\s\S]*SUPPORTER_BILLING_MODE !== 'test'/);
 assert.match(worker,/SET checkout_key=NULL, checkout_id=NULL, checkout_params=NULL/);
 assert.match(script,/Stripe Customerと契約情報は保持されます/);
 assert.match(script,/crypto\.randomUUID\(\)/);
 assert.match(script,/openDetails/);
 assert.match(html,/id="detail-dialog"/);
 assert.match(worker,/supporterAdminDetails/);
 assert.match(worker,/recordAdminCreditLot/);
 assert.match(worker,/source_type IN \('admin','purchase'\)/);
 assert.match(worker,/changeSupporterAccountStatus/);
 assert.match(worker,/assertSupporterAccountActive/);
 assert.match(worker,/expireSupporterPendingCheckouts/);
 assert.match(script,/全クレジットを没収/);
 assert.match(script,/全契約を即時解除し、残クレジットをすべて没収/);
 assert.match(script,/再度支払うことで申込み/);
 assert.match(script,/再申込み不可のBAN状態/);
 assert.match(html,/credit-legal-monitor/);
 assert.match(html,/契約・クレジット統計を見る/);
 assert.match(statistics,/総クレジット/);
 assert.match(statistics,/保有者数/);
 assert.doesNotMatch(script,/総合クレジット数/);
 assert.match(script,/届出基準/);
 assert.doesNotMatch(script,/\.innerHTML\s*=/);
});
test('BAN状態は理由付きで返り、BAN中の有料機能操作を拒否する',async()=>{
 const active=supporterAccountEnforcement({account_status:'active'});assert.deepEqual(active,{suspended:false,status:'active',reason:'',updatedAt:null});
 const stopped={account_status:'suspended',status_reason:'不正利用の調査中',status_updated_at:'2026-11-15T01:00:00.000Z'};
 assert.deepEqual(supporterAccountEnforcement(stopped),{suspended:true,status:'suspended',reason:'不正利用の調査中',updatedAt:'2026-11-15T01:00:00.000Z'});
 assert.throws(()=>assertSupporterAccountActive(stopped),error=>error.status===403&&/不正利用の調査中/.test(error.message));
 let networkCalls=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{networkCalls+=1;throw new Error('Stripeへ到達してはいけません');};
 const db={prepare(){return{bind(){return this;},async first(){return{discord_user_id:'123',billing_email:'user@example.jp',...stopped};},async run(){return{meta:{changes:1}};}};}};
 try{
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/topup'),{SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'},db,'123',{amount:500});
  assert.equal(response.status,403);assert.match((await response.json()).message,/BAN/);assert.equal(networkCalls,0);
 }finally{globalThis.fetch=originalFetch;}
});
test('管理者のBAN・解除は状態を競合防止付きで更新し同じリクエストを二重適用しない',async()=>{
 let account={account_status:'active',status_request_id:null,status_reason:'',status_updated_at:null,status_updated_by:null},updates=0;
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){return{...account};},async run(){
  if(sql.startsWith('UPDATE supporter_accounts')){
   if((account.account_status||'active')!==values[7])return{meta:{changes:0}};
   account={...account,account_status:values[0],status_reason:values[1],status_updated_at:values[2],status_updated_by:values[3],status_request_id:values[4]};updates+=1;return{meta:{changes:1}};
  }
  return{meta:{changes:1}};
 }};}};
 const suspendId='123e4567-e89b-42d3-a456-426614174301',resumeId='123e4567-e89b-42d3-a456-426614174302',admin={email:'admin@example.jp'};
 let result=await changeSupporterAccountStatus(db,'637850681666961408',admin,{action:'ban_account',requestId:suspendId,reason:'規約違反により利用を停止するため'});
 assert.equal(result.accountStatus,'suspended');assert.equal(account.status_reason,'規約違反により利用を停止するため');assert.equal(account.status_updated_by,'admin@example.jp');assert.equal(updates,1);
 result=await changeSupporterAccountStatus(db,'637850681666961408',admin,{action:'ban_account',requestId:suspendId,reason:'規約違反により利用を停止するため'});
 assert.equal(result.idempotent,true);assert.equal(updates,1);
 result=await changeSupporterAccountStatus(db,'637850681666961408',admin,{action:'unban_account',requestId:resumeId,reason:'調査完了によりBANを解除'});
 assert.equal(result.accountStatus,'active');assert.equal(updates,2);
});
test('全クレジット没収は指定額ではなく実行時点のStripe残高を一度に0へする',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,params=new URLSearchParams(init.body||'');calls.push({path,params});const data=path.endsWith('/balance_transactions')?{livemode:false,id:'cbtxn_confiscated',ending_balance:0}:{livemode:false,balance:-1250};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const result=await adminBillingAction(env,'cus_x','637850681666961408',{action:'confiscate_credit',requestId:'123e4567-e89b-42d3-a456-426614174303',reason:'規約違反に伴うクレジット没収'});
  assert.equal(result.credits,0);assert.equal(result.creditEvent.delta,-1250);assert.match(result.message,/1,250クレジットを没収/);
  const transaction=calls.find(call=>call.path.endsWith('/balance_transactions'));assert.equal(transaction.params.get('amount'),'1250');assert.equal(transaction.params.get('metadata[dpi_credit_action]'),'confiscate_credit');
 }finally{globalThis.fetch=originalFetch;}
});
test('処分①は全契約を先に即時解除してから残クレジットを全額没収する',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET';calls.push({path,method,params:new URLSearchParams(init.body||'')});let data={livemode:false};
  if(path==='/v1/subscriptions')data={livemode:false,data:[{id:'sub_a',status:'active',schedule:'sched_a'},{id:'sub_b',status:'past_due'}]};
  else if(path==='/v1/customers/cus_x')data={livemode:false,balance:-1250};
  else if(path.endsWith('/balance_transactions'))data={livemode:false,id:'cbtxn_discipline',ending_balance:0};
  else if(method==='DELETE')data={livemode:false,status:'canceled'};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const result=await adminDisciplinaryBillingAction(env,'cus_x','637850681666961408',{action:'disciplinary_cancel',requestId:'123e4567-e89b-42d3-a456-426614174304',reason:'規約違反に伴う契約解除処分'});
  assert.equal(result.canceledSubscriptions,2);assert.equal(result.confiscatedCredits,1250);assert.equal(result.creditEvent.delta,-1250);
  const deletes=calls.filter(call=>call.method==='DELETE');assert.deepEqual(deletes.map(call=>call.path),['/v1/subscriptions/sub_a','/v1/subscriptions/sub_b']);
  assert.ok(calls.findIndex(call=>call.path==='/v1/subscription_schedules/sched_a/release')<calls.findIndex(call=>call.path==='/v1/subscriptions/sub_a'));
  const confiscationIndex=calls.findIndex(call=>call.path.endsWith('/balance_transactions'));assert.ok(confiscationIndex>calls.findLastIndex(call=>call.method==='DELETE'));
  assert.equal(calls[confiscationIndex].params.get('metadata[dpi_disciplinary_action]'),'disciplinary_cancel');
 }finally{globalThis.fetch=originalFetch;}
});
test('BANはStripe顧客情報がない登録者でも実行できるが契約解除処分は拒否する',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const input={requestId:'123e4567-e89b-42d3-a456-426614174305',reason:'規約違反に伴うアカウント停止'};
 const banned=await adminDisciplinaryBillingAction(env,null,'637850681666961408',{...input,action:'ban_account'});
 assert.equal(banned.canceledSubscriptions,0);assert.equal(banned.confiscatedCredits,0);
 await assert.rejects(()=>adminDisciplinaryBillingAction(env,null,'637850681666961408',{...input,action:'disciplinary_cancel'}),error=>error.status===409);
});
test('処分開始時は未完了の申込み・チャージCheckoutを期限切れにする',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){return{bind(){return this;},async first(){return{checkout_id:'cs_plan'};},async all(){return{results:[{checkout_session_id:'cs_topup'}]};},async run(){return{meta:{changes:1}};}};},async batch(statements){return statements.map(()=>({meta:{changes:1}}));}};
 const calls=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET';calls.push({path,method});return new Response(JSON.stringify({livemode:false,id:path.split('/').at(-1),status:path.endsWith('/expire')?'expired':'open'}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const expired=await expireSupporterPendingCheckouts(env,db,'637850681666961408','123e4567-e89b-42d3-a456-426614174307');assert.equal(expired,2);
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/expire')).map(call=>call.path),['/v1/checkout/sessions/cs_plan/expire','/v1/checkout/sessions/cs_topup/expire']);
 }finally{globalThis.fetch=originalFetch;}
});
test('処分確定前に作成された支払い済みCheckoutは契約・クレジットを付与せず返金する',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('account_status'))return{account_status:'suspended'};return null;},async run(){return{meta:{changes:1}};}};},async batch(statements){return statements.map(()=>({meta:{changes:1}}));}};
 const calls=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init={})=>{calls.push({path:new URL(url).pathname,params:new URLSearchParams(init.body||'')});return new Response(JSON.stringify({livemode:false,id:'re_banned',status:'succeeded'}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const rejected=await rejectDisciplinedCheckout(env,db,{id:'cs_paid',mode:'payment',payment_status:'paid',payment_intent:'pi_paid',client_reference_id:'637850681666961408',metadata:{dpi_user:'637850681666961408',dpi_checkout_kind:'initial_subscription'},created:1700000000});
  assert.equal(rejected,true);const refund=calls.find(call=>call.path==='/v1/refunds');assert.equal(refund.params.get('payment_intent'),'pi_paid');assert.equal(refund.params.get('metadata[dpi_reason]'),'disciplinary_checkout_rejection');
 }finally{globalThis.fetch=originalFetch;}
});
test('処分メールは理由・解除件数・没収額を通知し同じ処分IDでは二重送信しない',async()=>{
 let noticeStatus='pending',sent=0;const messages=[];
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.startsWith('SELECT status'))return{status:noticeStatus};return null;},async run(){
  if(sql.startsWith('INSERT INTO supporter_billing_notifications'))return{meta:{changes:noticeStatus?'0':1}};
  if(sql.includes("SET status='sending'")){if(['pending','failed'].includes(noticeStatus)){noticeStatus='sending';return{meta:{changes:1}};}return{meta:{changes:0}};}
  if(sql.includes("SET status='sent'")){noticeStatus='sent';return{meta:{changes:1}};}return{meta:{changes:1}};
 }};}};
 const env={NOTICE_EMAIL:{async send(message){sent+=1;messages.push(message);}},NOTICE_FROM_EMAIL:'notice@dpi-bot.com',NOTICE_REPLY_TO_EMAIL:'support@dpi-bot.com'};
 const details={requestId:'123e4567-e89b-42d3-a456-426614174306',uid:'637850681666961408',email:'user@example.jp',reason:'規約違反に伴う契約解除処分',canceledSubscriptions:2,confiscatedCredits:1250};
 assert.equal(await sendSupporterDisciplinaryNotification(env,db,'disciplinary_cancel',details),true);
 assert.equal(await sendSupporterDisciplinaryNotification(env,db,'disciplinary_cancel',details),true);
 assert.equal(sent,1);assert.match(messages[0].text,/解除した契約: 2件/);assert.match(messages[0].text,/没収クレジット: 1,250クレジット/);assert.match(messages[0].text,/再度お支払いいただくことで/);
});
test('管理者クレジット集計はStripe総残高と有償ロットを分離して1000万円基準を返す',async()=>{
 const now=Math.floor(Date.now()/1000);
 const lots=[{id:'lot1',discord_user_id:'100',source_type:'purchase',remaining_amount:800,expires_at:now+90*86400},{id:'lot2',discord_user_id:'200',source_type:'purchase',remaining_amount:500,expires_at:now+10*86400}];
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async all(){return{results:lots.map(lot=>({...lot}))};},async run(){
  if(sql.startsWith('UPDATE supporter_credit_lots')){const lot=lots.find(item=>item.id===values[3]);if(lot&&lot.remaining_amount===values[4]){lot.remaining_amount=values[0];lot.status=values[1];return{meta:{changes:1}};}}
  return{meta:{changes:0}};
 },async first(){
  if(sql.includes('SUM(remaining_amount)')){const active=lots.filter(lot=>lot.status!=='consumed'&&lot.remaining_amount>0);return{balance:active.reduce((sum,lot)=>sum+lot.remaining_amount,0),users:new Set(active.map(lot=>lot.discord_user_id)).size,next_expiry:Math.min(...active.map(lot=>lot.expires_at)),expiring_30d:active.filter(lot=>lot.expires_at<=now+30*86400).reduce((sum,lot)=>sum+lot.remaining_amount,0)};}
  if(sql.includes('SUM(amount-refunded_amount)'))return{net_purchased:1500,purchasers:2};
  if(sql.includes("reason='credit_expired'"))return{expired:100};
  return null;
 }};}};
 const rows=[{discord_user_id:'100',customer_id:'cus_1'},{discord_user_id:'200',customer_id:'cus_2'},{discord_user_id:'300',customer_id:'cus_3'}];
 const result=await supporterCreditMetrics(db,rows,new Map([['cus_1',1000],['cus_2',200],['cus_3',0]]),true);
 assert.equal(result.totalCredits,1200);assert.equal(result.creditUsers,2);
 assert.equal(result.purchasedBalance,1000);assert.equal(result.otherCredits,200);assert.equal(result.purchasedUsers,2);
 assert.equal(result.netPurchased,1500);assert.equal(result.purchasers,2);assert.equal(result.expiredCredits,100);assert.equal(result.expiring30Days,200);
 assert.equal(result.legalThreshold,10_000_000);assert.equal(result.legalUsageRate,0.0001);
});
test('Stripe customer balance converts to non-negative yen credits',()=>{
 assert.equal(creditsFromBalance(-500),500);
 assert.equal(creditsFromBalance(0),0);
 assert.equal(creditsFromBalance(200),0);
});

test('クレジットチャージは500〜100000円の整数だけを受け付け、購入日の1年後に失効する',()=>{
 assert.equal(normalizeCreditTopupAmount(500),500);
 assert.equal(normalizeCreditTopupAmount('100000'),100000);
 for(const value of [499,100001,500.5,'not-a-number'])assert.throws(()=>normalizeCreditTopupAmount(value));
 assert.equal(creditExpiresAt(Date.parse('2026-11-13T12:34:56Z')/1000),Date.parse('2027-11-13T12:34:56Z')/1000);
 assert.equal(creditExpiresAt(Date.parse('2024-02-29T12:34:56Z')/1000),Date.parse('2025-02-28T12:34:56Z')/1000);
});

test('利用者ごとのStripeチャージURLへ任意金額と同意情報を固定する',async()=>{
 const uid='637850681666961408',requestId='6fb5b84e-03f7-44c0-bf04-4ee3ad22db20';
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 const topup={request_id:requestId,discord_user_id:uid,customer_id:'cus_credit',amount:1234,checkout_session_id:null,status:'pending'};
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async all(){return{results:[]};},async first(){
  if(sql.includes('FROM supporter_accounts'))return{discord_user_id:uid,billing_email:'credit@example.jp'};
  if(sql.includes('FROM supporter_billing'))return{discord_user_id:uid,customer_id:'cus_credit'};
  if(sql.includes('FROM supporter_credit_topups'))return topup;
  return null;
 },async run(){if(sql.startsWith('UPDATE supporter_credit_topups SET checkout_session_id='))topup.checkout_session_id=values[0];return{meta:{changes:1}};}};}};
 const calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,params=new URLSearchParams(init.body||'');calls.push({path,params});
  const data=path==='/v1/checkout/sessions'?{livemode:false,id:'cs_credit',status:'open',url:'https://checkout.stripe.com/c/pay/cs_credit',expires_at:1900000000}:{livemode:false,id:'cus_credit'};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/topup'),env,db,uid,{amount:1234,requestId,legalConsentVersion:'2026-11-13'});
  assert.equal(response.status,200);assert.equal((await response.json()).credits,1234);
  const checkout=calls.find(call=>call.path==='/v1/checkout/sessions');
  assert.equal(checkout.params.get('mode'),'payment');
  assert.equal(checkout.params.get('customer'),'cus_credit');
  assert.equal(checkout.params.get('client_reference_id'),uid);
  assert.equal(checkout.params.get('line_items[0][price_data][unit_amount]'),'1234');
  assert.equal(checkout.params.get('metadata[dpi_checkout_kind]'),'credit_topup');
  assert.equal(checkout.params.get('metadata[dpi_topup_request_id]'),requestId);
  assert.equal(checkout.params.get('metadata[dpi_legal_consent_version]'),'2026-11-13');
  assert.equal(checkout.params.get('payment_method_types'),null);
 }finally{globalThis.fetch=originalFetch;}
});

test('チャージ完了Webhookはクレジットを1度だけ付与して有効期限ロットを保存する',async()=>{
 const uid='637850681666961408',secret='whsec_example',timestamp=Math.floor(Date.now()/1000),executed=[],events=new Set();
 const event={id:'evt_credit_topup',created:timestamp,livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_credit_paid',mode:'payment',status:'complete',payment_status:'paid',customer:'cus_credit',payment_intent:'pi_credit',client_reference_id:uid,amount_total:1000,currency:'jpy',created:timestamp-86400,metadata:{dpi_checkout_kind:'credit_topup',dpi_user:uid,dpi_credit_amount:'1000',dpi_topup_request_id:'6fb5b84e-03f7-44c0-bf04-4ee3ad22db20'}}}};
 const raw=JSON.stringify(event),signature=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex');
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:secret,STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){let values=[];const statement={sql,values,bind(...input){values=input;this.values=input;return this;},async first(){
  if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;
  if(sql.includes('SELECT customer_id FROM supporter_billing'))return{customer_id:'cus_credit'};
  return null;
 },async run(){executed.push({sql,values});if(sql.includes('INSERT INTO supporter_stripe_events'))events.add(values[0]);return{meta:{changes:1}};}};return statement;},async batch(statements){for(const statement of statements)await statement.run();return statements.map(()=>({meta:{changes:1}}));}};
 let balanceCalls=0;const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url)=>{if(new URL(url).pathname.includes('/balance_transactions'))balanceCalls+=1;return new Response(JSON.stringify({livemode:false,id:'cbtxn_credit',ending_balance:-1000}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  for(let i=0;i<2;i+=1){const request=new Request('https://dpi-bot.com/api/supporter/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw});assert.equal((await billingWebhook(request,{...env,REUSE_DB:db})).status,200);}
  assert.equal(balanceCalls,1);
  assert.ok(executed.some(item=>item.sql.includes('INSERT INTO supporter_credit_lots')));
  assert.ok(executed.some(item=>item.sql.includes('INSERT INTO supporter_credit_events')));
  const topup=executed.find(item=>item.sql.includes('INSERT INTO supporter_credit_topups'));
  assert.equal(topup.values[6],1000);assert.equal(topup.values[8],creditExpiresAt(timestamp));
 }finally{globalThis.fetch=originalFetch;}
});
test('残高再読み込みはWebhook未反映の支払い済みチャージをStripeから復旧する',async()=>{
 const uid='637850681666961408',requestId='02624b1e-5b20-4c14-8ad9-efc8830cb540',sessionId='cs_credit_recovery',timestamp=Math.floor(Date.now()/1000),executed=[];
 const session={id:sessionId,livemode:false,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_credit',payment_intent:'pi_credit_recovery',client_reference_id:uid,amount_total:1000,currency:'jpy',created:timestamp,metadata:{dpi_checkout_kind:'credit_topup',dpi_user:uid,dpi_credit_amount:'1000',dpi_topup_request_id:requestId}};
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const db={prepare(sql){let values=[];const statement={sql,values,bind(...input){values=input;this.values=input;return this;},async all(){return sql.includes("status='pending'")?{results:[{request_id:requestId,checkout_session_id:sessionId}]}:{results:[]};},async first(){
  if(sql.includes('SELECT customer_id FROM supporter_billing'))return{customer_id:'cus_credit'};
  return null;
 },async run(){executed.push({sql,values});return{meta:{changes:1}};}};return statement;},async batch(statements){for(const statement of statements)await statement.run();return statements.map(()=>({meta:{changes:1}}));}};
 const originalFetch=globalThis.fetch;let balanceCalls=0;
 globalThis.fetch=async(url)=>{const path=new URL(url).pathname;if(path.includes('/balance_transactions')){balanceCalls+=1;return new Response(JSON.stringify({livemode:false,id:'cbtxn_recovered',ending_balance:-1000}),{status:200,headers:{'content-type':'application/json'}});}return new Response(JSON.stringify(session),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const result=await reconcilePendingCreditTopups(env,db,uid,'cus_credit');
  assert.deepEqual(result,{checked:1,recovered:1,failed:0});assert.equal(balanceCalls,1);
  assert.ok(executed.some(item=>item.sql.includes('supporter_credit_topups')&&item.sql.includes("status='credited'")));
  assert.ok(executed.some(item=>item.sql.includes('INSERT INTO supporter_credit_lots')));
 }finally{globalThis.fetch=originalFetch;}
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
 assert.deepEqual(scheduledChangeSummary({phases:[{start_date:1800000000,metadata:{dpi_channel_packs:'1',dpi_server_packs:'0'},items:[{price:'price_plus',quantity:1},{price:'price_addon',quantity:1}]}]},env,current),{effectiveAt:1800000000,plan:'Plus',planId:'plus',monthly:1000,channels:13,servers:3,rules:15,channelPacks:1,serverPacks:0,rulePacks:0});
});
test('invoice history only returns safe Stripe document links',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({livemode:false,data:[{number:'DPI-001',status:'paid',created:1700000000,currency:'jpy',total:800,amount_due:800,amount_paid:800,hosted_invoice_url:'https://invoice.stripe.com/i/test',invoice_pdf:'https://pay.stripe.com/invoice/test/pdf'},{number:'DPI-002',status:'open',created:1700000001,currency:'jpy',total:300,hosted_invoice_url:'https://evil.example/invoice'}]}),{status:200,headers:{'content-type':'application/json'}});
 try{const invoices=(await customerInvoices(env,'cus_x')).sort((a,b)=>Number(b.number==='DPI-001')-Number(a.number==='DPI-001'));assert.equal(invoices[0].hostedInvoiceUrl,'https://invoice.stripe.com/i/test');assert.equal(invoices[0].invoicePdf,'https://pay.stripe.com/invoice/test/pdf');assert.equal(invoices[1].hostedInvoiceUrl,null);}finally{globalThis.fetch=originalFetch;}
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
  const previewResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0,rulePacks:1});
  const preview=await previewResponse.json();assert.equal(preview.planChanged,false);assert.equal(preview.planProration,0);assert.equal(preview.immediateCreditApplied,0);assert.equal(preview.nextInvoiceCreditApplied,400);assert.equal(preview.creditApplied,400);assert.equal(preview.immediateDue,0);assert.equal(preview.nextInvoiceSubtotal,700);assert.equal(preview.nextInvoiceDue,300);assert.equal(preview.next.rules,8);
  assert.equal(calls.some(call=>call.path==='/v1/invoices/create_preview'),false);calls.length=0;
  const requestId='123e4567-e89b-42d3-a456-426614174001';
  const blocked=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0,rulePacks:1,prorationDate:preview.prorationDate,expectedCreditApplied:400,useCredits:false,requestId});
  assert.equal(blocked.status,409);assert.equal(calls.some(call=>call.path==='/v1/subscriptions/sub_options'),false);calls.length=0;
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'supporter',channelPacks:1,serverPacks:0,rulePacks:1,prorationDate:preview.prorationDate,expectedCreditApplied:400,useCredits:true,requestId});
  assert.equal(response.status,200);const result=await response.json();assert.match(result.message,/26日の請求書確定時に消費/);assert.deepEqual(result.creditApplication,{immediate:0,nextInvoice:400,nextInvoiceDue:300});
  const optionUpdate=calls.find(call=>call.path==='/v1/subscriptions/sub_options'&&call.method==='POST');assert.equal(optionUpdate.params.get('proration_behavior'),'none');assert.equal(optionUpdate.params.get('items[0][price]'),'price_addon');assert.equal(optionUpdate.params.get('items[0][quantity]'),'2');assert.equal(optionUpdate.params.get('metadata[dpi_rule_packs]'),'1');
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
 assert.match(source,/契約中/);
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
 const [configText,migration,creditMigration,terms,policy,specified,billingSource,uiSource]=await Promise.all([
  readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),
  readFile(new URL('../migrations/0015_supporter_legal_consent.sql',import.meta.url),'utf8'),
  readFile(new URL('../migrations/0019_supporter_credit_topups.sql',import.meta.url),'utf8'),
  readFile(new URL('../terms/terms.md',import.meta.url),'utf8'),
  readFile(new URL('../terms/policy.md',import.meta.url),'utf8'),
  readFile(new URL('../terms/spec.md',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),
 ]);
 const config=JSON.parse(configText);
 assert.equal(config.vars.SUPPORTER_BILLING_MODE,'test');
 for(const key of ['STRIPE_PRICE_SUPPORTER','STRIPE_PRICE_PLUS','STRIPE_PRICE_PRO','STRIPE_PRICE_ADDON','STRIPE_PORTAL_CONFIG','SUPPORTER_CONSENT_VERSION'])assert.ok(config.vars[key]);
 assert.match(migration,/legal_consent_version/);assert.match(migration,/legal_consent_at/);
 assert.match(creditMigration,/supporter_credit_topups/);assert.match(creditMigration,/supporter_credit_lots/);assert.match(creditMigration,/expires_at/);
 assert.match(billingSource,/dpi_legal_consent_version/);
 assert.match(billingSource,/dpi_checkout_kind.*credit_topup/);assert.match(uiSource,/チャージ手続きへ/);assert.match(uiSource,/購入日から1年間/);
 assert.match(terms,/第 10 条（有料通知プラン）/);assert.match(terms,/故意または重大な過失/);
 assert.match(terms,/利用者の都合による取消し、払戻しまたは現金への交換には原則として応じません/);
 assert.match(specified,/購入済みクレジットの払戻し.*原則として応じません/);
 assert.match(policy,/Stripe/);assert.match(policy,/安全管理措置/);
 for(const text of ['販売価格','支払時期・請求日','契約期間・自動更新','解約方法・条件','キャンセル・返金'])assert.match(specified,new RegExp(text));
});
test('補償クレジットは対象・理由・有効期限を保存し利用者画面へ表示する',async()=>{
 const [migration,supporterSource,billingSource,adminHtml,adminSource,userHtml,userSource]=await Promise.all([
  readFile(new URL('../migrations/0021_supporter_compensation_credits.sql',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter-admin/app.js',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/index.html',import.meta.url),'utf8'),
  readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),
 ]);
 assert.match(migration,/supporter_credit_campaigns/);assert.match(migration,/supporter_credit_campaign_recipients/);assert.match(migration,/target_type/);assert.match(migration,/reason TEXT NOT NULL/);assert.match(migration,/expires_at INTEGER NOT NULL/);
 assert.match(supporterSource,/targetType==='plan'/);assert.match(supporterSource,/COMPENSATION_ACTIVE_STATUSES/);assert.match(supporterSource,/SELECT \* FROM supporter_credit_campaigns WHERE id=\?/);assert.match(supporterSource,/LIMIT \?/);assert.match(supporterSource,/attempts=attempts\+1/);assert.match(supporterSource,/dpi-compensation-customer/);assert.match(supporterSource,/complete_credit_campaign/);
 assert.match(supporterSource,/ORDER BY discord_user_id,CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,expires_at,id/);
 assert.match(billingSource,/supporter_credit_campaign_recipients/);assert.match(billingSource,/source_id LIKE 'compensation:%'/);assert.match(billingSource,/reason:clean\(row\.reason\)/);
 for(const text of ['全登録者','特定ユーザー','特定プランの契約者','利用者に表示する理由','有効期限'])assert.match(adminHtml,new RegExp(text));
 assert.match(adminSource,/credit-campaigns/);assert.match(adminSource,/compensationRequestId=crypto\.randomUUID/);assert.match(adminSource,/配布処理を再開/);assert.match(userSource,/補償 .*クレジット/);assert.match(userSource,/理由:/);
 // テスト公開中の注意書き（.preview-notice）だけは「実際の請求は発生しません」を含めてよい。
 const userHtmlWithoutPreviewNotice=userHtml.replace(/<div class="preview-notice"[\s\S]*?<\/div>/,'');
 assert.doesNotMatch(`${userHtmlWithoutPreviewNotice}\n${userSource}`,/先行提供|Stripeテスト環境|月・予定|実際の請求は発生しません/);
});
test('billing dunning sends success and failure mail and blocks access after month-end failure',async()=>{
 const [billingSource,supporterSource,uiSource,migration,configText,indexSource]=await Promise.all([
  readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8'),readFile(new URL('../worker/supporter.js',import.meta.url),'utf8'),readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),readFile(new URL('../migrations/0017_supporter_dunning.sql',import.meta.url),'utf8'),readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),readFile(new URL('../worker/index.js',import.meta.url),'utf8'),
 ]);
 assert.match(billingSource,/invoice\.payment_failed/);assert.match(billingSource,/invoice\.paid/);assert.match(billingSource,/auto_advance:'false'/);assert.match(billingSource,/月末再決済/);assert.match(billingSource,/payment_succeeded/);assert.match(billingSource,/status='suspended'/);
 assert.match(billingSource,/credit_topup_succeeded/);assert.match(billingSource,/credit_topup_failed/);assert.match(billingSource,/credit_expired/);
 assert.match(billingSource,/クレジットチャージ完了のお知らせ/);assert.match(billingSource,/クレジット有効期限切れのお知らせ/);
 assert.match(supporterSource,/supporter_dunning[\s\S]*status='suspended'/);assert.match(uiSource,/usageSuspended/);
 assert.match(migration,/CREATE TABLE IF NOT EXISTS supporter_dunning/);assert.match(migration,/supporter_billing_notifications/);
 assert.deepEqual(JSON.parse(configText).triggers.crons,['0 3 * * *','0 15 * * *']);assert.match(indexSource,/runSupporterBillingSchedule/);
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
 assert.match(source,/のクレジットを使用します。残額は今回/);
 assert.match(source,/次回26日のお支払い見込み/);
 assert.doesNotMatch(source,/window\.confirm\('契約内容を更新/);
 assert.match(source,/rules\.push\(normalizeRule[\s\S]+render\(\);[\s\S]+await loadChannels/);
 assert.match(source,/チャンネルを再取得/);
 assert.match(source,/channel-refresh/);
 assert.match(source,/response\.text\(\)/);
 assert.match(source,/unexpected_html_response/);
 assert.match(source,/method==='GET'&&retry&&response\.status>=500/);
 assert.match(source,/rule-condition-fields/);
 assert.match(source,/intensity-condition-row/);
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

test('発効済みダウングレードだけが保存ルールを改訂し、競合時は再読込する',async()=>{
 let account={discord_user_id:'123',settings_json:JSON.stringify({rules:Array.from({length:7},(_,index)=>({name:`R${index+1}`,guildId:'12345678901234567',channelId:'98765432109876543',channelIds:['98765432109876543']}))}),revision:4};
 let firstUpdate=true,selects=0;
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.includes('JOIN supporter_billing')){selects+=1;return{...account};}return null;},async run(){if(sql.startsWith('UPDATE supporter_accounts')){if(firstUpdate){firstUpdate=false;return{meta:{changes:0}};}account={...account,settings_json:values[0],revision:account.revision+1};return{meta:{changes:1}};}return{meta:{changes:1}};}};}};
 const result=await reconcileStoredRulesForCustomer(db,'cus_x',{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false});
 assert.equal(selects,2);assert.equal(result.changed,true);assert.equal(result.removedRules,2);assert.equal(result.revision,5);assert.deepEqual(result.rules.map(rule=>rule.name),['R1','R2','R3','R4','R5']);
 const invalid=await reconcileStoredRulesForCustomer(db,'cus_x',{servers:1,channels:2});assert.equal(invalid.invalidLimits,true);assert.equal(selects,2);
});

test('契約状態の再取得はWebhookを補完して発効済み上限をDBと画面へ返す',async()=>{
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
 let account={discord_user_id:'123',billing_email:'user@example.jp',settings_json:JSON.stringify({rules:Array.from({length:7},(_,index)=>({name:`R${index+1}`,guildId:'12345678901234567',channelId:'98765432109876543',channelIds:['98765432109876543']}))}),revision:1};
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async all(){return{results:[]};},async first(){
  if(sql.includes('FROM supporter_accounts WHERE'))return account;
  if(sql.includes('FROM supporter_billing WHERE'))return{discord_user_id:'123',customer_id:'cus_x'};
  if(sql.includes('FROM supporter_dunning'))return null;
  if(sql.includes('JOIN supporter_billing'))return account;
  return null;
 },async run(){if(sql.startsWith('UPDATE supporter_accounts')){account={...account,settings_json:values[0],revision:account.revision+1};return{meta:{changes:1}};}return{meta:{changes:1}};}};}};
 const renewal=Math.floor(Date.now()/1000)+86400;
 const subscription={id:'sub_basic',status:'active',customer:'cus_x',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:renewal,price:{id:'price_basic',unit_amount:300,currency:'jpy'}}]}};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async url=>{const parsed=new URL(url);let data={livemode:false};if(parsed.pathname==='/v1/subscriptions')data={livemode:false,data:[subscription]};else if(parsed.pathname==='/v1/invoices')data={livemode:false,data:[]};else if(parsed.pathname==='/v1/customers/cus_x')data={livemode:false,balance:0};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/status'),env,db,'123');
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.rulesAdjustment.changed,true);assert.equal(result.rulesAdjustment.removedRules,2);assert.equal(result.rulesAdjustment.revision,2);assert.equal(result.rulesAdjustment.rules.length,5);assert.equal(JSON.parse(account.settings_json).rules.length,5);
 }finally{globalThis.fetch=originalFetch;}
});

test('請求Webhookは初回決済成功メールとダウングレード発効時のルール同期を扱う',async()=>{
 const source=await readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8');
 assert.match(source,/checkout\.session\.async_payment_succeeded[\s\S]*sendBillingNotification\(env,db,'payment_succeeded'/);
 assert.match(source,/customer\.subscription\.created[\s\S]*customer\.subscription\.updated[\s\S]*reconcileStoredRulesForCustomer/);
 assert.match(source,/changeTiming==='next_period'[\s\S]*scheduleSubscriptionChange/);
 assert.doesNotMatch(source,/scheduleSubscriptionChange[\s\S]{0,500}reconcileStoredRulesForCustomer/);
});

test('初回決済Webhookは契約を作成し成功メールを重複送信しない',async()=>{
 const secret='whsec_example',timestamp=Math.floor(Date.now()/1000);
 const event={id:'evt_checkout_paid',livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_paid',mode:'payment',status:'complete',payment_status:'paid',customer:'cus_x',payment_intent:'pi_x',client_reference_id:'123',amount_total:300,currency:'jpy',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123',dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(timestamp+86400),dpi_legal_consent_version:'2026-11-04'}}}};
 const raw=JSON.stringify(event),signature=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex');
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:secret,STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',NOTICE_FROM_EMAIL:'notice@example.jp'};
 const events=new Set(),notices=new Map(),emails=[];
 env.NOTICE_EMAIL={async send(message){emails.push(message);}};
 const db={
  prepare(sql){
   let values=[];
   return{
    bind(...input){values=input;return this;},
    async first(){
     if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;
     if(sql.includes('JOIN supporter_billing'))return{billing_email:'user@example.jp'};
     if(sql.includes('supporter_billing_notifications'))return notices.has(`${values[0]}:${values[1]}`)?{status:notices.get(`${values[0]}:${values[1]}`)}:null;
     return null;
    },
    async run(){
     if(sql.startsWith('INSERT INTO supporter_stripe_events'))events.add(values[0]);
     if(sql.startsWith('INSERT INTO supporter_billing_notifications')){const key=`${values[0]}:${values[1]}`;if(!notices.has(key))notices.set(key,'pending');}
     if(sql.includes("SET status='sending'"))notices.set(`${values[1]}:${values[2]}`,'sending');
     if(sql.includes("SET status='sent'"))notices.set(`${values[2]}:${values[3]}`,'sent');
     return{meta:{changes:1}};
    },
   };
  },
  async batch(statements){for(const statement of statements)await statement.run();},
 };
 env.REUSE_DB=db;
 const originalFetch=globalThis.fetch;let subscriptionCreates=0;
 globalThis.fetch=async(url,init={})=>{const parsed=new URL(url);let data={livemode:false};if(parsed.pathname==='/v1/subscriptions'&&(init.method||'GET')==='GET')data={livemode:false,data:[]};else if(parsed.pathname==='/v1/payment_intents/pi_x')data={livemode:false,id:'pi_x',payment_method:'pm_x'};else if(parsed.pathname==='/v1/subscriptions'){subscriptionCreates+=1;data={livemode:false,id:'sub_x',status:'active',customer:'cus_x'};}return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const request=()=>new Request('https://dpi-bot.com/api/supporter/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw});
  assert.equal((await billingWebhook(request(),env)).status,200);assert.equal(subscriptionCreates,1);assert.equal(emails.length,1);assert.equal(emails[0].to,'user@example.jp');assert.match(emails[0].subject,/お支払い完了/);
  assert.equal((await billingWebhook(request(),env)).status,200);assert.equal(subscriptionCreates,1);assert.equal(emails.length,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('利用者画面は契約同期で削除されたルールと改訂番号を即時反映する',async()=>{
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.match(source,/billingState\.rulesAdjustment\?\.changed/);assert.match(source,/rulesAdjustment\.revision/);assert.match(source,/下側の通知ルール/);assert.match(source,/function savedRules\(account\)/);
});

test('利用者のクレジット履歴はチャージと管理者没収を区別する',async()=>{
 const userSource=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 const billingSource=await readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8');
 assert.match(userSource,/credited:'チャージ済み'/);
 assert.match(userSource,/管理者による没収/);
 assert.match(userSource,/details\.adminConfiscations/);
 assert.match(billingSource,/credit_delta<0 AND actor NOT IN \('user','system'\)/);
 assert.match(billingSource,/adminConfiscations/);
});
