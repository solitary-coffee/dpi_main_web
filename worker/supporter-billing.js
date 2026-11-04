// Test-only integration. Live keys are deliberately rejected until delivery is ready.
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function integrationIdentifier(prefix){const bytes=crypto.getRandomValues(new Uint8Array(8));return `${prefix}${[...bytes].map(value=>String.fromCharCode(97+value%26)).join('')}`;}
export function billingReady(env){return env.SUPPORTER_BILLING_MODE==='test' && /^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||'') && !!env.STRIPE_WEBHOOK_SECRET && !!env.STRIPE_PRICE_SUPPORTER && !!env.STRIPE_PRICE_PLUS && !!env.STRIPE_PRICE_ADDON && !!env.STRIPE_PORTAL_CONFIG;}
async function stripe(env,path,params,key,method=params?'POST':'GET'){
 if(!billingReady(env)) fail('テスト決済の設定が完了していません。',503);
 const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2026-09-30.endive'};
 if(key)headers['Idempotency-Key']=key;
 if(params)headers['Content-Type']='application/x-www-form-urlencoded';
 const r=await fetch(`https://api.stripe.com/v1/${path}`,{method,headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});
 const result=await r.json();if(!r.ok)fail('Stripeへの接続に失敗しました。時間をおいて再試行してください。',502);
 if(result.livemode===true)fail('本番決済は無効です。',503);
 return result;
}
export function selection(input){
 if(!['supporter','plus'].includes(input.plan)||!Number.isInteger(input.packs)||input.packs<0||input.packs>2||(input.plan==='plus'&&input.packs!==0))fail('プランまたは追加パック数が不正です。');
 return {plan:input.plan,packs:input.packs,monthly:input.plan==='plus'?800:300+200*input.packs,channels:input.plan==='plus'?10:2+3*input.packs};
}
async function subscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data.filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
const unix = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
export function subscriptionSummary(subscription,env={}){
 const labels=new Map([
  [env.STRIPE_PRICE_SUPPORTER,'BASIC'],
  [env.STRIPE_PRICE_PLUS,'Plus'],
  [env.STRIPE_PRICE_ADDON,'追加3チャンネル'],
 ].filter(([id])=>id));
 const items=(subscription.items?.data||[]).map(item=>{
  const quantity=Number.isFinite(Number(item.quantity))&&Number(item.quantity)>0?Number(item.quantity):1;
  const unitAmount=Number.isFinite(Number(item.price?.unit_amount))?Number(item.price.unit_amount):0;
  return {price:item.price?.id||'',label:labels.get(item.price?.id)||item.price?.nickname||'契約項目',quantity,unitAmount,subtotal:unitAmount*quantity,currency:(item.price?.currency||'jpy').toLowerCase(),periodStart:unix(item.current_period_start),periodEnd:unix(item.current_period_end)};
 });
 const currentPeriodStart=items.map(item=>item.periodStart).filter(Boolean).sort((a,b)=>a-b)[0]||unix(subscription.current_period_start);
 const nextRenewalAt=items.map(item=>item.periodEnd).filter(Boolean).sort((a,b)=>b-a)[0]||unix(subscription.current_period_end);
 const currency=items.find(item=>item.currency)?.currency||'jpy';
 return {status:subscription.status||'unknown',cancelAtPeriodEnd:subscription.cancel_at_period_end===true,startedAt:unix(subscription.start_date)||unix(subscription.created),currentPeriodStart,nextRenewalAt,amount:items.reduce((sum,item)=>sum+item.subtotal,0),currency,plan:items.filter(item=>item.price!==env.STRIPE_PRICE_ADDON).map(item=>item.label).join(' + ')||'契約中プラン',items};
}
export async function customerSubscriptionSummaries(env,customer){
 if(!customer||!billingReady(env))return [];
 return (await subscriptions(env,customer)).map(subscription=>subscriptionSummary(subscription,env));
}
export async function subscriptionSummariesByCustomer(env,customers){
 const wanted=new Set((customers||[]).filter(Boolean));
 const grouped=new Map([...wanted].map(customer=>[customer,[]]));
 if(!wanted.size||!billingReady(env))return grouped;
 let startingAfter='';
 for(let page=0;page<5;page++){
  const suffix=startingAfter?`&starting_after=${encodeURIComponent(startingAfter)}`:'';
  const result=await stripe(env,`subscriptions?status=all&limit=100${suffix}`);
  for(const subscription of result.data||[]){
   if(['canceled','incomplete_expired'].includes(subscription.status))continue;
   const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
   if(wanted.has(customer))grouped.get(customer).push(subscriptionSummary(subscription,env));
  }
  if(!result.has_more||!result.data?.length)break;
  startingAfter=result.data.at(-1).id;
 }
 return grouped;
}
export async function billingAction(request,env,db,uid,input={}){
 const action=new URL(request.url).pathname.split('/').pop();
 if(!billingReady(env))return json({message:'テスト決済の設定が完了していません。'},503);
 if(!await db.prepare('SELECT discord_user_id FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first())return json({message:'先に登録してください。'},409);
 await db.prepare('INSERT INTO supporter_billing(discord_user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(uid).run();
 let row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(action==='status'){
  return json({mode:'test',subscriptions:await customerSubscriptionSummaries(env,row.customer_id),deliveryEnabled:false});
 }
 if(!row.customer_id){const customer=await stripe(env,'customers',{'metadata[dpi_user]':uid},`dpi-customer-${uid}`);await db.prepare('UPDATE supporter_billing SET customer_id=? WHERE discord_user_id=? AND customer_id IS NULL').bind(customer.id,uid).run();row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();}
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin || !/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 if(action==='portal'){const portal=await stripe(env,'billing_portal/sessions',{customer:row.customer_id,configuration:env.STRIPE_PORTAL_CONFIG,return_url:`${origin}/site/supporter/`});return json({url:portal.url});}
 if(action!=='checkout')return json({message:'Not found'},404);
 const choice=selection(input);
 if((await subscriptions(env,row.customer_id)).length)return json({message:'契約が存在します。契約管理画面をご利用ください。'},409);
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'subscription',customer:row.customer_id,client_reference_id:uid,'subscription_data[metadata][dpi_user]':uid,'subscription_data[billing_mode][type]':'flexible','line_items[0][price]':choice.plan==='plus'?env.STRIPE_PRICE_PLUS:env.STRIPE_PRICE_SUPPORTER,'line_items[0][quantity]':'1',success_url:`${origin}/site/supporter/?checkout=returned`,cancel_url:`${origin}/site/supporter/?checkout=canceled`,expires_at:String(Math.floor(Date.now()/1000)+3600),integration_identifier:integrationIdentifier('dpi_basic_')};
 if(choice.packs){params['line_items[1][price]']=env.STRIPE_PRICE_ADDON;params['line_items[1][quantity]']=String(choice.packs);}
 await db.prepare('UPDATE supporter_billing SET checkout_key=?,checkout_params=? WHERE discord_user_id=? AND checkout_key IS NULL').bind(crypto.randomUUID(),JSON.stringify(params),uid).run();
 row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const saved=JSON.parse(row.checkout_params);
 if(!row.checkout_id && Number(saved.expires_at)<Date.now()/1000)fail('決済作成の状態確認が必要です。管理者へお問い合わせください。',409);
 const checkout=row.checkout_id?await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`):await stripe(env,'checkout/sessions',saved,`dpi-checkout-${row.checkout_key}`);
 await db.prepare('UPDATE supporter_billing SET checkout_id=? WHERE discord_user_id=? AND checkout_key=?').bind(checkout.id,uid,row.checkout_key).run();
 if(checkout.status==='expired'){await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();return json({message:'前の決済画面が期限切れです。再度お試しください。'},409);}
 if(checkout.status!=='open')return json({message:'決済結果を確認中です。契約状態を更新してください。'},409);
 if(saved['line_items[0][price]']!==params['line_items[0][price]']||(saved['line_items[1][quantity]']||'0')!==(params['line_items[1][quantity]']||'0'))return json({message:'別の条件で決済画面を作成済みです。期限切れ後に変更できます（最大1時間）。'},409);
 return json({url:checkout.url,mode:'test'});
}
function adminChoice(input){
 const plan=String(input.plan||'');
 const packs=Number(input.packs);
 return selection({plan,packs});
}
function activeSubscription(list){
 return list.find(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status))||list[0];
}
function actionOrigin(env){
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin||!/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 return origin;
}
export async function adminBillingAction(env,customer,uid,input){
 if(!billingReady(env))fail('テスト決済の設定が完了していません。',503);
 if(!customer)fail('このユーザーにはStripe顧客情報がありません。',409);
 const action=String(input?.action||'');
 const requestId=String(input?.requestId||'');
 const reason=String(input?.reason||'').trim();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)fail('操作理由を5〜500文字で入力してください。',400);
 const key=`dpi-admin-${action}-${requestId}`;
 const list=await subscriptions(env,customer);
 const current=activeSubscription(list);
 if(action==='cancel_at_period_end'){
  if(!current)fail('変更できる契約がありません。',409);
  await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,{cancel_at_period_end:'true','metadata[dpi_admin_reason]':reason},key);
  return {message:'期間末での契約終了を予約しました。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='cancel_immediately'){
  if(!current)fail('終了できる契約がありません。',409);
  await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,null,key,'DELETE');
  return {message:'契約を即時終了しました。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='change_subscription'){
  if(!current)fail('変更できる契約がありません。',409);
  const choice=adminChoice(input);
  const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
  const addon=current.items?.data?.find(item=>item.price?.id===env.STRIPE_PRICE_ADDON);
  if(!base?.id)fail('契約項目を確認できませんでした。',409);
  const params={'items[0][id]':base.id,'items[0][price]':choice.plan==='plus'?env.STRIPE_PRICE_PLUS:env.STRIPE_PRICE_SUPPORTER,'items[0][quantity]':'1',proration_behavior:'create_prorations','metadata[dpi_admin_reason]':reason};
  if(addon){params['items[1][id]']=addon.id;if(choice.packs){params['items[1][quantity]']=String(choice.packs);}else{params['items[1][deleted]']='true';}}
  else if(choice.packs){params['items[1][price]']=env.STRIPE_PRICE_ADDON;params['items[1][quantity]']=String(choice.packs);}
  await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,params,key);
  return {message:'契約内容を変更しました。日割り差額はStripeの請求へ反映されます。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='refund_latest'){
  const amount=Number(input.amount);
  if(!Number.isInteger(amount)||amount<1||amount>1_000_000)fail('返金額を1〜1,000,000円で指定してください。',400);
  const invoices=(await stripe(env,`invoices?customer=${encodeURIComponent(customer)}&status=paid&limit=10&expand[]=data.payments`)).data||[];
  const invoice=invoices.find(item=>Number(item.amount_paid)>=amount&&(item.payments?.data||[]).some(payment=>payment.payment?.payment_intent));
  if(!invoice)fail('返金可能な支払いを確認できませんでした。',409);
  const paymentIntent=invoice.payments.data.find(payment=>payment.payment?.payment_intent).payment.payment_intent;
  const params={amount:String(amount),reason:'requested_by_customer','metadata[dpi_user]':uid,'metadata[dpi_admin_reason]':reason};
  params.payment_intent=typeof paymentIntent==='string'?paymentIntent:paymentIntent.id;
  const refund=await stripe(env,'refunds',params,key);
  return {message:`${amount.toLocaleString('ja-JP')}円の返金を受け付けました。`,refund:{status:refund.status||'pending',amount:Number(refund.amount||amount),currency:refund.currency||'jpy'}};
 }
 if(action==='create_payment_link'){
  const amount=Number(input.amount);
  const description=String(input.description||'').trim();
  if(!Number.isInteger(amount)||amount<100||amount>1_000_000||description.length<2||description.length>80)fail('支払い内容と100〜1,000,000円の金額を確認してください。',400);
  const origin=actionOrigin(env);
  const checkout=await stripe(env,'checkout/sessions',{mode:'payment',customer,client_reference_id:uid,'line_items[0][price_data][currency]':'jpy','line_items[0][price_data][unit_amount]':String(amount),'line_items[0][price_data][product_data][name]':description,'line_items[0][quantity]':'1','metadata[dpi_user]':uid,'metadata[dpi_admin_reason]':reason,success_url:`${origin}/site/supporter/?payment=completed`,cancel_url:`${origin}/site/supporter/?payment=canceled`,expires_at:String(Math.floor(Date.now()/1000)+86400),integration_identifier:integrationIdentifier('dpi_admin_')},key);
  return {message:'24時間有効の支払いURLを作成しました。',url:checkout.url,expiresAt:checkout.expires_at||null};
 }
 fail('管理操作を確認してください。',400);
}
export async function verifySignature(raw,header,secret,now=Date.now()){
 const parts=(header||'').split(',').map(p=>p.trim().split('='));const ts=parts.find(p=>p[0]==='t')?.[1];
 if(!secret||!/^\d+$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300)return false;
 const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 for(const [,sig] of parts.filter(p=>p[0]==='v1'&&/^[0-9a-f]{64}$/.test(p[1]||''))){const bytes=Uint8Array.from(sig.match(/../g),h=>parseInt(h,16));if(await crypto.subtle.verify('HMAC',key,bytes,enc.encode(`${ts}.${raw}`)))return true;}
 return false;
}
export async function billingWebhook(request,env){
 if(request.method!=='POST')return json({message:'Method not allowed'},405);
 if(!billingReady(env))return json({message:'Unavailable'},503);
 const reader=request.body?.getReader();if(!reader)return json({},400);const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return json({},413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const raw=new TextDecoder().decode(bytes);
 if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET))return json({},400);
 let event;try{event=JSON.parse(raw);}catch{return json({},400);}
 if(event.livemode!==false||typeof event.id!=='string')return json({},400);
 const allowed=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created','radar.early_fraud_warning.created'];
 if(!allowed.includes(event.type))return json({received:true});
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(event.data?.object?.customer||'')]);
 return json({received:true});
}
