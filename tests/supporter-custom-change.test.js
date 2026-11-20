import test from 'node:test';
import assert from 'node:assert/strict';
import {customChangeQuote,stageCustomChange,getCustomChange} from '../worker/supporter-custom-change.js';
import {settleCustomPriceChange,createCustomDifferenceCheckout,verifiedCustomSubscription} from '../worker/supporter-billing.js';
import {readFile} from 'node:fs/promises';

const uid='123456789012345678',customer='cus_custom',subscriptionId='sub_custom',customId='custom_1';
const proposed={name:'自治体連携',channels:12,servers:4,rules:20,complexConditions:true,
 municipalityBranching:true,contentExtraction:true,multiDestination:true,secondaryReuse:false,
 monthlyYen:1600};
const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_test_mock',
 STRIPE_WEBHOOK_SECRET:'whsec_mock',STRIPE_PRICE_SUPPORTER:'price_a',
 STRIPE_PRICE_PLUS:'price_b',STRIPE_PRICE_PRO:'price_c',STRIPE_PRICE_ADDON:'price_d',
 STRIPE_PORTAL_CONFIG:'bpc_mock',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};

function makeFake(){
 const plan={discord_user_id:uid,id:customId,status:'active',name:'以前のカスタム',
  revision:2,confirmed_yen:1000,stripe_subscription_id:subscriptionId,
  channel_limit:6,server_limit:2,rule_limit:10,
  complex_conditions:0,municipality_branching:0,content_extraction:0,
  multi_destination:0,secondary_reuse:0,estimated_yen:1000,reason:'old',updated_by:'admin'};
 const changes=new Map(),history=[];
 const db={prepare(sql){let args=[];
  return {
   bind(...values){args=values;return this;},
   async first(){
    if(sql.includes('FROM supporter_custom_plans WHERE discord_user_id=?'))return plan;
    if(sql.includes('FROM supporter_custom_plan_changes WHERE request_id=?'))return changes.get(args[0])||null;
    if(sql.includes('FROM supporter_billing WHERE discord_user_id=?'))return {customer_id:customer};
    if(sql.includes('FROM supporter_custom_plan_changes')&&sql.includes('status IN'))return [...changes.values()].find(c=>c.discord_user_id===args[0]&&['pending','paid'].includes(c.status))||null;
    throw Error('Unexpected first query: '+sql);
   },
   async all(){
    if(sql.includes('FROM supporter_custom_plan_changes')&&sql.includes('status IN'))return {results:[...changes.values()].filter(c=>['pending','paid'].includes(c.status)).map(c=>({request_id:c.request_id,discord_user_id:c.discord_user_id}))};
    throw Error('Unexpected all query: '+sql);
   },
   async run(){
    history.push({sql,args});
    if(sql.includes('INSERT INTO supporter_custom_plan_changes')){
     const [request_id,discord_user_id,custom_plan_id,stripe_customer_id,stripe_subscription_id,old_revision,next_revision,
      old_monthly_yen,next_monthly_yen,amount_due_yen,next_plan_json,status,actor,reason,created_at,updated_at]=args;
     if([...changes.values()].some(v=>v.discord_user_id===uid&&['pending','paid'].includes(v.status)))throw Error('UNIQUE constraint');
     changes.set(request_id,{request_id,discord_user_id,custom_plan_id,stripe_customer_id,stripe_subscription_id,
      old_revision,next_revision,old_monthly_yen,next_monthly_yen,amount_due_yen,next_plan_json,status,actor,reason,created_at,updated_at});
     return {meta:{changes:1}};
    }
    if(sql.includes("UPDATE supporter_custom_plan_changes SET status='paid'")){
     const c=changes.get(args[1]);if(c?.status==='pending')c.status='paid';
     return {meta:{changes:c?.status==='paid'?1:0}};
    }
    if(sql.includes("UPDATE supporter_custom_plan_changes SET status='applied'")){
     const c=changes.get(args[2]);if(c?.status==='paid')c.status='applied';
     return {meta:{changes:c?.status==='applied'?1:0}};
    }
    if(sql.includes("UPDATE supporter_custom_plans SET")){
     const [name,channels,servers,rules,complex,city,extract,multi,reuse,estimated,price,reason,actor,now,revision,features,
      user,identity,oldRevision,oldPrice,sub]=args;
     if(user!==uid||identity!==customId||sub!==subscriptionId||plan.revision!==oldRevision||plan.confirmed_yen!==oldPrice)return {meta:{changes:0}};
     Object.assign(plan,{name,channel_limit:channels,server_limit:servers,rule_limit:rules,complex_conditions:complex,
      municipality_branching:city,content_extraction:extract,multi_destination:multi,secondary_reuse:reuse,
      estimated_yen:estimated,confirmed_yen:price,reason,updated_by:actor,updated_at:now,revision,features_json:features});
     return {meta:{changes:1}};
    }
    throw Error('Unexpected run query: '+sql);
   }
  };
 }};
 return {db,plan,changes,history};
}
function stubStripe(t,state){
 const original=globalThis.fetch,requests=[];
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async (raw,options={})=>{
  const url=new URL(raw),method=options.method||'GET';
  const params=new URLSearchParams(options.body||''),path=url.pathname;
  requests.push({path,method,params});
  if(path==='/v1/subscriptions/'+subscriptionId){
   if(method==='POST'){
    if(state.failNext){state.failNext=false;return Response.json({error:{message:'temporary error'}},{status:502});}
    assert.equal(params.get('proration_behavior'),'none');
    assert.equal(params.get('billing_cycle_anchor'),'unchanged');
    assert.equal(params.get('payment_behavior'),'error_if_incomplete');
    if(params.has('items[0][price_data][unit_amount]')){
     assert.equal(params.get('items[0][price_data][recurring][interval]'),'month');
     assert.equal(params.get('items[0][price_data][product]'),'prod_custom');
     state.monthly=Number(params.get('items[0][price_data][unit_amount]'));
    }
    state.revision=Number(params.get('metadata[dpi_custom_revision]'));
   }
   return Response.json({id:subscriptionId,livemode:false,customer,status:'active',latest_invoice:state.firstPeriod?null:'in_custom_paid',collection_method:'charge_automatically',
    metadata:{dpi_user:uid,dpi_custom_id:customId,dpi_custom_revision:String(state.revision),...(state.firstPeriod?{dpi_custom_initial_session:'cs_test_initial'}:{})},
    items:{data:[{id:'si_custom',quantity:1,price:{currency:'jpy',unit_amount:state.monthly,
     product:'prod_custom',recurring:{interval:'month',interval_count:1}}}]}});
  }
  if(path==='/v1/invoices/in_custom_paid'){
   return Response.json({id:'in_custom_paid',livemode:false,status:state.invoicePaid===false?'open':'paid',subscription:subscriptionId,
    customer,currency:'jpy',amount_remaining:0,amount_paid:1000});
  }
  if(path==='/v1/checkout/sessions/cs_test_initial'){
    return Response.json({id:'cs_test_initial',livemode:false,mode:'payment',
     status:state.initialPaid===false?'open':'complete',
     payment_status:state.initialPaid===false?'unpaid':'paid',
     currency:'jpy',customer,client_reference_id:state.initialWrongUser?'88888888888888888':uid,
     amount_total:state.initialWrongAmount?900:1000,
     metadata:{dpi_checkout_kind:'custom_subscription_initial',dpi_custom_id:customId,
      dpi_custom_revision:'2',dpi_custom_monthly_yen:'1000',dpi_initial_months:'1'}});
   }
   if(path==='/v1/checkout/sessions/cs_difference'){
   return Response.json({id:'cs_difference',livemode:false,mode:'payment',status:state.paid?'complete':'open',
    payment_status:state.paid?'paid':'unpaid',currency:'jpy',customer,client_reference_id:uid,amount_total:600,
    expires_at:2000000000,url:'https://checkout.stripe.com/c/pay/cs_difference',
    metadata:{dpi_checkout_kind:'custom_change',dpi_user:uid,dpi_custom_id:customId,
     dpi_change_request:state.requestId,dpi_custom_revision:'2'}});
  }
  if(path==='/v1/checkout/sessions'){
   return Response.json({id:'cs_difference',livemode:false,mode:'payment',status:'open',
    expires_at:2000000000,url:'https://checkout.stripe.com/c/pay/cs_difference'});
  }
  throw Error('Unexpected Stripe call: '+method+' '+path);
 };
 return requests;
}

test('custom price quote charges exactly the monthly difference, never prorates or auto-refunds',()=>{
 const row={status:'active',confirmed_yen:1000};
 const upgrade=customChangeQuote(row,proposed);
 assert.equal(upgrade.immediateDueYen,600);
 assert.equal(upgrade.nextMonthlyYen,1600);
 assert.equal(upgrade.prorated,false);
 assert.equal(upgrade.timing,'after_payment');
 const downgrade=customChangeQuote(row,{...proposed,monthlyYen:700});
 assert.equal(downgrade.immediateDueYen,0);
 assert.equal(downgrade.noImmediateRefund,true);
 assert.equal(downgrade.nextMonthlyYen,700);
 const unchanged=customChangeQuote(row,{...proposed,monthlyYen:1000});
 assert.equal(unchanged.immediateDueYen,0);
 assert.equal(unchanged.timing,'immediate');
});

test('unpaid upgrade preserves old entitlement, paid checkout applies new recurring price once',async t=>{
 const {db,plan,changes}=makeFake(),requestId='71389e55-3216-46c0-afb2-92b091d31680';
 const state={monthly:1000,revision:2,paid:false,requestId};
 const requests=stubStripe(t,state);
 const pending=await stageCustomChange(db,uid,customer,plan,proposed,'admin','上限拡大',requestId);
 assert.equal(pending.status,'pending');
 assert.equal(pending.amount_due_yen,600);
 const checkout=await createCustomDifferenceCheckout(env,customer,uid,plan,pending);
 assert.equal(checkout.id,'cs_difference');
 assert.equal(requests.at(-1).params.get('line_items[0][price_data][unit_amount]'),'600');
 pending.checkout_session_id=checkout.id;
 const before=await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(before.pending,true);
 assert.equal(plan.confirmed_yen,1000);
 assert.equal(requests.filter(x=>x.path==='/v1/subscriptions/'+subscriptionId&&x.method==='POST').length,0);
 state.paid=true;
 const applied=await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(applied.applied,true);
 assert.equal(plan.confirmed_yen,1600);
 assert.equal(plan.revision,3);
 assert.equal(changes.get(requestId).status,'applied');
 const posts=requests.filter(x=>x.path==='/v1/subscriptions/'+subscriptionId&&x.method==='POST');
 assert.equal(posts.length,1);
 const repeat=await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(repeat.applied,true);
 assert.equal(requests.filter(x=>x.path==='/v1/subscriptions/'+subscriptionId&&x.method==='POST').length,1);
});

test('paid upgrade stays retryable if Stripe update fails, without charging difference again',async t=>{
 const {db,plan,changes}=makeFake(),requestId='71389e55-3216-46c0-afb2-92b091d31681';
 const state={monthly:1000,revision:2,paid:true,requestId,failNext:true};
 const calls=stubStripe(t,state);
 const pending=await stageCustomChange(db,uid,customer,plan,proposed,'admin','料金変更',requestId);
 pending.checkout_session_id='cs_difference';
 await assert.rejects(settleCustomPriceChange(env,db,uid,requestId),/temporary error/);
 assert.equal(changes.get(requestId).status,'paid');
 assert.equal(plan.confirmed_yen,1000);
 await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(changes.get(requestId).status,'applied');
 assert.equal(plan.confirmed_yen,1600);
 assert.equal(calls.filter(c=>c.path==='/v1/checkout/sessions/cs_difference').length,1);
});

test('downgrade changes recurring price with zero immediate Checkout calls',async t=>{
 const {db,plan,changes}=makeFake(),requestId='71389e55-3216-46c0-afb2-92b091d31682';
 const state={monthly:1000,revision:2,paid:false,requestId};
 const calls=stubStripe(t,state);
 const pending=await stageCustomChange(db,uid,customer,plan,{...proposed,monthlyYen:700},'admin','減額',requestId);
 assert.equal(pending.status,'paid');
 assert.equal(pending.amount_due_yen,0);
 await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(plan.confirmed_yen,700);
 assert.equal(changes.get(requestId).status,'applied');
 assert.equal(calls.filter(c=>c.path.includes('/checkout/')).length,0);
});

test('same-price rule changes update only Stripe metadata and do not create a new Price or Checkout',async t=>{
 const {db,plan,changes}=makeFake(),requestId='71389e55-3216-46c0-afb2-92b091d31683';
 const state={monthly:1000,revision:2,paid:false,requestId};
 const calls=stubStripe(t,state);
 const pending=await stageCustomChange(db,uid,customer,plan,{...proposed,monthlyYen:1000},'admin','機能追加',requestId);
 assert.equal(pending.amount_due_yen,0);
 await settleCustomPriceChange(env,db,uid,requestId);
 assert.equal(changes.get(requestId).status,'applied');
 const stripeChange=calls.find(x=>x.path==='/v1/subscriptions/'+subscriptionId&&x.method==='POST');
 assert.ok(stripeChange);
 assert.equal(stripeChange.params.get('items[0][price_data][unit_amount]'),null);
 assert.equal(stripeChange.params.get('metadata[dpi_custom_revision]'),'3');
});

test('unpaid current invoice blocks price change before a Stripe mutation',async t=>{
 const {db,plan}=makeFake(),requestId='71389e55-3216-46c0-afb2-92b091d31684';
 const state={monthly:1000,revision:2,paid:false,invoicePaid:false,requestId};
 const calls=stubStripe(t,state);
 await assert.rejects(verifiedCustomSubscription(env,customer,uid,plan),/支払い完了/);
 const pending=await stageCustomChange(db,uid,customer,plan,{...proposed,monthlyYen:700},'admin','減額確認',requestId);
 assert.equal(pending.status,'paid');
 await assert.rejects(settleCustomPriceChange(env,db,uid,requestId),/支払い完了/);
 assert.equal(plan.confirmed_yen,1000);
 assert.equal(calls.filter(c=>c.path==='/v1/subscriptions/'+subscriptionId&&c.method==='POST').length,0);
});

test('paid initial checkout permits price changes before the first 26th renewal',async t=>{
 const {plan}=makeFake();
 const state={firstPeriod:true,initialPaid:true,monthly:1000,revision:2};
 const requests=stubStripe(t,state);
 const subscription=await verifiedCustomSubscription(env,customer,uid,plan);
 assert.equal(subscription.id,subscriptionId);
 assert.equal(requests.some(c=>c.path==='/v1/checkout/sessions/cs_test_initial'),true);
 assert.equal(requests.some(c=>c.path==='/v1/invoices/in_custom_paid'),false);
});

test('unpaid, wrong-user and wrong-amount first checkout cannot authorize changes',async t=>{
 const {plan}=makeFake();
 const state={firstPeriod:true,initialPaid:false,monthly:1000,revision:2};
 stubStripe(t,state);
 await assert.rejects(verifiedCustomSubscription(env,customer,uid,plan),/初回Checkout/);
 state.initialPaid=true;
 state.initialWrongUser=true;
 await assert.rejects(verifiedCustomSubscription(env,customer,uid,plan),/初回Checkout/);
 state.initialWrongUser=false;
 state.initialWrongAmount=true;
 await assert.rejects(verifiedCustomSubscription(env,customer,uid,plan),/初回Checkout/);
});

test('admin confirmation and billing webhook are integrated and migration includes idempotency',async()=>{
 const api=await readFile(new URL('../worker/supporter.js',import.meta.url),'utf8');
 const stripe=await readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8');
 const ui=await readFile(new URL('../site/supporter-admin/app.js',import.meta.url),'utf8');
 const migration=await readFile(new URL('../migrations/0026_supporter_custom_plan_changes.sql',import.meta.url),'utf8');
 assert.match(api,/customChangeQuote/);
 assert.match(api,/expectedRevision/);
 assert.match(stripe,/custom_change/);
 assert.match(stripe,/settleCustomPriceChange/);
 assert.match(ui,/action:'preview'/);
 assert.match(migration,/UNIQUE INDEX IF NOT EXISTS idx_custom_change_inflight/);
});
