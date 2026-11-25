import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {billingWebhook,runSupporterBillingSchedule} from '../worker/supporter-billing.js';
import {ensurePrices,RUNTIME_WRITE_PROBES,verifyStripeWritePermissions} from '../scripts/stripe-setup-lib.mjs';

const UID='123456789012345678',CUSTOMER='cus_mail';
async function database(t){
 let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'));}catch{t.skip('node:sqlite is not available');return null;}
 const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement=(sql,values=[])=>({bind(...input){return statement(sql,input);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES(?,?,?,?)').run(UID,'mail@example.jp','x','x');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID,CUSTOMER);
 return{raw,db:{prepare:sql=>statement(sql),async batch(items){for(const item of items)await item.run();}}};
}
const env=db=>({SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_example',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x',REUSE_DB:db,NOTICE_FROM_EMAIL:'notice@example.jp',NOTICE_EMAIL:{async send(){throw new Error('mail down');}}});
async function webhook(environment,event){
 const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000),signature=createHmac('sha256','whsec_example').update(`${timestamp}.${raw}`).digest('hex');
 return billingWebhook(new Request('https://dpi-bot.com/webhook',{method:'POST',body:raw,headers:{'stripe-signature':`t=${timestamp},v1=${signature}`}}),environment);
}

test('メールが失敗してもWebhookは決済状態とイベントを記録し、定期処理が再送を1回試す',async t=>{
 const store=await database(t);if(!store)return;
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname.replace('/v1/',''),method=init.method||'GET';
  if(method==='POST'&&path==='invoices/in_mail')return Response.json({id:'in_mail',status:'open',customer:CUSTOMER,subscription:'sub_mail',billing_reason:'subscription_cycle',amount_due:300,currency:'jpy',created:Math.floor(Date.now()/1000),livemode:false});
  if(method==='GET'&&path==='subscriptions')return Response.json({data:[]});
  return Response.json({data:[],livemode:false});
 };
 const invoice={id:'in_mail',customer:CUSTOMER,subscription:'sub_mail',billing_reason:'subscription_cycle',amount_due:300,currency:'jpy',created:Math.floor(Date.now()/1000)};
 const response=await webhook(env(store.db),{id:'evt_mail',type:'invoice.payment_failed',livemode:false,created:invoice.created,data:{object:invoice}});
 assert.equal(response.status,200);assert.equal(store.raw.prepare('SELECT status FROM supporter_dunning WHERE invoice_id=?').get('in_mail').status,'retry_scheduled');
 assert.ok(store.raw.prepare('SELECT id FROM supporter_stripe_events WHERE id=?').get('evt_mail'));
 assert.equal(store.raw.prepare('SELECT status,attempts FROM supporter_billing_notifications WHERE invoice_id=?').get('in_mail').status,'failed');
 await runSupporterBillingSchedule(env(store.db),Date.now());
 assert.equal(store.raw.prepare('SELECT attempts FROM supporter_billing_notifications WHERE invoice_id=?').get('in_mail').attempts,2);
});

test('通知再送は5回上限・3日期限を守り、支払い済み後の失敗案内を送らない',async t=>{
 const store=await database(t);if(!store)return;
 const now=Math.floor(Date.now()/1000),future=now+86400;
 for(const [id,status] of [['in_cap','retry_scheduled'],['in_old','retry_scheduled'],['in_paid','paid']])store.raw.prepare(`INSERT INTO supporter_dunning
  (invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES(?,?,'sub_mail',300,'jpy',?,?,?,?,?)`).run(id,CUSTOMER,status,now,future,future+3600,now);
 store.raw.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,attempts,last_error,updated_at) VALUES
  ('in_cap','payment_failed','failed',5,?,?),('in_old','payment_failed','failed',1,?,?),('in_paid','payment_failed','failed',1,?,?)`).run(`${now}:Error`,now,`${now-4*86400}:Error`,now,`${now}:Error`,now);
 let sends=0;const environment={...env(store.db),NOTICE_EMAIL:{async send(){sends+=1;}}},original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>Response.json({data:[],livemode:false});
 await runSupporterBillingSchedule(environment,now*1000);
 assert.equal(sends,0);
 assert.deepEqual(store.raw.prepare('SELECT invoice_id,attempts FROM supporter_billing_notifications ORDER BY invoice_id').all().map(row=>[row.invoice_id,row.attempts]),[['in_cap',5],['in_old',1],['in_paid',1]]);
});

test('WebhookのDB失敗は成功扱いにしない',async()=>{
 const broken=env({prepare(){throw new Error('D1 unavailable');}});
 await assert.rejects(webhook(broken,{id:'evt_db',type:'invoice.paid',livemode:false,created:1,data:{object:{id:'in_db'}}}),/D1 unavailable/);
});

test('チャージの支払いページは支払い方法を絞らず、チャージの Discord 通知を作らない',async()=>{
 const source=await readFile(new URL('../worker/supporter-billing.js',import.meta.url),'utf8');
 const topup=source.slice(source.indexOf("if(action==='topup'){"),source.indexOf('dpi-credit-checkout-'));
 assert.ok(topup.length>200);assert.doesNotMatch(topup,/excluded_payment_method_types|payment_method_types|EXCLUDED_PAYMENT_METHODS/);
 assert.doesNotMatch(source,/kind:failed\?'topup_failed':'topup'|クレジットチャージ完了'|title:'クレジットチャージ/);
});

test('ensurePricesは税込・licensed・有効商品だけを受け入れる',async()=>{
 const base={id:'price_x',lookup_key:'dpi_supporter_basic_monthly',active:true,unit_amount:300,currency:'jpy',tax_behavior:'inclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{active:true}};
 const prices=(await import('../scripts/stripe-setup-lib.mjs')).PRICES;
 for(const change of [{tax_behavior:'unspecified'},{recurring:{...base.recurring,usage_type:'metered'}},{product:{active:false}}]){
  const data=prices.map(([,lookup,,yen],index)=>({...base,...change,id:`price_${index}`,lookup_key:lookup,unit_amount:yen}));
  await assert.rejects(ensurePrices(async(method,path)=>path.startsWith('prices?')?{data}:{} ,()=>{}));
 }
 await assert.doesNotReject(ensurePrices(async(method,path)=>path.startsWith('prices?')?{data:prices.map(([,lookup,,yen],index)=>({...base,id:`price_${index}`,lookup_key:lookup,unit_amount:yen}))}:{} ,()=>{}));
});

test('書き込み権限判定は403を拒否し、404・400を許可し、200を異常扱いする',async()=>{
 const response=status=>async()=>new Response('{}',{status});
 await assert.rejects(verifyStripeWritePermissions('rk_live_x',{fetchImpl:response(403)}),error=>error.status===403);
 for(const status of [401,429,500])await assert.rejects(verifyStripeWritePermissions('rk_live_x',{fetchImpl:response(status)}),/確認できませんでした/);
 assert.equal(await verifyStripeWritePermissions('rk_live_x',{fetchImpl:response(404)}),RUNTIME_WRITE_PROBES.length);
 assert.equal(await verifyStripeWritePermissions('rk_live_x',{fetchImpl:response(400)}),RUNTIME_WRITE_PROBES.length);
 await assert.rejects(verifyStripeWritePermissions('rk_live_x',{fetchImpl:response(200)}),/成功してしまいました/);
});

test('期限切れの失敗通知が多くても、新しい失敗通知を送り直す。送信後の記録の失敗では送り直さない',async t=>{
 const store=await database(t);if(!store)return;
 const now=Math.floor(Date.now()/1000),insert=(id,at)=>{
  store.raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES(?,?,'sub_mail',300,'jpy','retry_scheduled',?,?,?,?)`).run(id,CUSTOMER,now,now+86400,now+90000,now);
  store.raw.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,attempts,last_error,updated_at) VALUES(?,'payment_failed','failed',1,?,?)`).run(id,`${at}:Error`,at);
 };
 for(let index=0;index<40;index+=1)insert(`in_expired_${index}`,now-5*86400);
 insert('in_fresh',now-3600);
 let sends=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>Response.json({data:[],livemode:false});
 const db={...store.db,prepare(sql){if(sql.includes("SET status='sent'"))throw new Error('D1 unavailable');return store.db.prepare(sql);}};
 const environment={...env(db),NOTICE_EMAIL:{async send(){sends+=1;}}};
 await runSupporterBillingSchedule(environment,now*1000);await runSupporterBillingSchedule(environment,now*1000);
 assert.equal(sends,1);
 assert.notEqual(store.raw.prepare("SELECT status FROM supporter_billing_notifications WHERE invoice_id='in_fresh'").get().status,'failed');
});
