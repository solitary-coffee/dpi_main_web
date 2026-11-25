import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {billingAction,billingWebhook,runSupporterBillingSchedule,scheduledChangeSummary,sendBillingNotification,subscriptionSummary} from '../worker/supporter-billing.js';

const envBase=()=>({
 SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_example',
 STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',
 STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com',NOTICE_FROM_EMAIL:'notice@example.jp',
});

function webhookRequest(event,secret='whsec_example'){
 const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
 const signature=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex');
 return new Request('https://dpi-bot.com/api/supporter/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw});
}

test('同時Webhookでも同じ支払いメールは1通だけ送る',async()=>{
 let noticeStatus='',noticeUpdatedAt=0;const emails=[];
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){
  if(sql.includes('JOIN supporter_billing'))return{billing_email:'user@example.jp'};
  if(sql.startsWith('SELECT status FROM supporter_billing_notifications'))return noticeStatus?{status:noticeStatus}:null;
  return null;
 },async run(){
  if(sql.startsWith('INSERT INTO supporter_billing_notifications')){if(!noticeStatus){noticeStatus='pending';noticeUpdatedAt=values[2];}return{meta:{changes:1}};}
  if(sql.includes("SET status='sending'")){const canClaim=['pending','failed'].includes(noticeStatus)||(noticeStatus==='sending'&&noticeUpdatedAt<=values[3]);if(canClaim){noticeStatus='sending';noticeUpdatedAt=values[0];return{meta:{changes:1}};}return{meta:{changes:0}};}
  if(sql.includes("SET status='sent'")){noticeStatus='sent';return{meta:{changes:1}};}
  if(sql.includes("SET status='failed'")){noticeStatus='failed';return{meta:{changes:1}};}
  return{meta:{changes:1}};
 }};}};
 const env={...envBase(),NOTICE_EMAIL:{async send(message){await new Promise(resolve=>setTimeout(resolve,5));emails.push(message);}}};
 const invoice={id:'in_same',customer:'cus_same',subscription:'sub_same',amount_paid:300,currency:'jpy'};
 await Promise.all([sendBillingNotification(env,db,'payment_succeeded',invoice),sendBillingNotification(env,db,'payment_succeeded',invoice)]);
 assert.equal(emails.length,1);assert.equal(noticeStatus,'sent');
});

test('期限切れ・非同期決済失敗は申込み途中状態を消し、Customerのメール変更も同期する',async()=>{
 const events=new Set();let cleared=0,dirty=0,syncedEmail='';
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;return null;},async run(){
  if(sql.startsWith('UPDATE supporter_billing SET checkout_key=NULL')){cleared+=1;return{meta:{changes:1}};}
  if(sql.startsWith('UPDATE supporter_accounts SET billing_email=')){syncedEmail=values[0];return{meta:{changes:1}};}
  if(sql.startsWith('INSERT INTO supporter_stripe_events'))events.add(values[0]);
  if(sql.startsWith('UPDATE supporter_billing SET dirty=1'))dirty+=1;
  return{meta:{changes:1}};
 }};},async batch(statements){for(const statement of statements)await statement.run();}};
 const env={...envBase(),REUSE_DB:db};
 for(const [id,type,object] of [
  ['evt_expired','checkout.session.expired',{id:'cs_expired',customer:'cus_x'}],
  ['evt_failed','checkout.session.async_payment_failed',{id:'cs_failed',customer:'cus_x'}],
  ['evt_customer','customer.updated',{id:'cus_x',email:'NEW@EXAMPLE.JP'}],
 ]){
  const response=await billingWebhook(webhookRequest({id,livemode:false,type,data:{object}}),env);assert.equal(response.status,200);
 }
 assert.equal(cleared,2);assert.equal(syncedEmail,'new@example.jp');assert.equal(dirty,3);
});

function dunningDb(){
 const state={status:'retry_scheduled',retryAttemptedAt:null,finalNotices:0};
 const row={invoice_id:'in_retry',customer_id:'cus_x',subscription_id:'sub_x',amount_due:300,currency:'jpy',retry_at:1,suspend_at:4_000_000_000};
 return{state,prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){if(sql.includes('JOIN supporter_billing'))return null;return null;},async all(){
  if(sql.includes("status='retry_scheduled'"))return{results:state.status==='retry_scheduled'?[row]:[]};
  return{results:[]};
 },async run(){
  if(sql.includes("SET status='retrying'")){if(state.status!=='retry_scheduled')return{meta:{changes:0}};state.status='retrying';state.retryAttemptedAt=values[0];return{meta:{changes:1}};}
  if(sql.includes("SET status='retry_scheduled'")){state.status='retry_scheduled';if(sql.includes('retry_attempted_at=NULL'))state.retryAttemptedAt=null;return{meta:{changes:1}};}
  if(sql.includes("SET status='suspend_scheduled'")){state.status='suspend_scheduled';return{meta:{changes:1}};}
  if(sql.startsWith('INSERT INTO supporter_billing_notifications'))state.finalNotices+=1;
  return{meta:{changes:1}};
 }};}};
}

test('月末再決済はStripe通信障害では停止せず、確定したカード失敗だけ停止予定にする',async()=>{
 const originalFetch=globalThis.fetch;
 try{
  const transient=dunningDb();globalThis.fetch=async()=>new Response('<html>gateway error</html>',{status:502,headers:{'content-type':'text/html'}});
  let result=await runSupporterBillingSchedule({...envBase(),REUSE_DB:transient},2_000_000);
  assert.equal(result.failed,0);assert.equal(transient.state.status,'retry_scheduled');assert.equal(transient.state.retryAttemptedAt,null);assert.equal(transient.state.finalNotices,0);

  const invalidDecline=dunningDb();globalThis.fetch=async()=>new Response('<html>payment proxy error</html>',{status:402,headers:{'content-type':'text/html'}});
  result=await runSupporterBillingSchedule({...envBase(),REUSE_DB:invalidDecline},2_000_000);
  assert.equal(result.failed,0);assert.equal(invalidDecline.state.status,'retry_scheduled');assert.equal(invalidDecline.state.retryAttemptedAt,null);

  const decline=dunningDb();globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Your card was declined.',code:'card_declined'}}),{status:402,headers:{'content-type':'application/json'}});
  result=await runSupporterBillingSchedule({...envBase(),REUSE_DB:decline},2_000_000);
  assert.equal(result.failed,1);assert.equal(decline.state.status,'suspend_scheduled');
 }finally{globalThis.fetch=originalFetch;}
});

test('壊れたオプション内訳は契約権限を過剰付与せず、予約変更も表示しない',()=>{
 const env=envBase(),renewal=Math.floor(Date.now()/1000)+86400;
 const subscription={status:'active',metadata:{dpi_channel_packs:'5',dpi_server_packs:'5'},items:{data:[
  {quantity:1,current_period_end:renewal,price:{id:'price_pro',unit_amount:1280,currency:'jpy'}},
  {quantity:1,current_period_end:renewal,price:{id:'price_addon',unit_amount:200,currency:'jpy'}},
 ]}};
 const summary=subscriptionSummary(subscription,env);
 assert.equal(summary.recognizedPlan,false);assert.equal(summary.configurationValid,false);assert.equal(summary.channels,0);assert.equal(summary.servers,0);assert.equal(summary.rules,0);
 const schedule={phases:[{start_date:renewal,metadata:{dpi_channel_packs:'99',dpi_server_packs:'0'},items:[{price:'price_pro',quantity:1},{price:'price_addon',quantity:99}]}]};
 assert.equal(scheduledChangeSummary(schedule,env,{...summary,nextRenewalAt:renewal-1}),null);

 const legacy=subscriptionSummary({...subscription,metadata:{},items:{data:[subscription.items.data[0],{...subscription.items.data[1],quantity:2}]}},env);
 assert.equal(legacy.recognizedPlan,true);assert.equal(legacy.channelPacks,2);assert.equal(legacy.serverPacks,0);assert.equal(legacy.channels,26);
});

test('予約ダウングレード後のアップグレードは予約を解除し、支払い確認待ちならオプションを後回しにする',async()=>{
 const env=envBase(),renewal=Math.floor(Date.now()/1000)+86400;
 const current={id:'sub_x',status:'active',customer:'cus_x',schedule:'sched_down',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:renewal,price:{id:'price_plus',unit_amount:800,currency:'jpy'}}]}};
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:'user@example.jp'};if(sql.includes('supporter_billing'))return{discord_user_id:'123',customer_id:'cus_x'};return null;},async run(){return{meta:{changes:1}};}};}};
 const calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const parsed=new URL(url),method=init.method||'GET',params=new URLSearchParams(init.body||'');calls.push({path:parsed.pathname,method,params,headers:init.headers});let data={livemode:false};
  if(parsed.pathname==='/v1/subscriptions'&&method==='GET')data={livemode:false,data:[current]};
  else if(parsed.pathname==='/v1/invoices/create_preview')data={livemode:false,lines:{data:[{amount:-200,proration:true},{amount:500,proration:true}]}};
  else if(parsed.pathname==='/v1/customers/cus_x'&&method==='GET')data={livemode:false,balance:0,invoice_settings:{default_payment_method:'pm_x'}};
  else if(parsed.pathname==='/v1/subscription_schedules/sched_down/release')data={livemode:false,id:'sched_down',released_subscription:'sub_x'};
  else if(parsed.pathname==='/v1/subscriptions/sub_x')data={...current,livemode:false,pending_update:{expires_at:renewal}};
  else if(parsed.pathname==='/v1/subscription_schedules/sched_down')data={livemode:false,id:'sched_down',phases:[]};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),env,db,'123',{plan:'pro',channelPacks:1,serverPacks:0,prorationDate:Math.floor(Date.now()/1000),expectedCreditApplied:0,useCredits:false,requestId:'123e4567-e89b-42d3-a456-426614174777'});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.paymentPending,true);assert.equal(result.optionsDeferred,true);assert.equal(result.releasedScheduledChange,true);assert.match(result.message,/支払い確認待ち/);assert.match(result.message,/ダウングレードは取り消し/);
  assert.ok(calls.some(call=>call.path==='/v1/subscription_schedules/sched_down/release'));
  const subscriptionPosts=calls.filter(call=>call.path==='/v1/subscriptions/sub_x'&&call.method==='POST');assert.equal(subscriptionPosts.length,1);assert.equal(subscriptionPosts[0].params.get('items[0][price]'),'price_pro');
 }finally{globalThis.fetch=originalFetch;}
});

test('長いメールアドレスでもStripe冪等キーを上限内に固定し、異常JSONは安全に失敗する',async()=>{
 const env=envBase(),longEmail=`${'a'.repeat(240)}@example.jp`;
 const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('supporter_accounts'))return{discord_user_id:'123',billing_email:longEmail};if(sql.includes('supporter_billing'))return{discord_user_id:'123',customer_id:'cus_x'};return null;},async run(){return{meta:{changes:1}};}};}};
 const originalFetch=globalThis.fetch,keys=[];
 try{
  globalThis.fetch=async(url,init={})=>{keys.push(init.headers?.['Idempotency-Key']||'');const path=new URL(url).pathname;const data=path==='/v1/billing_portal/sessions'?{livemode:false,url:'https://billing.stripe.com/p/session'}:{livemode:false};return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});};
  const response=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/portal'),env,db,'123',{});assert.equal(response.status,200);
  const emailKey=keys.find(Boolean);assert.ok(emailKey.length<255);assert.equal(emailKey.includes(longEmail),false);

  globalThis.fetch=async()=>new Response('<!doctype html><title>bad gateway</title>',{status:502,headers:{'content-type':'text/html'}});
  await assert.rejects(()=>billingAction(new Request('https://dpi-bot.com/api/supporter/billing/portal'),env,db,'123',{}),error=>error.status===502&&/正しい応答/.test(error.message));
 }finally{globalThis.fetch=originalFetch;}
});

function contractDb(uid='123'){
 return{prepare(sql){return{bind(){return this;},async first(){
  if(sql.includes('supporter_accounts'))return{discord_user_id:uid,billing_email:'user@example.jp'};
  if(sql.includes('supporter_billing'))return{discord_user_id:uid,customer_id:'cus_x'};
  return null;
 },async run(){return{meta:{changes:1}};}};}};
}

function basicSubscription(){
 const renewal=Math.floor(Date.now()/1000)+86400;
 return{id:'sub_basic',status:'active',customer:'cus_x',start_date:1700000000,metadata:{dpi_channel_packs:'0',dpi_server_packs:'0'},items:{data:[{id:'si_base',quantity:1,current_period_start:1700000000,current_period_end:renewal,price:{id:'price_basic',unit_amount:300,currency:'jpy'}}]}};
}

test('同じプランとオプションの再送はStripe契約を更新しない',async()=>{
 const current=basicSubscription(),calls=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname;calls.push({path,method:init.method||'GET'});let data={livemode:false};
  if(path==='/v1/subscriptions')data={livemode:false,data:[current]};
  else if(path==='/v1/customers/cus_x')data={livemode:false,balance:0};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  await assert.rejects(()=>billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),envBase(),contractDb(),'123',{plan:'supporter',channelPacks:0,serverPacks:0}),error=>error.status===409&&/変更内容がありません/.test(error.message));
  assert.equal(calls.some(call=>call.path==='/v1/invoices/create_preview'),false);
  assert.equal(calls.some(call=>call.path==='/v1/subscriptions/sub_basic'&&call.method==='POST'),false);
 }finally{globalThis.fetch=originalFetch;}
});

test('料金プレビューの期限切れとクレジット残高変動は契約更新前に再確認させる',async()=>{
 const current=basicSubscription(),calls=[];let credits=400;const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET';calls.push({path,method});let data={livemode:false};
  if(path==='/v1/subscriptions'&&method==='GET')data={livemode:false,data:[current]};
  else if(path==='/v1/customers/cus_x'&&method==='GET')data={livemode:false,balance:-credits};
  else if(path==='/v1/subscriptions/sub_basic')data={...current,livemode:false};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const expired=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),envBase(),contractDb(),'123',{plan:'supporter',channelPacks:1,serverPacks:0,prorationDate:Math.floor(Date.now()/1000)-601,expectedCreditApplied:400,useCredits:true,requestId:'123e4567-e89b-42d3-a456-426614174201'});
  assert.equal(expired.status,409);assert.match((await expired.json()).message,/有効期限/);

  const previewResponse=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/preview-update'),envBase(),contractDb(),'123',{plan:'supporter',channelPacks:1,serverPacks:0});
  const preview=await previewResponse.json();assert.equal(preview.creditApplied,400);
  credits=300;calls.length=0;
  const changed=await billingAction(new Request('https://dpi-bot.com/api/supporter/billing/update'),envBase(),contractDb(),'123',{plan:'supporter',channelPacks:1,serverPacks:0,prorationDate:preview.prorationDate,expectedCreditApplied:400,useCredits:true,requestId:'123e4567-e89b-42d3-a456-426614174202'});
  assert.equal(changed.status,409);assert.match((await changed.json()).message,/残高が変更/);
  assert.equal(calls.some(call=>call.path==='/v1/subscriptions/sub_basic'&&call.method==='POST'),false);
 }finally{globalThis.fetch=originalFetch;}
});

test('遅延決済はCheckout完了時に未払いなら付与せず、非同期成功後に1度だけ契約を作る',async()=>{
 const uid='637850681666961408',events=new Set(),notices=new Map(),emails=[];let subscription=null;
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){
  if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;
  if(sql.includes('JOIN supporter_billing'))return{billing_email:'async@example.jp'};
  if(sql.startsWith('SELECT status FROM supporter_billing_notifications'))return notices.has(`${values[0]}:${values[1]}`)?{status:notices.get(`${values[0]}:${values[1]}`)}:null;
  return null;
 },async run(){
  if(sql.startsWith('INSERT INTO supporter_stripe_events'))events.add(values[0]);
  if(sql.startsWith('INSERT INTO supporter_billing_notifications')){const key=`${values[0]}:${values[1]}`;if(!notices.has(key))notices.set(key,'pending');}
  if(sql.includes("SET status='sending'")){const key=`${values[1]}:${values[2]}`;if(['pending','failed'].includes(notices.get(key))){notices.set(key,'sending');return{meta:{changes:1}};}return{meta:{changes:0}};}
  if(sql.includes("SET status='sent'"))notices.set(`${values[2]}:${values[3]}`,'sent');
  return{meta:{changes:1}};
 }};},async batch(statements){for(const statement of statements)await statement.run();}};
 const env={...envBase(),REUSE_DB:db,NOTICE_EMAIL:{async send(message){emails.push(message);}}};
 const session={id:'cs_async',mode:'payment',status:'complete',customer:'cus_async',payment_intent:'pi_async',client_reference_id:uid,amount_total:300,currency:'jpy',metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:uid,dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_billing_anchor:String(Math.floor(Date.now()/1000)+86400),dpi_legal_consent_version:'2026-11-15'}};
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET';calls.push({path,method});let data={livemode:false};
  if(path==='/v1/subscriptions'&&method==='GET')data={livemode:false,data:subscription?[subscription]:[]};
  else if(path==='/v1/payment_intents/pi_async')data={livemode:false,id:'pi_async',payment_method:'pm_async'};
  else if(path==='/v1/subscriptions'&&method==='POST'){subscription={livemode:false,id:'sub_async',status:'active',customer:'cus_async',items:{data:[]}};data=subscription;}
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  let response=await billingWebhook(webhookRequest({id:'evt_async_pending',livemode:false,type:'checkout.session.completed',data:{object:{...session,payment_status:'unpaid'}}}),env);
  assert.equal(response.status,200);assert.equal(subscription,null);assert.equal(emails.length,0);
  response=await billingWebhook(webhookRequest({id:'evt_async_paid',livemode:false,type:'checkout.session.async_payment_succeeded',data:{object:{...session,payment_status:'paid'}}}),env);
  assert.equal(response.status,200);assert.equal(subscription.id,'sub_async');assert.equal(emails.length,1);
  response=await billingWebhook(webhookRequest({id:'evt_async_paid',livemode:false,type:'checkout.session.async_payment_succeeded',data:{object:{...session,payment_status:'paid'}}}),env);
  assert.equal(response.status,200);assert.equal(calls.filter(call=>call.path==='/v1/subscriptions'&&call.method==='POST').length,1);assert.equal(emails.length,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('同時に届く一部返金と全額返金は競合を再試行して過剰に取り消さない',async()=>{
 const events=new Set(),topup={request_id:'req_topup',discord_user_id:'637850681666961408',customer_id:'cus_x',checkout_session_id:'cs_topup',amount:1000,refunded_amount:0,status:'credited'},lot={id:'lot_topup',remaining_amount:1000,status:'active'};
 let initialTopupReads=0,releaseInitialReads;const initialReadGate=new Promise(resolve=>{releaseInitialReads=resolve;});
 const db={prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){
  if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;
  if(sql.includes('FROM supporter_credit_topups')){
   const snapshot={...topup};
   if(initialTopupReads<2){initialTopupReads+=1;if(initialTopupReads===2)releaseInitialReads();await initialReadGate;}
   return snapshot;
  }
  if(sql.includes('FROM supporter_credit_lots'))return{...lot};
  return null;
 },async run(){
  if(sql.startsWith('INSERT INTO supporter_stripe_events'))events.add(values[0]);
  if(sql.startsWith('UPDATE supporter_credit_topups SET refunded_amount=')){
   if(topup.refunded_amount!==values[4])return{meta:{changes:0}};
   topup.refunded_amount=values[0];topup.status=values[1];return{meta:{changes:1}};
  }
  if(sql.startsWith('UPDATE supporter_credit_lots SET remaining_amount=')){
   if(lot.remaining_amount!==values[4])return{meta:{changes:0}};
   lot.remaining_amount=values[0];lot.status=values[1];return{meta:{changes:1}};
  }
  return{meta:{changes:1}};
 }};},async batch(statements){for(const statement of statements)await statement.run();}};
 const env={...envBase(),REUSE_DB:db};let balance=-1000;const reversals=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,method=init.method||'GET',params=new URLSearchParams(init.body||'');let data={livemode:false};
  if(path==='/v1/customers/cus_x'&&method==='GET')data={livemode:false,balance};
  else if(path==='/v1/customers/cus_x/balance_transactions'){const amount=Number(params.get('amount'));reversals.push(amount);balance+=amount;data={livemode:false,id:`cbtxn_${reversals.length}`,ending_balance:balance};}
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const partial={id:'ch_refund',payment_intent:'pi_topup',customer:'cus_x',amount_refunded:300};
  const full={...partial,amount_refunded:1000};
  const concurrent=await Promise.allSettled([
   billingWebhook(webhookRequest({id:'evt_refund_300',livemode:false,type:'charge.refunded',data:{object:partial}}),env),
   billingWebhook(webhookRequest({id:'evt_refund_1000',livemode:false,type:'charge.refunded',data:{object:full}}),env),
  ]);
  assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(concurrent.filter(result=>result.status==='rejected').length,1);
  assert.deepEqual(reversals,[300]);assert.equal(topup.refunded_amount,300);assert.equal(topup.status,'credited');assert.equal(lot.remaining_amount,700);
  const duplicate=await billingWebhook(webhookRequest({id:'evt_refund_300',livemode:false,type:'charge.refunded',data:{object:partial}}),env);assert.equal(duplicate.status,200);assert.deepEqual(reversals,[300]);
  const response=await billingWebhook(webhookRequest({id:'evt_refund_1000',livemode:false,type:'charge.refunded',data:{object:full}}),env);assert.equal(response.status,200);
  assert.deepEqual(reversals,[300,700]);assert.equal(topup.refunded_amount,1000);assert.equal(topup.status,'refunded');assert.equal(lot.remaining_amount,0);assert.equal(lot.status,'revoked');
 }finally{globalThis.fetch=originalFetch;}
});
