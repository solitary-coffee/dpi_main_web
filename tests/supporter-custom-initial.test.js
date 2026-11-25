import test from 'node:test';
import assert from 'node:assert/strict';
import {
 subscriptionAnchor,billingSchedule,customInitialCheckoutParams,createCustomCheckout,
 provisionCustomPaidCheckoutSubscription,
} from '../worker/supporter-billing.js';
import {readFile} from 'node:fs/promises';

const uid='99999999999999999',customer='cus_test_custom';
const offer={discord_user_id:uid,id:'individual-custom-test',name:'防災カスタム',
 status:'offered',revision:4,confirmed_yen:1000,stripe_subscription_id:null};
const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_test_mock',
 STRIPE_WEBHOOK_SECRET:'whsec_mock',STRIPE_PRICE_SUPPORTER:'price_a',
 STRIPE_PRICE_PLUS:'price_b',STRIPE_PRICE_PRO:'price_c',
 STRIPE_PRICE_ADDON:'price_d',STRIPE_PORTAL_CONFIG:'bpc_mock',
 SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
const uuid='00000000-0000-4000-8000-000000000001';

test('custom first payment is full month before 26 JST and double charge from 26 onward',()=>{
 const before=Date.parse('2027-03-25T03:00:00Z'),after=Date.parse('2027-03-25T15:00:00Z');
 for(const [when,multiplier] of [[before,1],[after,2]]){
  const p=customInitialCheckoutParams(customer,uid,offer,uuid,when);
  const schedule=billingSchedule(when);
  assert.equal(Number(p['line_items[0][price_data][unit_amount]']),1000*multiplier);
  assert.equal(Number(p['metadata[dpi_initial_months]']),multiplier);
  assert.equal(Number(p['metadata[dpi_billing_anchor]']),schedule.anchor);
  assert.equal(p.mode,'payment');
  assert.equal(p['payment_intent_data[setup_future_usage]'],'off_session');
  assert.equal(p['line_items[0][price_data][recurring][interval]'],undefined);
  assert.equal(p['subscription_data[billing_cycle_anchor_config][day_of_month]'],undefined);
 }
});

test('paid custom Checkout creates a 26th-anchored subscription once; unpaid cannot provision',async t=>{
 const original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 let active=null;
 const req=[],p=customInitialCheckoutParams(customer,uid,offer,uuid,Date.now());
 const session={id:'cs_test_custom',mode:'payment',payment_status:'paid',status:'complete',
  customer,client_reference_id:uid,currency:'jpy',amount_total:Number(p['line_items[0][price_data][unit_amount]']),
  payment_intent:'pi_test_custom',metadata:Object.fromEntries(
   Object.entries(p).filter(([k])=>k.startsWith('metadata['))
    .map(([k,v])=>[k.slice(9,-1),v]))};
 const db={prepare(sql){return {bind(){return this;},async first(){
  if(sql.includes('FROM supporter_custom_plans'))return offer;
  if(sql.includes('FROM supporter_billing'))return {customer_id:customer};
  throw Error('Unexpected D1 read: '+sql);
 }};}};
 globalThis.fetch=async (raw,options={})=>{
  const url=new URL(raw),path=url.pathname,method=options.method||'GET';
  const params=new URLSearchParams(options.body||'');
  req.push({path,method,params});
  if(path==='/v1/checkout/sessions'&&method==='POST')
   return Response.json({id:'cs_test_custom',url:'https://checkout.stripe.com/c/pay/mock',
    amount_total:Number(params.get('line_items[0][price_data][unit_amount]')),
    status:'open',mode:'payment',expires_at:Math.floor(Date.now()/1000)+86400});
  if(path==='/v1/subscriptions'&&method==='GET')return Response.json({data:active?[active]:[],has_more:false});
  if(path==='/v1/payment_intents/pi_test_custom')
   return Response.json({id:'pi_test_custom',customer,status:'succeeded',payment_method:'pm_card_visa',
    amount_received:session.amount_total});
  if(path==='/v1/products'&&method==='POST')return Response.json({id:'prod_custom_test',livemode:false});
  if(path==='/v1/subscriptions'&&method==='POST'){
   assert.equal(params.get('proration_behavior'),'none');
   assert.equal(params.get('billing_cycle_anchor'),String(subscriptionAnchor(Number(session.metadata.dpi_billing_anchor)).anchor));
   assert.equal(params.get('items[0][price_data][unit_amount]'),'1000');
   assert.equal(params.get('items[0][price_data][recurring][interval]'),'month');
   assert.equal(params.get('default_payment_method'),'pm_card_visa');
   active={id:'sub_custom_test',customer,status:'active',
    metadata:{dpi_custom_id:offer.id,dpi_custom_revision:'4',dpi_custom_initial_session:session.id},
    items:{data:[{price:{unit_amount:1000}}]}};
   return Response.json(active);
  }
  throw Error('Unexpected Stripe URL: '+path);
 };
 const created=await createCustomCheckout(env,customer,uid,offer,uuid);
 assert.equal(created.amount,session.amount_total);
 assert.equal(req.find(x=>x.path==='/v1/checkout/sessions').params.get('mode'),'payment');
 assert.equal(await provisionCustomPaidCheckoutSubscription(env,db,{...session,payment_status:'unpaid'}),null);
 assert.equal(req.some(x=>x.path==='/v1/products'),false);
 const first=await provisionCustomPaidCheckoutSubscription(env,db,session);
 assert.equal(first.id,'sub_custom_test');
 const replay=await provisionCustomPaidCheckoutSubscription(env,db,session);
 assert.equal(replay.id,'sub_custom_test');
 assert.equal(req.filter(x=>x.path==='/v1/subscriptions'&&x.method==='POST').length,1);
 assert.equal(req.filter(x=>x.path==='/v1/products'&&x.method==='POST').length,1);
});

test('custom initial checkout is wired into paid webhook and page recovery',async()=>{
 const source=await readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8');
 assert.match(source,/checkoutMetadata\(session\).dpi_checkout_kind==='custom_subscription_initial'/);
 assert.match(source,/await provisionCustomPaidCheckoutSubscription\(env,db,session\)/);
 assert.match(source,/await provisionCustomPaidCheckoutSubscription\(env,db,item\)/);
 assert.match(source,/mode:'payment',customer,client_reference_id:uid/);
});
