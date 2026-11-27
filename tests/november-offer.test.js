import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {billingAction,billingSchedule,billingWebhook,creditSignupSubscriptionParams,customInitialCheckoutParams,paidCheckoutSubscriptionParams,prepaidRenewalPending,provisionPaidCheckoutSubscription,reconcilePaidCheckoutSubscription,selection,subscriptionAnchor,subscriptionSummary,PREPAID_PENDING_MESSAGE} from '../worker/supporter-billing.js';
import {createHmac} from 'node:crypto';
import {readdir} from 'node:fs/promises';

const jst=(y,m,d,h=0,mi=0,s=0)=>Date.UTC(y,m-1,d,h,mi,s)/1000-32400;
const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com'};
const UID='123456789012345678';
const RealDate=Date;
function at(t,seconds){
 class Fixed extends RealDate{constructor(...v){if(v.length)super(...v);else super(seconds*1000);}static now(){return seconds*1000;}}
 globalThis.Date=Fixed;t.after(()=>{globalThis.Date=RealDate;});
}
async function database(){
 const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement=(sql,values=[])=>({bind(...input){return statement(sql,input.map(v=>v===undefined?null:v));},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at,settings_json) VALUES(?,?,?,?,?)').run(UID,'a@example.com','x','x','{}');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID,'cus_1');
 return {raw,db:{prepare:sql=>statement(sql),async batch(list){const out=[];for(const item of list)out.push(await item.run());return out;}}};
}
const session=(anchor,extra={})=>({id:'cs_test_nov',livemode:false,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_1',client_reference_id:UID,payment_intent:'pi_1',amount_total:300,currency:'jpy',created:10,
 metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:UID,dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_rule_packs:'0',dpi_legal_consent_version:'x',dpi_billing_anchor:String(anchor),dpi_initial_total:'300'},...extra});
// 本物と同じく、同じ冪等キーでは同じ結果を返す Stripe の代わり。
function stripe(t,{failItem=0,created=0}={}){
 const state={subscriptions:[],items:[],keys:new Map(),failItem,calls:[]},original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname.replace('/v1/',''),method=init.method||'GET',params=new URLSearchParams(init.body||''),key=init.headers?.['Idempotency-Key'];state.calls.push(`${method} ${path}`);
  if(path==='subscriptions'&&method==='GET')return Response.json({livemode:false,data:state.subscriptions,has_more:false});
  if(path==='payment_intents/pi_1')return Response.json({livemode:false,id:'pi_1',status:'succeeded',customer:'cus_1',amount_received:300,payment_method:'pm_x'});
  if(path==='subscriptions'&&method==='POST'){
   if(state.keys.has(key))return Response.json(state.keys.get(key));
   const metadata=Object.fromEntries([...params].filter(([k])=>k.startsWith('metadata[')).map(([k,v])=>[k.slice(9,-1),v]));
   const item={livemode:false,id:'sub_1',status:'active',customer:'cus_1',created:created||Math.floor(Date.now()/1000),anchor:params.get('billing_cycle_anchor'),metadata,items:{data:[{id:'si_1',price:{id:'price_basic',unit_amount:300,currency:'jpy'},quantity:1,current_period_start:Math.floor(Date.now()/1000),current_period_end:Number(params.get('billing_cycle_anchor'))}]}};
   state.subscriptions=[item];state.keys.set(key,item);return Response.json(item);
  }
  if(path==='invoiceitems'&&method==='GET')return Response.json({livemode:false,data:state.items,has_more:false});
  if(path==='invoiceitems'&&method==='POST'){
   if(state.failItem-->0)return Response.json({error:{message:'x'}},{status:500});
   if(state.keys.has(key))return Response.json(state.keys.get(key));
   const item={livemode:false,id:`ii_${state.items.length+1}`,amount:Number(params.get('amount')),subscription:params.get('subscription'),metadata:{dpi_prepaid_renewal:params.get('metadata[dpi_prepaid_renewal]'),dpi_prepaid_subscription:params.get('metadata[dpi_prepaid_subscription]')}};
   state.items.push(item);state.keys.set(key,item);return Response.json(item);
  }
  if(path==='customers/cus_1')return Response.json({livemode:false,id:'cus_1',balance:0,email:'a@example.com'});
  throw new Error(`unexpected ${method} ${path}`);
 };
 return state;
}

test('11月の申込みだけ 1 か月分で、次回の請求は 12月26日。10月・12月は通常どおり',()=>{
 for(const when of [jst(2026,11,1),jst(2026,11,25,22),jst(2026,11,25,23,59,59),jst(2026,11,26),jst(2026,11,30,23,59,59)]){
  const value=billingSchedule(when*1000);assert.equal(value.initialMonths,1);assert.equal(value.anchor,jst(2026,12,26));assert.equal(value.lateMonth,false);assert.equal(value.novemberOffer,true);
 }
 assert.deepEqual(billingSchedule(jst(2026,10,31,23,59,59)*1000),{billingDay:26,anchor:jst(2026,11,26),initialMonths:2,lateMonth:true});
 assert.deepEqual(billingSchedule(jst(2026,12,1)*1000),{billingDay:26,anchor:jst(2026,12,26),initialMonths:1,lateMonth:false});
 assert.deepEqual(billingSchedule(jst(2026,12,26)*1000),{billingDay:26,anchor:jst(2027,1,26),initialMonths:2,lateMonth:true});
 assert.deepEqual(billingSchedule(jst(2027,11,26)*1000),{billingDay:26,anchor:jst(2027,12,26),initialMonths:2,lateMonth:true});
});

test('Stripe の請求日: 25日の申込みは 26日にして前払いを記録、26日以降はそのまま。0時の直前は待ってもらう',()=>{
 const anchor=jst(2026,12,26);
 assert.deepEqual(subscriptionAnchor(anchor,jst(2026,11,25,22)),{anchor:jst(2026,11,26),prepaid:true,until:anchor});
 assert.deepEqual(subscriptionAnchor(anchor,jst(2026,11,25,23,56)),{anchor:jst(2026,11,26),prepaid:true,until:anchor});
 assert.throws(()=>subscriptionAnchor(anchor,jst(2026,11,25,23,58)),error=>error.status===503);
 for(const when of [jst(2026,11,26),jst(2026,11,26,0,0,1),jst(2026,11,30,23,59),jst(2026,12,1),jst(2026,12,20)])assert.deepEqual(subscriptionAnchor(anchor,when),{anchor,prepaid:false});
 // 普段の申込みは、どの日でも前払いにならない
 for(let day=0;day<800;day+=1)for(const hour of [0,12,23]){const when=jst(2026,12,1,hour,59)+day*86400,schedule=billingSchedule(when*1000);assert.equal(subscriptionAnchor(schedule.anchor,when).prepaid,false,new RealDate(when*1000).toISOString());}
});

test('契約の作成: カード・残高・カスタムとも 1 か月分で、オプションの分も差し引く',()=>{
 const now=jst(2026,11,25,22),schedule=billingSchedule(now*1000),choice=selection({plan:'plus',channelPacks:1,serverPacks:1});
 const credit=creditSignupSubscriptionParams(env,'cus_1',UID,choice,schedule,'x','r',now);
 assert.equal(credit.billing_cycle_anchor,String(jst(2026,11,26)));assert.equal(credit['metadata[dpi_prepaid_yen]'],'1200');assert.equal(credit['metadata[dpi_prepaid_until]'],String(jst(2026,12,26)));
 const card=paidCheckoutSubscriptionParams(env,session(schedule.anchor),{payment_method:'pm_x'},now);assert.equal(card.billing_cycle_anchor,String(jst(2026,11,26)));assert.equal(card['metadata[dpi_prepaid_yen]'],'300');
 const later=paidCheckoutSubscriptionParams(env,session(schedule.anchor),{payment_method:'pm_x'},jst(2026,11,26,0,10));assert.equal(later.billing_cycle_anchor,String(jst(2026,12,26)));assert.equal(later['metadata[dpi_prepaid_yen]'],undefined);
 const custom=customInitialCheckoutParams('cus_1',UID,{id:'c',status:'offered',confirmed_yen:1000,revision:1,name:'C'},'r',jst(2026,11,28)*1000);assert.equal(custom['line_items[0][price_data][unit_amount]'],'1000');assert.equal(custom['metadata[dpi_initial_months]'],'1');
});

test('25日の申込み: 差し引く明細は 1 回だけ。通知の再送・作成の失敗・遅い再送でも増えない',async t=>{
 const now=jst(2026,11,25,22);at(t,now);const state=stripe(t,{failItem:1});
 await assert.rejects(()=>provisionPaidCheckoutSubscription(env,session(jst(2026,12,26))));
 assert.equal(state.subscriptions.length,1);assert.equal(state.items.length,0);
 for(let i=0;i<3;i+=1)await provisionPaidCheckoutSubscription(env,session(jst(2026,12,26)));
 assert.deepEqual(state.items.map(item=>[item.amount,item.subscription]),[[-300,'sub_1']]);
 state.keys.clear();at(t,now+30*3600); // 冪等キーが切れた後の再送でも、付いているので増えない
 await provisionPaidCheckoutSubscription(env,session(jst(2026,12,26)));assert.equal(state.items.length,1);
 // 付けられないまま時間がたっても、後から回復する
 state.items.length=0;state.keys.clear();await provisionPaidCheckoutSubscription(env,session(jst(2026,12,26)));assert.equal(state.items.length,1);
 state.items.length=0;state.keys.clear();await reconcilePaidCheckoutSubscription(env,'cus_1',UID);assert.equal(state.items.length,1);await reconcilePaidCheckoutSubscription(env,'cus_1',UID);assert.equal(state.items.length,1);
});

test('契約作成の通知でも差し引く明細を付ける。知らない顧客・前払いの無い契約では付けない',async t=>{
 const now=jst(2026,11,25,22);at(t,now);const {db}=await database(),state=stripe(t);
 const meta={dpi_user:UID,dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_rule_packs:'0',dpi_prepaid_renewal:String(jst(2026,11,26)),dpi_prepaid_until:String(jst(2026,12,26)),dpi_prepaid_yen:'300'};
 const subscription=(extra={})=>({livemode:false,id:'sub_1',status:'active',customer:'cus_1',created:now,metadata:meta,items:{data:[{id:'si',price:{id:'price_basic',unit_amount:300,currency:'jpy'},quantity:1,current_period_start:now,current_period_end:jst(2026,11,26)}]},...extra});
 const send=async object=>{const body=JSON.stringify({id:`evt_${Math.random().toString(36).slice(2)}`,type:'customer.subscription.created',livemode:false,created:now,data:{object}}),sig=createHmac('sha256','whsec_x').update(`${now}.${body}`).digest('hex');
  return billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook',{method:'POST',body,headers:{'stripe-signature':`t=${now},v1=${sig}`}}),{...env,REUSE_DB:db});};
 state.subscriptions=[subscription()];
 for(let i=0;i<2;i+=1)assert.equal((await send(subscription())).status,200);
 assert.equal(state.items.length,1);
 state.keys.clear();await send(subscription({customer:'cus_other'}));await send(subscription({metadata:{...meta,dpi_prepaid_renewal:undefined}}));await send(subscription({metadata:{...meta,dpi_prepaid_yen:'-5'}}));
 assert.equal(state.items.length,1);
});

test('26日 0 時 30 分までは変更・解約を待ってもらい、次回の請求日は 12月26日と見せる',async t=>{
 const renewal=jst(2026,11,26),sub={id:'sub_1',status:'active',customer:'cus_1',livemode:false,metadata:{dpi_prepaid_renewal:String(renewal),dpi_prepaid_until:String(jst(2026,12,26)),dpi_prepaid_yen:'300'},items:{data:[{id:'si',price:{id:'price_basic',unit_amount:300,currency:'jpy'},quantity:1,current_period_start:jst(2026,11,25,22),current_period_end:renewal}]}};
 assert.equal(prepaidRenewalPending(sub,jst(2026,11,25,23)),true);assert.equal(prepaidRenewalPending(sub,jst(2026,11,26,0,29)),true);assert.equal(prepaidRenewalPending(sub,jst(2026,11,26,0,30)),false);assert.equal(prepaidRenewalPending({metadata:{}},renewal),false);
 assert.equal(subscriptionSummary(sub,env).nextRenewalAt,jst(2026,12,26));
 const moved={...sub,items:{data:[{...sub.items.data[0],current_period_start:renewal,current_period_end:jst(2026,12,26)}]}};assert.equal(subscriptionSummary(moved,env).nextRenewalAt,jst(2026,12,26));
 const next={...sub,items:{data:[{...sub.items.data[0],current_period_start:jst(2026,12,26),current_period_end:jst(2027,1,26)}]}};assert.equal(subscriptionSummary(next,env).nextRenewalAt,jst(2027,1,26));
 at(t,jst(2026,11,25,23));const {db}=await database(),state=stripe(t);state.subscriptions=[sub];
 for(const action of ['portal','preview-update','update']){const response=await billingAction(new Request(`https://dpi-bot.com/api/supporter/billing/${action}`),{...env,REUSE_DB:db},db,UID,{plan:'plus',channelPacks:0,serverPacks:0,rulePacks:0});assert.equal(response.status,409,action);assert.equal((await response.json()).message,PREPAID_PENDING_MESSAGE);}
});

test('画面と規約: 11月だけの扱いを書き、画面の計算もサーバーと同じ',async()=>{
 const read=path=>readFile(new URL(path,import.meta.url),'utf8');
 for(const path of ['../site/supporter/index.html','../site/supporter/plans.html','../terms/terms.md','../terms/spec.md'])assert.match(await read(path),/2026年11月中[\s\S]{0,160}12月26日/,path);
 const source=(await read('../site/supporter/app.js')).match(/function initialTerms\(now=new Date\(\)\)\{[\s\S]*?\n\}/)[0];
 const initialTerms=new Function(`${source};return initialTerms;`)();
 for(const when of [jst(2026,10,31,23,59),jst(2026,11,1),jst(2026,11,25,22),jst(2026,11,26),jst(2026,11,30,23,59),jst(2026,12,1),jst(2026,12,26),jst(2027,11,26)]){
  const server=billingSchedule(when*1000),screen=initialTerms(new Date(when*1000));assert.equal(screen.months,server.initialMonths);assert.equal(screen.lateMonth,server.lateMonth);assert.equal(screen.november,!!server.novemberOffer);
 }
});
