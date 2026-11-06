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
  else if(parsed.pathname==='/v1/customers/cus_x'&&method==='GET')data={livemode:false,balance:0};
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
