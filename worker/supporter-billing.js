// Test-only integration. Live keys are deliberately rejected until delivery is ready.
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clean=value=>String(value??'').trim();
const invoiceSubscriptionId=invoice=>typeof invoice?.subscription==='string'?invoice.subscription:typeof invoice?.parent?.subscription_details?.subscription==='string'?invoice.parent.subscription_details.subscription:'';
const safeInvoiceUrl=value=>{try{const url=new URL(clean(value));return url.protocol==='https:'&&['invoice.stripe.com','pay.stripe.com'].includes(url.hostname)?url.href:'';}catch{return '';}};
const stripeId=value=>typeof value==='string'?value:value?.id||'';
async function idempotencyKey(prefix,value){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value??'')));
 return `${prefix}${[...new Uint8Array(bytes)].slice(0,16).map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
export function dunningSchedule(timestamp=Math.floor(Date.now()/1000)){
 const jst=new Date(Number(timestamp)*1000+9*60*60*1000);const year=jst.getUTCFullYear(),month=jst.getUTCMonth();
 const lastDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 const retryAt=Math.floor((Date.UTC(year,month,lastDay,12,0,0)-9*60*60*1000)/1000);
 const suspendAt=Math.floor((Date.UTC(year,month+1,1,0,0,0)-9*60*60*1000)/1000);
 return {retryAt,suspendAt};
}
function integrationIdentifier(prefix){const bytes=crypto.getRandomValues(new Uint8Array(8));return `${prefix}${[...bytes].map(value=>String.fromCharCode(97+value%26)).join('')}`;}
export const PLAN_CATALOG=Object.freeze({
 supporter:Object.freeze({id:'supporter',name:'BASIC',yen:300,channels:2,servers:1,rules:5,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_SUPPORTER'}),
 plus:Object.freeze({id:'plus',name:'Plus',yen:800,channels:10,servers:3,rules:15,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_PLUS'}),
 pro:Object.freeze({id:'pro',name:'Pro',yen:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true,priceEnv:'STRIPE_PRICE_PRO'}),
});
export function publicPlans(){return Object.values(PLAN_CATALOG).map(({priceEnv,...plan})=>plan);}
function planDefinition(plan){const value=PLAN_CATALOG[plan];if(!value)fail('プランまたは追加オプション数が不正です。');return value;}
function planPrice(env,plan){const definition=planDefinition(plan);const price=env[definition.priceEnv];if(!price)fail(`${definition.name}プランの決済設定が完了していません。`,503);return price;}
export function billingReady(env){return env.SUPPORTER_BILLING_MODE==='test' && /^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||'') && !!env.STRIPE_WEBHOOK_SECRET && !!env.STRIPE_PRICE_SUPPORTER && !!env.STRIPE_PRICE_PLUS && !!env.STRIPE_PRICE_PRO && !!env.STRIPE_PRICE_ADDON && !!env.STRIPE_PORTAL_CONFIG;}
async function stripe(env,path,params,key,method=params?'POST':'GET'){
 if(!billingReady(env)) fail('決済設定が完了していません。',503);
 const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2026-09-30.endive'};
 if(key)headers['Idempotency-Key']=key;
 if(params)headers['Content-Type']='application/x-www-form-urlencoded';
 const r=await fetch(`https://api.stripe.com/v1/${path}`,{method,headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});
 let result;
 try{result=await r.json();}
 catch{
  console.error('Stripe API returned invalid JSON',{path,status:r.status,requestId:r.headers.get('request-id')||''});
  throw Object.assign(new Error('Stripeから正しい応答を受信できませんでした。時間をおいて再試行してください。'),{status:502,stripeStatus:r.status});
 }
 if(!r.ok){
  const detail=String(result?.error?.message||'').replace(/[\r\n\t]/g,' ').slice(0,300);
  console.error('Stripe API request failed',{path,status:r.status,requestId:r.headers.get('request-id')||'',type:result?.error?.type||'',code:result?.error?.code||'',param:result?.error?.param||''});
  throw Object.assign(new Error(detail&&env.SUPPORTER_BILLING_MODE==='test'?`Stripeテスト環境が決済情報を拒否しました: ${detail}`:'Stripeへの接続に失敗しました。時間をおいて再試行してください。'),{status:502,stripeStatus:r.status,stripeCode:clean(result?.error?.code)});
 }
 if(result.livemode===true)fail('本番決済は無効です。',503);
 return result;
}
export function creditsFromBalance(balance){return Math.max(0,-Number(balance||0));}
export const CREDIT_TOPUP_MIN=500;
export const CREDIT_TOPUP_MAX=100000;
export function normalizeCreditTopupAmount(value){
 const amount=Number(value);
 if(!Number.isInteger(amount)||amount<CREDIT_TOPUP_MIN||amount>CREDIT_TOPUP_MAX)fail(`チャージ金額は${CREDIT_TOPUP_MIN.toLocaleString('ja-JP')}〜${CREDIT_TOPUP_MAX.toLocaleString('ja-JP')}円で指定してください。`,400);
 return amount;
}
export function creditExpiresAt(purchasedAt){
 const date=new Date(Number(purchasedAt)*1000);
 if(!Number.isFinite(date.getTime()))fail('クレジット購入日時を確認できませんでした。',400);
 const year=date.getUTCFullYear()+1,month=date.getUTCMonth(),day=date.getUTCDate();
 const lastDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 date.setUTCFullYear(year,month,Math.min(day,lastDay));
 return Math.floor(date.getTime()/1000);
}
export async function createBillingCustomer(env,uid,email,key){
 const params={'metadata[dpi_user]':uid};
 if(email)params.email=email;
 return await stripe(env,'customers',params,key);
}
export async function customerCredits(env,customer){
 if(!customer||!billingReady(env))return 0;
 return creditsFromBalance((await stripe(env,`customers/${encodeURIComponent(customer)}`)).balance);
}
async function purchasedCreditStatus(db,uid,stripeCredits){
 const now=Math.floor(Date.now()/1000);
 let lots;
 try{lots=await db.prepare(`SELECT id,remaining_amount,expires_at,status FROM supporter_credit_lots
  WHERE discord_user_id=? AND source_type='purchase' AND status='active' AND remaining_amount>0
  ORDER BY expires_at,id`).bind(uid).all();}
 catch(error){
  console.warn('Supporter credit history is unavailable',{errorName:error?.name||'Error'});
  return {balance:Math.max(0,Number(stripeCredits)||0),purchasedBalance:0,nextExpiry:null,topups:[]};
 }
 let tracked=(lots.results||[]).reduce((sum,row)=>sum+Number(row.remaining_amount||0),0);
 let consumed=Math.max(0,tracked-Math.max(0,Number(stripeCredits)||0));
 for(const lot of lots.results||[]){
  if(consumed<=0)break;
  const current=Number(lot.remaining_amount||0),used=Math.min(current,consumed),remaining=current-used;
  const result=await db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=?,status=?,updated_at=?
   WHERE id=? AND remaining_amount=? AND status='active'`).bind(remaining,remaining?'active':'consumed',now,lot.id,current).run();
  if(result.meta?.changes)consumed-=used;
 }
 const active=await db.prepare(`SELECT COALESCE(SUM(remaining_amount),0) AS purchased_balance,MIN(expires_at) AS next_expiry
  FROM supporter_credit_lots WHERE discord_user_id=? AND source_type='purchase' AND status='active' AND remaining_amount>0`).bind(uid).first();
 const history=await db.prepare(`SELECT request_id,amount,status,purchased_at,expires_at,created_at
  FROM supporter_credit_topups WHERE discord_user_id=? ORDER BY created_at DESC LIMIT 20`).bind(uid).all();
 return {
  balance:Math.max(0,Number(stripeCredits)||0),
  purchasedBalance:Math.max(0,Number(active?.purchased_balance)||0),
  nextExpiry:unix(active?.next_expiry),
  topups:(history.results||[]).map(row=>({id:clean(row.request_id),amount:Number(row.amount)||0,status:clean(row.status),purchasedAt:unix(row.purchased_at),expiresAt:unix(row.expires_at),createdAt:unix(row.created_at)})),
 };
}
async function fulfillCreditTopup(env,db,session){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='credit_topup'||session.payment_status!=='paid')return null;
 const uid=clean(metadata.dpi_user||session.client_reference_id),requestId=clean(metadata.dpi_topup_request_id);
 const customer=clean(stripeId(session.customer)),paymentIntent=clean(stripeId(session.payment_intent));
 const amount=normalizeCreditTopupAmount(metadata.dpi_credit_amount);
 if(!/^\d{17,20}$/.test(uid)||!/^[0-9a-f-]{36}$/i.test(requestId)||!customer||!paymentIntent||clean(session.currency).toLowerCase()!=='jpy'||Number(session.amount_total)!==amount)fail('クレジット決済情報を確認できませんでした。',409);
 const billing=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(!billing?.customer_id||billing.customer_id!==customer)fail('クレジット決済の利用者を確認できませんでした。',409);
 const purchasedAt=Number(session.created)||Math.floor(Date.now()/1000),expiresAt=creditExpiresAt(purchasedAt),now=Math.floor(Date.now()/1000);
 const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
  amount:String(-amount),currency:'jpy',description:`DPI-Bot credit top-up: ${session.id}`,
  'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'user_topup','metadata[dpi_checkout_session]':session.id,
 },`dpi-credit-topup-${session.id}`);
 const balanceAfter=creditsFromBalance(transaction.ending_balance);
 await db.batch([
  db.prepare(`INSERT INTO supporter_credit_topups
   (request_id,discord_user_id,customer_id,checkout_session_id,payment_intent_id,stripe_balance_transaction_id,amount,currency,status,purchased_at,expires_at,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,'jpy','credited',?,?,?,?)
   ON CONFLICT(request_id) DO UPDATE SET checkout_session_id=excluded.checkout_session_id,payment_intent_id=excluded.payment_intent_id,
    stripe_balance_transaction_id=excluded.stripe_balance_transaction_id,status='credited',purchased_at=excluded.purchased_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
   .bind(requestId,uid,customer,session.id,paymentIntent,transaction.id,amount,purchasedAt,expiresAt,purchasedAt,now),
  db.prepare(`INSERT INTO supporter_credit_lots
   (id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at)
   VALUES(?,?,'purchase',?,?,?,?, 'active',?,?) ON CONFLICT(source_type,source_id) DO NOTHING`)
   .bind(`topup:${session.id}`,uid,session.id,amount,amount,expiresAt,purchasedAt,now),
  db.prepare(`INSERT INTO supporter_credit_events
   (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
   VALUES(?,?,?,?,?,'credit_topup','user',?) ON CONFLICT DO NOTHING`)
   .bind(`topup:${session.id}`,uid,amount,balanceAfter,transaction.id,new Date(purchasedAt*1000).toISOString()),
 ]);
 return {uid,amount,balanceAfter,expiresAt};
}
async function revokeCreditTopup(env,db,object,reason){
 let paymentIntent=clean(stripeId(object?.payment_intent));
 if(!paymentIntent&&reason==='disputed'&&stripeId(object?.charge)){
  const charge=await stripe(env,`charges/${encodeURIComponent(stripeId(object.charge))}`);
  paymentIntent=clean(stripeId(charge.payment_intent));object={...charge,amount:Number(object?.amount||charge.amount||0)};
 }
 if(!paymentIntent)return null;
 const topup=await db.prepare(`SELECT request_id,discord_user_id,customer_id,checkout_session_id,amount,refunded_amount,status
  FROM supporter_credit_topups WHERE payment_intent_id=?`).bind(paymentIntent).first();
 if(!topup)return null;
 const target=Math.min(Number(topup.amount)||0,reason==='disputed'?Number(object?.amount||topup.amount):Number(object?.amount_refunded||0));
 const previous=Number(topup.refunded_amount||0),delta=Math.max(0,target-previous);
 if(!delta)return null;
 const now=Math.floor(Date.now()/1000),lot=await db.prepare(`SELECT id,remaining_amount,status FROM supporter_credit_lots
  WHERE source_type='purchase' AND source_id=?`).bind(topup.checkout_session_id).first();
 const remaining=lot?.status==='active'?Math.max(0,Number(lot.remaining_amount)||0):0;
 const lotReduction=Math.min(delta,remaining),available=await customerCredits(env,topup.customer_id),remove=Math.min(lotReduction,available);
 let transactionId=`${reason}:${object?.id||paymentIntent}:${target}`,balanceAfter=available;
 if(remove>0){
  const transaction=await stripe(env,`customers/${encodeURIComponent(topup.customer_id)}/balance_transactions`,{
   amount:String(remove),currency:'jpy',description:`DPI-Bot credit ${reason}: ${topup.checkout_session_id}`,
   'metadata[dpi_user]':topup.discord_user_id,'metadata[dpi_credit_action]':reason,'metadata[dpi_payment_intent]':paymentIntent,
  },await idempotencyKey('dpi-credit-reversal-',`${object?.id||paymentIntent}:${reason}:${target}`));
  transactionId=transaction.id;balanceAfter=creditsFromBalance(transaction.ending_balance);
 }
 const nextRemaining=Math.max(0,remaining-lotReduction),topupStatus=target>=Number(topup.amount)?reason:'credited';
 const statements=[
  db.prepare(`UPDATE supporter_credit_topups SET refunded_amount=?,status=?,updated_at=?
   WHERE request_id=? AND refunded_amount=?`).bind(target,topupStatus,now,topup.request_id,previous),
  db.prepare(`INSERT INTO supporter_credit_events
   (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
   VALUES(?,?,?,?,?,?, 'system',?) ON CONFLICT DO NOTHING`).bind(`${reason}:${object?.id||paymentIntent}:${target}`,topup.discord_user_id,-remove,balanceAfter,transactionId,`credit_${reason}`,new Date(now*1000).toISOString()),
 ];
 if(lot?.id)statements.push(db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=?,status=?,updated_at=?
  WHERE id=? AND remaining_amount=?`).bind(nextRemaining,nextRemaining?'active':'revoked',now,lot.id,remaining));
 await db.batch(statements);
 return {uid:topup.discord_user_id,removed:remove,status:topupStatus};
}
function stripeInvoiceUrl(value){
 try{const url=new URL(String(value||''));return url.protocol==='https:'&&['invoice.stripe.com','pay.stripe.com'].includes(url.hostname)?url.href:null;}catch{return null;}
}
export async function customerInvoices(env,customer){
 if(!customer||!billingReady(env))return [];
 const result=await stripe(env,`invoices?customer=${encodeURIComponent(customer)}&limit=12`);
 return (result.data||[]).map(invoice=>({
  number:String(invoice.number||''),status:String(invoice.status||'unknown'),created:unix(invoice.created),
  periodStart:unix(invoice.period_start),periodEnd:unix(invoice.period_end),currency:String(invoice.currency||'jpy').toLowerCase(),
  amountDue:Number(invoice.amount_due||0),amountPaid:Number(invoice.amount_paid||0),total:Number(invoice.total||0),
  hostedInvoiceUrl:stripeInvoiceUrl(invoice.hosted_invoice_url),invoicePdf:stripeInvoiceUrl(invoice.invoice_pdf),
 })).filter(invoice=>invoice.number||invoice.hostedInvoiceUrl||invoice.invoicePdf);
}
async function dunningState(db,customer){
 if(!customer)return {usageSuspended:false,status:null,retryAt:null,suspendAt:null};
 const row=await db.prepare(`SELECT status,retry_at,suspend_at FROM supporter_dunning
  WHERE customer_id=? AND status IN ('retry_scheduled','retrying','suspend_scheduled','suspended')
  ORDER BY initial_failed_at DESC LIMIT 1`).bind(customer).first();
 return {usageSuspended:row?.status==='suspended',status:row?.status||null,retryAt:unix(row?.retry_at),suspendAt:unix(row?.suspend_at)};
}
function billingMailContent(kind,invoice,retryAt,suspendAt){
 const amount=new Intl.NumberFormat('ja-JP',{style:'currency',currency:clean(invoice.currency||'jpy').toUpperCase(),maximumFractionDigits:0}).format(Number(invoice.amount_paid||invoice.amount_due||invoice.total||0));
 const date=value=>value?new Intl.DateTimeFormat('ja-JP',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(Number(value)*1000)):'—';
 const number=clean(invoice.number)||clean(invoice.id);const url=safeInvoiceUrl(invoice.hosted_invoice_url);
 const definitions={
  payment_succeeded:['【DPI-Bot】お支払い完了のお知らせ',[`DPI-Bot有料プランのお支払いが完了しました。`,`請求額: ${amount}`,`請求書: ${number}`]],
  retry_succeeded:['【DPI-Bot】再決済完了のお知らせ',[`月末の再決済が完了しました。引き続き有料プランをご利用いただけます。`,`請求額: ${amount}`,`請求書: ${number}`]],
  payment_failed:['【DPI-Bot】お支払い失敗と月末再決済のお知らせ',[`26日のお支払いを完了できませんでした。`,`月末再決済日時: ${date(retryAt)}`,`請求額: ${amount}`,`請求書: ${number}`,'月末までに契約管理画面から支払方法をご確認ください。']],
  final_failed:['【DPI-Bot】月末再決済失敗・利用停止のお知らせ',[`月末の再決済を完了できませんでした。`,`利用停止日時: ${date(suspendAt)}`,`請求額: ${amount}`,`請求書: ${number}`,'翌月以降、有料プランの通知設定は支払い完了まで利用停止となります。']],
 };
 const [subject,lines]=definitions[kind];if(url)lines.push(`請求書・支払方法の確認: ${url}`);
 lines.push('','----------------------------------------','DPI-Bot 運営','公式サイト: https://dpi-bot.com/','公式サポートサーバー: https://discord.gg/qFuZcGUb4K');
 return {subject,text:lines.join('\n')};
}
export async function sendBillingNotification(env,db,kind,invoice,retryAt=null,suspendAt=null){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id;if(!customer)return;
 const account=await db.prepare(`SELECT a.billing_email FROM supporter_accounts a JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id WHERE b.customer_id=?`).bind(customer).first();
 if(!account?.billing_email)return;
 const now=Math.floor(Date.now()/1000),invoiceId=clean(invoice.id);if(!invoiceId)return;
 await db.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,updated_at) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING`).bind(invoiceId,kind,now).run();
 const notice=await db.prepare('SELECT status FROM supporter_billing_notifications WHERE invoice_id=? AND kind=?').bind(invoiceId,kind).first();if(notice?.status==='sent')return;
 const claim=await db.prepare(`UPDATE supporter_billing_notifications SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=?
  WHERE invoice_id=? AND kind=? AND (status IN ('pending','failed') OR (status='sending' AND updated_at<=?))`).bind(now,invoiceId,kind,now-300).run();
 if(!claim.meta?.changes)return;
 const content=billingMailContent(kind,invoice,retryAt,suspendAt);
 try{
  await env.NOTICE_EMAIL.send({to:account.billing_email,from:{email:clean(env.NOTICE_FROM_EMAIL),name:'DPI-Bot'},subject:content.subject,text:content.text,...(clean(env.NOTICE_REPLY_TO_EMAIL)?{replyTo:clean(env.NOTICE_REPLY_TO_EMAIL)}:{}),headers:{'Auto-Submitted':'auto-generated','Content-Language':'ja','X-DPI-Mail-Type':`supporter-${kind}`}});
  await db.prepare(`UPDATE supporter_billing_notifications SET status='sent',sent_at=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(now,now,invoiceId,kind).run();
 }catch(error){await db.prepare(`UPDATE supporter_billing_notifications SET status='failed',last_error=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(clean(error?.code||error?.name||'unknown').slice(0,80),now,invoiceId,kind).run();throw error;}
}
async function recordInvoicePaid(env,db,invoice){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id,invoiceId=clean(invoice.id);if(!customer||!invoiceId||!invoiceSubscriptionId(invoice))return;
 const previous=await db.prepare('SELECT status,retry_at,suspend_at FROM supporter_dunning WHERE invoice_id=?').bind(invoiceId).first();const now=Math.floor(Date.now()/1000);
 await db.prepare(`UPDATE supporter_dunning SET status='paid',paid_at=?,suspended_at=NULL,updated_at=? WHERE invoice_id=?`).bind(now,now,invoiceId).run();
 await sendBillingNotification(env,db,previous?'retry_succeeded':'payment_succeeded',invoice,previous?.retry_at,previous?.suspend_at);
}
async function recordInvoiceFailed(env,db,invoice){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id,invoiceId=clean(invoice.id),subscriptionId=invoiceSubscriptionId(invoice);
 if(!customer||!invoiceId||!subscriptionId||invoice.billing_reason!=='subscription_cycle')return;
 const now=Math.floor(Date.now()/1000),schedule=dunningSchedule(Number(invoice.created)||now);
 await stripe(env,`invoices/${encodeURIComponent(invoiceId)}`,{auto_advance:'false'},`dpi-disable-auto-retry-${invoiceId}`);
 const existing=await db.prepare('SELECT status,retry_attempted_at FROM supporter_dunning WHERE invoice_id=?').bind(invoiceId).first();
 if(existing?.retry_attempted_at||Number(invoice.attempt_count)>1){
  await db.prepare(`UPDATE supporter_dunning SET status='suspend_scheduled',retry_attempted_at=COALESCE(retry_attempted_at,?),updated_at=? WHERE invoice_id=?`).bind(now,now,invoiceId).run();
  return sendBillingNotification(env,db,'final_failed',invoice,schedule.retryAt,schedule.suspendAt);
 }
 await db.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at)
  VALUES(?,?,?,?,?,'retry_scheduled',?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET amount_due=excluded.amount_due,currency=excluded.currency,retry_at=excluded.retry_at,suspend_at=excluded.suspend_at,updated_at=excluded.updated_at`).bind(invoiceId,customer,subscriptionId,Number(invoice.amount_due||invoice.total||0),clean(invoice.currency||'jpy'),now,schedule.retryAt,schedule.suspendAt,now).run();
 return sendBillingNotification(env,db,'payment_failed',invoice,schedule.retryAt,schedule.suspendAt);
}
export async function creditsByCustomer(env,customers){
 const wanted=new Set((customers||[]).filter(Boolean));
 const resultMap=new Map([...wanted].map(customer=>[customer,0]));
 if(!wanted.size||!billingReady(env))return resultMap;
 let startingAfter='';
 for(let page=0;page<5;page++){
  const suffix=startingAfter?`&starting_after=${encodeURIComponent(startingAfter)}`:'';
  const result=await stripe(env,`customers?limit=100${suffix}`);
  for(const customer of result.data||[])if(wanted.has(customer.id))resultMap.set(customer.id,creditsFromBalance(customer.balance));
  if(!result.has_more||!result.data?.length)break;
  startingAfter=result.data.at(-1).id;
 }
 return resultMap;
}
export function selection(input){
 const channelPacks=input.channelPacks??input.packs??0;
 const serverPacks=input.serverPacks??0;
 const definition=PLAN_CATALOG[input.plan];
 if(!definition||!Number.isInteger(channelPacks)||channelPacks<0||channelPacks>5||!Number.isInteger(serverPacks)||serverPacks<0||serverPacks>5)fail('プランまたは追加オプション数が不正です。');
 return {plan:input.plan,packs:channelPacks,channelPacks,serverPacks,baseMonthly:definition.yen,monthly:definition.yen+200*(channelPacks+serverPacks),channels:definition.channels+3*channelPacks,servers:definition.servers+serverPacks,rules:definition.rules,complexConditions:definition.complexConditions,multiDestination:definition.multiDestination};
}
export function billingSchedule(now=Date.now()){
 const jst=new Date(Number(now)+9*60*60*1000);
 const day=jst.getUTCDate();
 let year=jst.getUTCFullYear(),month=jst.getUTCMonth();
 if(day>=26){month+=1;if(month>11){month=0;year+=1;}}
 const anchor=Math.floor((Date.UTC(year,month,26,0,0,0)-9*60*60*1000)/1000);
 return {billingDay:26,anchor,initialMonths:day>=26?2:1,lateMonth:day>=26};
}
export function staleCheckoutAttempt(row,now=Math.floor(Date.now()/1000)){
 if(!row?.checkout_key)return false;
 try{
  const saved=JSON.parse(row.checkout_params||'');
  const expiresAt=Number(saved?.expires_at);
  const incompatibleAnchor=saved?.['subscription_data[proration_behavior]']==='none'&&!!saved?.['subscription_data[billing_cycle_anchor]'];
  const legacySubscriptionCheckout=saved?.mode==='subscription'||!!saved?.['subscription_data[trial_end]'];
  if(incompatibleAnchor||legacySubscriptionCheckout)return true;
  return !row.checkout_id&&(!Number.isFinite(expiresAt)||expiresAt<=now);
 }catch{return true;}
}
async function recoverStaleCheckoutAttempt(db,uid,row){
 if(!staleCheckoutAttempt(row))return row;
 await db.prepare(`UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL
  WHERE discord_user_id=? AND checkout_key=?`).bind(uid,row.checkout_key).run();
 return await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
}
async function subscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data.filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
function checkoutMetadata(session){return session?.metadata&&typeof session.metadata==='object'?session.metadata:{};}
export function paidCheckoutSubscriptionParams(env,session,paymentIntent,now=Math.floor(Date.now()/1000)){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='initial_subscription'||session.payment_status!=='paid')return null;
 const customer=typeof session.customer==='string'?session.customer:session.customer?.id;
 const paymentMethod=typeof paymentIntent?.payment_method==='string'?paymentIntent.payment_method:paymentIntent?.payment_method?.id;
 if(!customer||!paymentMethod)fail('初回決済の支払方法を確認できませんでした。',502);
 const choice=selection({plan:metadata.dpi_plan,channelPacks:Number(metadata.dpi_channel_packs),serverPacks:Number(metadata.dpi_server_packs)});
 let anchor=Number(metadata.dpi_billing_anchor);
 if(!Number.isInteger(anchor)||anchor<=now+60)anchor=billingSchedule(now*1000).anchor;
 const params={customer,default_payment_method:paymentMethod,collection_method:'charge_automatically',billing_cycle_anchor:String(anchor),proration_behavior:'none','billing_mode[type]':'flexible',
  'items[0][price]':planPrice(env,choice.plan),'items[0][quantity]':'1',
  'metadata[dpi_user]':String(metadata.dpi_user||session.client_reference_id||''),'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':String(metadata.dpi_legal_consent_version||''),
  'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks)};
 const optionPacks=choice.channelPacks+choice.serverPacks;
 if(optionPacks){params['items[1][price]']=env.STRIPE_PRICE_ADDON;params['items[1][quantity]']=String(optionPacks);}
 return params;
}
export async function provisionPaidCheckoutSubscription(env,session){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='initial_subscription'||session.payment_status!=='paid')return null;
 const customer=typeof session.customer==='string'?session.customer:session.customer?.id;
 if(!customer)fail('初回決済の顧客情報を確認できませんでした。',502);
 const existing=await subscriptions(env,customer);
 if(existing.length)return existing[0];
 const paymentIntentId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
 if(!paymentIntentId)fail('初回決済情報を確認できませんでした。',502);
 const paymentIntent=await stripe(env,`payment_intents/${encodeURIComponent(paymentIntentId)}`);
 const params=paidCheckoutSubscriptionParams(env,session,paymentIntent);
 return await stripe(env,'subscriptions',params,`dpi-initial-subscription-v2-${session.id}`);
}
function recoverablePaidCheckout(session,customer,uid){
 const metadata=checkoutMetadata(session);
 const sessionCustomer=typeof session?.customer==='string'?session.customer:session?.customer?.id;
 return session?.mode==='payment'&&session?.status==='complete'&&session?.payment_status==='paid'&&metadata.dpi_checkout_kind==='initial_subscription'&&sessionCustomer===customer&&String(metadata.dpi_user||session.client_reference_id||'')===String(uid);
}
export async function reconcilePaidCheckoutSubscription(env,customer,uid){
 if(!customer||!uid||!billingReady(env))return {subscription:null,recovered:false,checkoutId:null};
 const existing=await subscriptions(env,customer);
 if(existing.length)return {subscription:existing[0],recovered:false,checkoutId:null};
 const result=await stripe(env,`checkout/sessions?customer=${encodeURIComponent(customer)}&limit=20`);
 const session=(result.data||[]).filter(item=>recoverablePaidCheckout(item,customer,uid)).sort((a,b)=>Number(b.created||0)-Number(a.created||0))[0];
 if(!session)return {subscription:null,recovered:false,checkoutId:null};
 const subscription=await provisionPaidCheckoutSubscription(env,session);
 return {subscription,recovered:!!subscription,checkoutId:session.id};
}
const unix = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function optionPackSummary(metadata={},addonQuantity=0){
 const combined=Number(addonQuantity);
 const channelRaw=clean(metadata.dpi_channel_packs),serverRaw=clean(metadata.dpi_server_packs);
 const channelPacks=channelRaw===''?(serverRaw===''?combined:0):Number(channelRaw);
 const serverPacks=serverRaw===''?0:Number(serverRaw);
 const valid=Number.isInteger(combined)&&combined>=0&&Number.isInteger(channelPacks)&&channelPacks>=0&&channelPacks<=5&&Number.isInteger(serverPacks)&&serverPacks>=0&&serverPacks<=5&&channelPacks+serverPacks===combined;
 return {valid,channelPacks:valid?channelPacks:0,serverPacks:valid?serverPacks:0};
}
export function subscriptionSummary(subscription,env={}){
 const labels=new Map([
  [env.STRIPE_PRICE_SUPPORTER,'BASIC'],
  [env.STRIPE_PRICE_PLUS,'Plus'],
  [env.STRIPE_PRICE_PRO,'Pro'],
  [env.STRIPE_PRICE_ADDON,'追加オプション'],
 ].filter(([id])=>id));
 const items=(subscription.items?.data||[]).map(item=>{
  const quantity=Number.isFinite(Number(item.quantity))&&Number(item.quantity)>0?Number(item.quantity):1;
  const unitAmount=Number.isFinite(Number(item.price?.unit_amount))?Number(item.price.unit_amount):0;
  return {price:item.price?.id||'',label:labels.get(item.price?.id)||item.price?.nickname||'契約項目',quantity,unitAmount,subtotal:unitAmount*quantity,currency:(item.price?.currency||'jpy').toLowerCase(),periodStart:unix(item.current_period_start),periodEnd:unix(item.current_period_end)};
 });
 const currentPeriodStart=items.map(item=>item.periodStart).filter(Boolean).sort((a,b)=>a-b)[0]||unix(subscription.current_period_start);
 const nextRenewalAt=items.map(item=>item.periodEnd).filter(Boolean).sort((a,b)=>b-a)[0]||unix(subscription.current_period_end);
 const currency=items.find(item=>item.currency)?.currency||'jpy';
 const basePrice=items.find(item=>item.price!==env.STRIPE_PRICE_ADDON)?.price;
 const addonQuantity=items.find(item=>item.price===env.STRIPE_PRICE_ADDON)?.quantity||0;
 const metadata=subscription.metadata||{};
 const options=optionPackSummary(metadata,addonQuantity);
 const {channelPacks,serverPacks}=options;
 const planId=basePrice===env.STRIPE_PRICE_PRO?'pro':basePrice===env.STRIPE_PRICE_PLUS?'plus':basePrice===env.STRIPE_PRICE_SUPPORTER?'supporter':'';
 const recognizedPlan=!!planId&&options.valid;
 const choice=recognizedPlan?selection({plan:planId,channelPacks,serverPacks}):{channels:0,servers:0,rules:0,complexConditions:false,multiDestination:false};
 return {status:subscription.status||'unknown',cancelAtPeriodEnd:subscription.cancel_at_period_end===true,startedAt:unix(subscription.start_date)||unix(subscription.created),currentPeriodStart,nextRenewalAt,amount:items.reduce((sum,item)=>sum+item.subtotal,0),currency,plan:planId?PLAN_CATALOG[planId].name:'確認が必要な契約',planId,recognizedPlan,configurationValid:options.valid,channelPacks,serverPacks,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination,items,scheduledChange:null};
}
export function reconcileRulesForLimits(settingsJson,limits={}){
 let settings;
 try{settings=JSON.parse(settingsJson||'{}');}catch{return{changed:false,invalidSettings:true,rules:[],removedRules:0,removedDestinations:0,simplifiedRules:0,settingsJson};}
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||!Array.isArray(settings.rules))return{changed:false,invalidSettings:true,rules:[],removedRules:0,removedDestinations:0,simplifiedRules:0,settingsJson};
 const ruleLimit=Math.max(0,Number(limits.rules)||0),serverLimit=Math.max(0,Number(limits.servers)||0),channelLimit=Math.max(0,Number(limits.channels)||0);
 const kept=[],guilds=new Set(),channels=new Set();let removedRules=0,removedDestinations=0,simplifiedRules=0;
 for(const source of settings.rules){
  if(kept.length>=ruleLimit){removedRules+=1;continue;}
  const rule=source&&typeof source==='object'&&!Array.isArray(source)?{...source}:source;
  if(!rule||typeof rule!=='object'){removedRules+=1;continue;}
  const guildId=clean(rule.guildId);
  if(!guilds.has(guildId)&&guilds.size>=serverLimit){removedRules+=1;continue;}
  const requested=[...new Set((Array.isArray(rule.channelIds)&&rule.channelIds.length?rule.channelIds:[rule.channelId]).map(clean).filter(Boolean))];
  const destinationLimit=limits.multiDestination===true?requested.length:Math.min(1,requested.length);
  const destinations=[];
  for(const channelId of requested){
   if(destinations.length>=destinationLimit){removedDestinations+=1;continue;}
   const key=`${guildId}:${channelId}`;
   if(!channels.has(key)&&channels.size>=channelLimit){removedDestinations+=1;continue;}
   destinations.push(channelId);channels.add(key);
  }
  if(!destinations.length){removedRules+=1;continue;}
  let simplified=false;
  if(limits.complexConditions!==true&&((rule.conditionLogic&&rule.conditionLogic!=='and')||(Array.isArray(rule.conditions)&&rule.conditions.length))){rule.conditionLogic='and';rule.conditions=[];simplified=true;}
  if(!Array.isArray(rule.channelIds)||rule.channelIds.length!==destinations.length||rule.channelIds.some((value,index)=>clean(value)!==destinations[index]))simplified=true;
  rule.channelId=destinations[0];rule.channelIds=destinations;
  if(simplified)simplifiedRules+=1;
  guilds.add(guildId);kept.push(rule);
 }
 const changed=removedRules>0||removedDestinations>0||simplifiedRules>0;
 if(!changed)return{changed:false,invalidSettings:false,rules:settings.rules,removedRules:0,removedDestinations:0,simplifiedRules:0,settingsJson};
 return{changed:true,invalidSettings:false,rules:kept,removedRules,removedDestinations,simplifiedRules,settingsJson:JSON.stringify({...settings,rules:kept})};
}
function combinedLimits(summaries){
 return summaries.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||0),channels:Math.max(limits.channels,Number(item.channels)||0),rules:Math.max(limits.rules,Number(item.rules)||0),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),{servers:0,channels:0,rules:0,complexConditions:false,multiDestination:false});
}
export async function reconcileStoredRulesForCustomer(db,customer,limits){
 const customerId=typeof customer==='string'?customer:customer?.id;
 const validLimits=limits&&[limits.rules,limits.servers,limits.channels].every(value=>Number.isInteger(Number(value))&&Number(value)>=1);
 if(!customerId||!validLimits)return{changed:false,invalidLimits:true,removedRules:0,removedDestinations:0,simplifiedRules:0};
 for(let attempt=0;attempt<2;attempt+=1){
  const row=await db.prepare(`SELECT a.discord_user_id,a.settings_json,a.revision FROM supporter_accounts a JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id WHERE b.customer_id=?`).bind(customerId).first();
  if(!row)return{changed:false,removedRules:0,removedDestinations:0,simplifiedRules:0};
  const adjustment=reconcileRulesForLimits(row.settings_json,limits);
  if(!adjustment.changed)return{...adjustment,revision:Number(row.revision)||0};
  const result=await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(adjustment.settingsJson,new Date().toISOString(),row.discord_user_id,row.revision).run();
  if(result.meta?.changes)return{...adjustment,revision:(Number(row.revision)||0)+1};
 }
 return{changed:false,conflict:true,removedRules:0,removedDestinations:0,simplifiedRules:0};
}
function scheduleId(subscription){return typeof subscription.schedule==='string'?subscription.schedule:subscription.schedule?.id;}
export function scheduledChangeSummary(schedule,env,currentSummary){
 const phase=(schedule?.phases||[]).filter(item=>Number(item.start_date)>=Number(currentSummary.nextRenewalAt||0)).sort((a,b)=>Number(a.start_date)-Number(b.start_date))[0];
 if(!phase)return null;
 const items=phase.items||[];
 const base=items.find(item=>(item.price?.id||item.price)!==env.STRIPE_PRICE_ADDON);
 const basePrice=base?.price?.id||base?.price;
 const planId=basePrice===env.STRIPE_PRICE_PRO?'pro':basePrice===env.STRIPE_PRICE_PLUS?'plus':basePrice===env.STRIPE_PRICE_SUPPORTER?'supporter':'';
 if(!planId)return null;
 const addon=items.find(item=>(item.price?.id||item.price)===env.STRIPE_PRICE_ADDON);
 const metadata=phase.metadata||{};
 const combined=Number(addon?.quantity||0);
 const options=optionPackSummary(metadata,combined);
 if(!options.valid)return null;
 const {channelPacks,serverPacks}=options;
 const choice=selection({plan:planId,channelPacks,serverPacks});
 if(choice.plan===currentSummary.planId&&choice.channelPacks===currentSummary.channelPacks&&choice.serverPacks===currentSummary.serverPacks)return null;
 return {effectiveAt:unix(phase.start_date),plan:PLAN_CATALOG[planId].name,planId,monthly:choice.monthly,channels:choice.channels,servers:choice.servers,rules:choice.rules,channelPacks,serverPacks};
}
async function summaryWithSchedule(env,subscription){
 const summary=subscriptionSummary(subscription,env);
 const id=scheduleId(subscription);
 if(id){const schedule=await stripe(env,`subscription_schedules/${encodeURIComponent(id)}`);summary.scheduledChange=scheduledChangeSummary(schedule,env,summary);}
 return summary;
}
export async function customerSubscriptionSummaries(env,customer){
 if(!customer||!billingReady(env))return [];
 return await Promise.all((await subscriptions(env,customer)).map(subscription=>summaryWithSchedule(env,subscription)));
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
 if(!billingReady(env))return json({message:'決済設定が完了していません。'},503);
 const account=await db.prepare('SELECT discord_user_id,billing_email FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 if(!account)return json({message:'先に登録してください。'},409);
 await db.prepare('INSERT INTO supporter_billing(discord_user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(uid).run();
 let row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(action==='status'){
  const recovery=await reconcilePaidCheckoutSubscription(env,row.customer_id,uid);
  if(recovery.recovered&&recovery.checkoutId)await db.prepare('UPDATE supporter_billing SET checkout_id=?,dirty=1 WHERE discord_user_id=?').bind(recovery.checkoutId,uid).run();
  const [summaries,invoices,credits,dunning]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerInvoices(env,row.customer_id),customerCredits(env,row.customer_id),dunningState(db,row.customer_id)]);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
  const active=summaries.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
  const rulesAdjustment=active.length?await reconcileStoredRulesForCustomer(db,row.customer_id,combinedLimits(active)):{changed:false,removedRules:0,removedDestinations:0,simplifiedRules:0};
  return json({mode:'test',billingDay:26,subscriptions:summaries,invoices,credits,creditDetails,dunning,rulesAdjustment,recoveredSubscription:recovery.recovered,deliveryEnabled:false});
 }
 if(!row.customer_id){const customer=await createBillingCustomer(env,uid,account.billing_email,`dpi-customer-${uid}`);await db.prepare('UPDATE supporter_billing SET customer_id=? WHERE discord_user_id=? AND customer_id IS NULL').bind(customer.id,uid).run();row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();}
 else if(account.billing_email)await stripe(env,`customers/${encodeURIComponent(row.customer_id)}`,{email:account.billing_email},await idempotencyKey(`dpi-customer-email-${uid}-`,account.billing_email));
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin || !/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 if(action==='portal'){const portal=await stripe(env,'billing_portal/sessions',{customer:row.customer_id,configuration:env.STRIPE_PORTAL_CONFIG,return_url:`${origin}/site/supporter/`});return json({url:portal.url});}
 if(action==='topup'){
  const amount=normalizeCreditTopupAmount(input.amount);
  const requestId=clean(input.requestId),legalConsentVersion=clean(input.legalConsentVersion);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))return json({message:'チャージ情報が正しくありません。再読み込みしてください。'},400);
  if(!legalConsentVersion)return json({message:'クレジット購入条件への同意を確認できません。'},400);
  const now=Math.floor(Date.now()/1000);
  const previous=await db.prepare('SELECT * FROM supporter_credit_topups WHERE request_id=?').bind(requestId).first();
  if(previous&&(previous.discord_user_id!==uid||previous.customer_id!==row.customer_id||Number(previous.amount)!==amount))return json({message:'別の条件でチャージリンクを作成済みです。'},409);
  await db.prepare(`INSERT INTO supporter_credit_topups
   (request_id,discord_user_id,customer_id,amount,currency,status,created_at,updated_at)
   VALUES(?,?,?,?,'jpy','pending',?,?) ON CONFLICT(request_id) DO NOTHING`).bind(requestId,uid,row.customer_id,amount,now,now).run();
  const existing=await db.prepare('SELECT checkout_session_id,status FROM supporter_credit_topups WHERE request_id=?').bind(requestId).first();
  let checkout=existing?.checkout_session_id?await stripe(env,`checkout/sessions/${encodeURIComponent(existing.checkout_session_id)}`):null;
  if(!checkout){
   checkout=await stripe(env,'checkout/sessions',{
    mode:'payment',customer:row.customer_id,client_reference_id:uid,
    'line_items[0][price_data][currency]':'jpy',
    'line_items[0][price_data][unit_amount]':String(amount),
    'line_items[0][price_data][product_data][name]':`DPI-Bot クレジット ${amount.toLocaleString('ja-JP')}ポイント`,
    'line_items[0][quantity]':'1',
    'metadata[dpi_checkout_kind]':'credit_topup','metadata[dpi_user]':uid,
    'metadata[dpi_credit_amount]':String(amount),'metadata[dpi_topup_request_id]':requestId,
    'metadata[dpi_legal_consent_version]':legalConsentVersion,
    'payment_intent_data[metadata][dpi_checkout_kind]':'credit_topup',
    'payment_intent_data[metadata][dpi_user]':uid,
    'payment_intent_data[metadata][dpi_topup_request_id]':requestId,
    success_url:`${origin}/site/supporter/?credit=completed`,
    cancel_url:`${origin}/site/supporter/?credit=canceled`,
    expires_at:String(now+86400),integration_identifier:integrationIdentifier('dpi_credit_'),
   },`dpi-credit-checkout-${requestId}`);
   await db.prepare('UPDATE supporter_credit_topups SET checkout_session_id=?,updated_at=? WHERE request_id=? AND discord_user_id=?').bind(checkout.id,now,requestId,uid).run();
  }
  if(checkout.status==='expired')return json({message:'チャージ用支払いリンクの有効期限が切れました。もう一度作成してください。'},409);
  if(checkout.status!=='open')return json({message:'チャージ決済の反映を確認中です。残高を再読み込みしてください。'},409);
  return json({url:checkout.url,amount,credits:amount,expiresAt:checkout.expires_at||now+86400,mode:'test'});
 }
 const choice=selection(input);
 const recovery=await reconcilePaidCheckoutSubscription(env,row.customer_id,uid);
 const existing=await subscriptions(env,row.customer_id);
 if(action==='preview-update'){
  const current=activeSubscription(existing);
  if(!current)return json({message:'更新できる契約がありません。先にプランを申し込んでください。'},409);
  return json(await previewSubscriptionUpdate(env,row.customer_id,current,choice));
 }
 if(action==='update'){
  const requestId=String(input.requestId||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))return json({message:'更新情報が正しくありません。再読み込みしてください。'},400);
  const prorationDate=Number(input.prorationDate);
  const now=Math.floor(Date.now()/1000);
  if(!Number.isInteger(prorationDate)||prorationDate>now+30||prorationDate<now-600)return json({message:'料金プレビューの有効期限が切れました。もう一度確認してください。'},409);
  const current=activeSubscription(existing);
  if(!current)return json({message:'更新できる契約がありません。先にプランを申し込んでください。'},409);
  const preview=await previewSubscriptionUpdate(env,row.customer_id,current,choice,prorationDate);
  const expectedCreditApplied=Number(input.expectedCreditApplied||0);
  if(!Number.isInteger(expectedCreditApplied)||expectedCreditApplied!==preview.creditApplied)return json({message:'利用可能クレジットが変更されました。料金をもう一度確認してください。'},409);
  if(preview.creditApplied>0&&input.useCredits!==true)return json({message:'クレジット利用と差額支払いへの確認が必要です。料金をもう一度確認してください。'},409);
  let updateResult=null;
  if(preview.changeTiming==='next_period')await scheduleSubscriptionChange(env,current,choice,`dpi-user-update-${uid}-${requestId}`,{'dpi_updated_by':'user'});
  else updateResult=await updateSubscription(env,current,choice,`dpi-user-update-${uid}-${requestId}`,{'metadata[dpi_updated_by]':'user'},prorationDate);
  const baseMessage=preview.changeTiming==='next_period'?'ダウングレードを予約しました。返金は行わず、次回26日から新しい内容を適用します。':updateResult?.paymentPending?`基本プランの変更は支払い確認待ちです。契約管理から支払い方法をご確認ください。${updateResult.optionsDeferred?'追加オプションは支払い完了後に改めて変更してください。':''}`:'プランと追加オプションを更新しました。基本プランの差額だけを日割りし、追加オプションは次回26日から反映します。';
  const creditMessage=preview.nextInvoiceCreditApplied>0?' 次回分のクレジットは26日の請求書確定時に消費されます。':'';
  const scheduleMessage=updateResult?.releasedSchedule?' 以前予約したダウングレードは取り消しました。':'';
  return json({message:`${baseMessage}${scheduleMessage}${creditMessage}`,paymentPending:updateResult?.paymentPending===true,optionsDeferred:updateResult?.optionsDeferred===true,releasedScheduledChange:updateResult?.releasedSchedule===true,billingDay:26,subscriptions:await customerSubscriptionSummaries(env,row.customer_id),credits:await customerCredits(env,row.customer_id),creditApplication:{immediate:preview.immediateCreditApplied,nextInvoice:preview.nextInvoiceCreditApplied,nextInvoiceDue:preview.nextInvoiceDue},deliveryEnabled:false});
 }
 if(action!=='checkout')return json({message:'Not found'},404);
 if(existing.length||recovery.subscription)return json({message:'契約が存在します。「プラン・オプションを更新」をご利用ください。'},409);
 const schedule=billingSchedule();
 const legalConsentVersion=String(input.legalConsentVersion||'');
 if(!legalConsentVersion)return json({message:'申込み同意を確認できません。画面を再読み込みしてください。'},400);
 row=await recoverStaleCheckoutAttempt(db,uid,row);
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'payment',customer:row.customer_id,client_reference_id:uid,
  'payment_intent_data[setup_future_usage]':'off_session','payment_intent_data[metadata][dpi_user]':uid,
  'metadata[dpi_checkout_kind]':'initial_subscription','metadata[dpi_user]':uid,'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':legalConsentVersion,'metadata[dpi_channel_packs]':String(choice.channelPacks),
  'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_billing_anchor]':String(schedule.anchor),
  success_url:`${origin}/site/supporter/?checkout=returned`,cancel_url:`${origin}/site/supporter/?checkout=canceled`,expires_at:String(Math.floor(Date.now()/1000)+3600),integration_identifier:integrationIdentifier('dpi_paid_')};
 const line=0;
 params[`line_items[${line}][price_data][currency]`]='jpy';
 params[`line_items[${line}][price_data][unit_amount]`]=String(choice.monthly*schedule.initialMonths);
 params[`line_items[${line}][price_data][product_data][name]`]=`${PLAN_CATALOG[choice.plan].name} ${schedule.lateMonth?'初回利用料（当月分・翌月分の2か月分）':'初回利用料（当月分）'}`;
 params[`line_items[${line}][quantity]`]='1';
 await db.prepare('UPDATE supporter_billing SET checkout_key=?,checkout_params=? WHERE discord_user_id=? AND checkout_key IS NULL').bind(crypto.randomUUID(),JSON.stringify(params),uid).run();
 row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const saved=JSON.parse(row.checkout_params);
 if(!row.checkout_id && Number(saved.expires_at)<Date.now()/1000)fail('決済作成の状態確認が必要です。管理者へお問い合わせください。',409);
 const checkout=row.checkout_id?await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`):await stripe(env,'checkout/sessions',saved,`dpi-checkout-${row.checkout_key}`);
 await db.prepare('UPDATE supporter_billing SET checkout_id=? WHERE discord_user_id=? AND checkout_key=?').bind(checkout.id,uid,row.checkout_key).run();
 if(checkout.status==='expired'){await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();return json({message:'前の決済画面が期限切れです。再度お試しください。'},409);}
 if(checkout.status!=='open')return json({message:'決済結果を確認中です。契約状態を更新してください。'},409);
 if(saved['metadata[dpi_plan]']!==params['metadata[dpi_plan]']||saved['metadata[dpi_channel_packs]']!==params['metadata[dpi_channel_packs]']||saved['metadata[dpi_server_packs]']!==params['metadata[dpi_server_packs]'])return json({message:'別の条件で決済画面を作成済みです。期限切れ後に変更できます（最大1時間）。'},409);
 return json({url:checkout.url,mode:'test'});
}
function adminChoice(input){
 const plan=String(input.plan||'');
 const channelPacks=Number(input.channelPacks??input.packs);
 const serverPacks=Number(input.serverPacks??0);
 return selection({plan,channelPacks,serverPacks});
}
function activeSubscription(list){
 return list.find(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status))||list[0];
}
export function prorationBreakdown(lines){
 const prorations=(lines||[]).filter(line=>line.parent?.subscription_item_details?.proration===true||line.proration===true);
 const newPlanCharge=prorations.reduce((sum,line)=>sum+Math.max(0,Number(line.amount)||0),0);
 const unusedPlanCredit=prorations.reduce((sum,line)=>sum+Math.max(0,-Number(line.amount||0)),0);
 return {unusedPlanCredit,newPlanCharge,net:newPlanCharge-unusedPlanCredit};
}
export function creditApplication(credits,immediateCharge,nextInvoiceSubtotal){
 const available=Math.max(0,Number(credits)||0);
 const immediateCreditApplied=Math.min(available,Math.max(0,Number(immediateCharge)||0));
 const afterImmediate=available-immediateCreditApplied;
 const nextInvoiceCreditApplied=Math.min(afterImmediate,Math.max(0,Number(nextInvoiceSubtotal)||0));
 return {
  available,
  immediateCreditApplied,
  nextInvoiceCreditApplied,
  totalCreditApplied:immediateCreditApplied+nextInvoiceCreditApplied,
  immediateDue:Math.max(0,(Number(immediateCharge)||0)-immediateCreditApplied),
  nextInvoiceDue:Math.max(0,(Number(nextInvoiceSubtotal)||0)-nextInvoiceCreditApplied),
  remainingAfterNext:afterImmediate-nextInvoiceCreditApplied,
 };
}
async function previewSubscriptionUpdate(env,customer,current,choice,requestedProrationDate){
 const currentSummary=subscriptionSummary(current,env);
 const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
 if(!base?.id)fail('契約項目を確認できませんでした。',409);
 const prorationDate=Number.isInteger(requestedProrationDate)?requestedProrationDate:Math.floor(Date.now()/1000);
 const planChanged=currentSummary.planId!==choice.plan;
 const changeTiming=choice.monthly<currentSummary.amount||choice.channels<currentSummary.channels||choice.servers<currentSummary.servers||choice.rules<currentSummary.rules?'next_period':'immediate';
 let planProrationBreakdown={unusedPlanCredit:0,newPlanCharge:0,net:0};
 if(planChanged&&changeTiming==='immediate'){
  const invoice=await stripe(env,'invoices/create_preview',{
   customer,subscription:current.id,
   'subscription_details[items][0][id]':base.id,
   'subscription_details[items][0][price]':planPrice(env,choice.plan),
   'subscription_details[items][0][quantity]':'1',
   'subscription_details[proration_behavior]':'always_invoice',
   'subscription_details[proration_date]':String(prorationDate),
  });
  planProrationBreakdown=prorationBreakdown(invoice.lines?.data);
 }
 const planProration=planProrationBreakdown.net;
 const credits=await customerCredits(env,customer);
 const creditUse=creditApplication(credits,changeTiming==='immediate'?planProration:0,choice.monthly);
 return {
  prorationDate,expiresAt:prorationDate+600,billingDay:26,
  current:{plan:currentSummary.plan,planId:currentSummary.planId,monthly:currentSummary.amount,channels:currentSummary.channels,servers:currentSummary.servers,rules:currentSummary.rules},
  next:{plan:PLAN_CATALOG[choice.plan].name,planId:choice.plan,monthly:choice.monthly,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination},
  monthlyDifference:choice.monthly-currentSummary.amount,
  planChanged,changeTiming,effectiveAt:changeTiming==='next_period'?currentSummary.nextRenewalAt:null,planProration,planProrationBreakdown,
  creditApplied:creditUse.totalCreditApplied,immediateCreditApplied:creditUse.immediateCreditApplied,nextInvoiceCreditApplied:creditUse.nextInvoiceCreditApplied,
  immediateDue:changeTiming==='next_period'?0:creditUse.immediateDue,nextInvoiceSubtotal:choice.monthly,nextInvoiceDue:creditUse.nextInvoiceDue,remainingCreditsAfterNext:creditUse.remainingAfterNext,
  creditGenerated:changeTiming==='next_period'?0:Math.max(0,-planProration),
  optionChange:{currentChannelPacks:currentSummary.channelPacks,nextChannelPacks:choice.channelPacks,currentServerPacks:currentSummary.serverPacks,nextServerPacks:choice.serverPacks,prorated:false,effectiveAt:currentSummary.nextRenewalAt},
  nextRenewalAt:currentSummary.nextRenewalAt,
  notice:changeTiming==='next_period'?'ダウングレードでは返金・日割り精算を行いません。現在の契約内容は今期末まで利用でき、新しいプランと利用枠は次回26日から適用します。クレジットは次回26日の請求書に自動適用されます。':'アップグレード時は基本プランの未使用分を返金相当額として新プランの残期間分へ充当し、差額を精算します。追加オプションは日割り請求を行わず、次回26日の請求から月額へ反映し、利用可能なクレジットを自動適用します。',
 };
}
function phaseItems(params,index,items){
 let at=0;
 for(const item of items){
  const price=item.price?.id||item.price;
  if(!price)continue;
  params[`phases[${index}][items][${at}][price]`]=price;
  params[`phases[${index}][items][${at}][quantity]`]=String(Math.max(1,Number(item.quantity)||1));
  at+=1;
 }
}
async function scheduleSubscriptionChange(env,current,choice,key,extraMetadata={}){
 const currentSummary=subscriptionSummary(current,env);
 if(!currentSummary.nextRenewalAt)fail('次回更新日を確認できないため、ダウングレードを予約できませんでした。',409);
 const existingScheduleId=scheduleId(current);
 const schedule=existingScheduleId?await stripe(env,`subscription_schedules/${encodeURIComponent(existingScheduleId)}`):await stripe(env,'subscription_schedules',{from_subscription:current.id},`${key}-schedule-create`);
 const now=Math.floor(Date.now()/1000);
 const currentPhase=(schedule.phases||[]).find(phase=>Number(phase.start_date)<=now&&Number(phase.end_date)>now)||(schedule.phases||[])[0];
 const currentItems=currentPhase?.items?.length?currentPhase.items:(current.items?.data||[]);
 const params={end_behavior:'release',proration_behavior:'none'};
 params['phases[0][start_date]']=String(currentPhase?.start_date||currentSummary.currentPeriodStart||now);
 params['phases[0][end_date]']=String(currentSummary.nextRenewalAt);
 params['phases[0][proration_behavior]']='none';
 phaseItems(params,0,currentItems);
 params['phases[1][start_date]']=String(currentSummary.nextRenewalAt);
 params['phases[1][proration_behavior]']='none';
 phaseItems(params,1,[{price:planPrice(env,choice.plan),quantity:1},...(choice.channelPacks+choice.serverPacks?[{price:env.STRIPE_PRICE_ADDON,quantity:choice.channelPacks+choice.serverPacks}]:[])]);
 const metadata={dpi_plan:choice.plan,dpi_channel_packs:String(choice.channelPacks),dpi_server_packs:String(choice.serverPacks),...extraMetadata};
 for(const [name,value] of Object.entries(metadata))params[`phases[1][metadata][${name}]`]=String(value);
 return await stripe(env,`subscription_schedules/${encodeURIComponent(schedule.id)}`,params,`${key}-schedule-update`);
}
async function updateSubscription(env,current,choice,key,extra={},prorationDate){
 const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
 const addon=current.items?.data?.find(item=>item.price?.id===env.STRIPE_PRICE_ADDON);
 if(!base?.id)fail('契約項目を確認できませんでした。',409);
 const currentSummary=subscriptionSummary(current,env);
 const optionPacks=choice.channelPacks+choice.serverPacks;
 const currentOptionPacks=currentSummary.channelPacks+currentSummary.serverPacks;
 const baseChanged=currentSummary.planId!==choice.plan;
 const optionsChanged=currentOptionPacks!==optionPacks||currentSummary.channelPacks!==choice.channelPacks||currentSummary.serverPacks!==choice.serverPacks;
 const metadata={'metadata[dpi_plan]':choice.plan,'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks),...extra};
 let result=current,releasedSchedule=false;
 if(baseChanged){
  const existingScheduleId=scheduleId(current);
  if(existingScheduleId){await stripe(env,`subscription_schedules/${encodeURIComponent(existingScheduleId)}/release`,{},`${key}-schedule-release`);releasedSchedule=true;}
  const baseParams={'items[0][id]':base.id,'items[0][price]':planPrice(env,choice.plan),'items[0][quantity]':'1',proration_behavior:'always_invoice',payment_behavior:'pending_if_incomplete',proration_date:String(prorationDate||Math.floor(Date.now()/1000))};
  if(!optionsChanged)Object.assign(baseParams,metadata);
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,baseParams,`${key}-base`);
  if(result.pending_update)return{subscription:result,paymentPending:true,optionsDeferred:optionsChanged,releasedSchedule};
 }
 if(optionsChanged){
  const optionParams={proration_behavior:'none',payment_behavior:'pending_if_incomplete',...metadata};
  if(addon){optionParams['items[0][id]']=addon.id;if(optionPacks)optionParams['items[0][quantity]']=String(optionPacks);else optionParams['items[0][deleted]']='true';}
  else if(optionPacks){optionParams['items[0][price]']=env.STRIPE_PRICE_ADDON;optionParams['items[0][quantity]']=String(optionPacks);}
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,optionParams,`${key}-options`);
 } else if(!baseChanged){
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,{proration_behavior:'none',...metadata},`${key}-metadata`);
 }
 return{subscription:result,paymentPending:false,optionsDeferred:false,releasedSchedule};
}
function actionOrigin(env){
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin||!/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 return origin;
}
export async function adminBillingAction(env,customer,uid,input){
 if(!billingReady(env))fail('決済設定が完了していません。',503);
 if(!customer)fail('このユーザーにはStripe顧客情報がありません。',409);
 const action=String(input?.action||'');
 const requestId=String(input?.requestId||'');
 const reason=String(input?.reason||'').trim();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)fail('操作理由を5〜500文字で入力してください。',400);
 const key=`dpi-admin-${action}-${requestId}`;
 if(action==='grant_credit'||action==='remove_credit'){
  const amount=Number(input.amount);
  if(!Number.isInteger(amount)||amount<1||amount>1_000_000)fail('クレジット数を1〜1,000,000で指定してください。',400);
  const current=await customerCredits(env,customer);
  if(action==='remove_credit'&&amount>current)fail('利用可能クレジットを超えて削除できません。',409);
  const delta=action==='grant_credit'?amount:-amount;
  const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
   amount:String(-delta),currency:'jpy',description:`DPI-Bot ${action==='grant_credit'?'credit grant':'credit removal'}: ${reason}`,
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':action,'metadata[dpi_admin_reason]':reason,
  },key);
  const balanceAfter=creditsFromBalance(transaction.ending_balance);
  return {message:`${amount.toLocaleString('ja-JP')}クレジットを${action==='grant_credit'?'付与':'削除'}しました。`,credits:balanceAfter,creditEvent:{delta,balanceAfter,stripeTransactionId:transaction.id}};
 }
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
  const preview=await previewSubscriptionUpdate(env,customer,current,choice);
  let updateResult=null;
  if(preview.changeTiming==='next_period')await scheduleSubscriptionChange(env,current,choice,key,{dpi_admin_reason:reason,dpi_updated_by:'admin'});
  else updateResult=await updateSubscription(env,current,choice,key,{'metadata[dpi_admin_reason]':reason,'metadata[dpi_updated_by]':'admin'},preview.prorationDate);
  const message=preview.changeTiming==='next_period'?'ダウングレードを次回26日から適用するよう予約しました。返金は行いません。':updateResult?.paymentPending?`基本プランの変更は支払い確認待ちです。${updateResult.optionsDeferred?'追加オプションは支払い完了後に改めて変更してください。':''}`:'契約内容を変更しました。基本プランだけ日割りし、追加オプションは日割りせず次回26日から反映します。';
  return {message,paymentPending:updateResult?.paymentPending===true,optionsDeferred:updateResult?.optionsDeferred===true,subscriptions:await customerSubscriptionSummaries(env,customer)};
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
function eventCustomerId(event){
 const object=event?.data?.object;
 if(event?.type==='customer.updated')return clean(object?.id);
 return clean(stripeId(object?.customer));
}
async function syncCustomerEmail(db,customer){
 const customerId=clean(customer?.id),email=clean(customer?.email).toLowerCase();
 if(!customerId||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return false;
 const result=await db.prepare(`UPDATE supporter_accounts SET billing_email=?,updated_at=? WHERE discord_user_id=(SELECT discord_user_id FROM supporter_billing WHERE customer_id=?)`).bind(email,new Date().toISOString(),customerId).run();
 return Number(result.meta?.changes||0)>0;
}
async function expirePurchasedCredits(env,db,limit=100){
 const now=Math.floor(Date.now()/1000);
 const due=await db.prepare(`SELECT l.id,l.discord_user_id,l.remaining_amount,l.source_id,l.expires_at,b.customer_id
  FROM supporter_credit_lots l JOIN supporter_billing b ON b.discord_user_id=l.discord_user_id
  WHERE l.source_type='purchase' AND l.status='active' AND l.remaining_amount>0 AND l.expires_at<=?
  ORDER BY l.expires_at,l.id LIMIT ?`).bind(now,limit).all();
 let expired=0;
 for(const candidate of due.results||[]){
  const credits=await customerCredits(env,candidate.customer_id);
  await purchasedCreditStatus(db,candidate.discord_user_id,credits);
  const lot=await db.prepare(`SELECT remaining_amount,status FROM supporter_credit_lots WHERE id=?`).bind(candidate.id).first();
  if(!lot||lot.status!=='active'||Number(lot.remaining_amount)<=0)continue;
  const remaining=Number(lot.remaining_amount),available=await customerCredits(env,candidate.customer_id),remove=Math.min(remaining,available);
  let transactionId=`expiry:${candidate.id}`,balanceAfter=available;
  if(remove>0){
   const transaction=await stripe(env,`customers/${encodeURIComponent(candidate.customer_id)}/balance_transactions`,{
    amount:String(remove),currency:'jpy',description:`DPI-Bot expired credit: ${candidate.source_id}`,
    'metadata[dpi_user]':candidate.discord_user_id,'metadata[dpi_credit_action]':'expiry','metadata[dpi_credit_lot]':candidate.id,
   },await idempotencyKey('dpi-credit-expiry-',candidate.id));
   transactionId=transaction.id;balanceAfter=creditsFromBalance(transaction.ending_balance);
  }
  const claimed=await db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=0,status='expired',updated_at=?
   WHERE id=? AND remaining_amount=? AND status='active'`).bind(now,candidate.id,remaining).run();
  if(!claimed.meta?.changes)continue;
  await db.prepare(`INSERT INTO supporter_credit_events
   (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
   VALUES(?,?,?,?,?,'credit_expired','system',?) ON CONFLICT DO NOTHING`).bind(`expiry:${candidate.id}`,candidate.discord_user_id,-remove,balanceAfter,transactionId,new Date(now*1000).toISOString()).run();
  await db.prepare(`UPDATE supporter_credit_topups SET status='expired',updated_at=? WHERE checkout_session_id=? AND status='credited'`).bind(now,candidate.source_id).run();
  expired+=1;
 }
 return expired;
}
export async function billingWebhook(request,env){
 if(request.method!=='POST')return json({message:'Method not allowed'},405);
 if(!billingReady(env))return json({message:'Unavailable'},503);
 const reader=request.body?.getReader();if(!reader)return json({},400);const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return json({},413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const raw=new TextDecoder().decode(bytes);
 if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET))return json({},400);
 let event;try{event=JSON.parse(raw);}catch{return json({},400);}
 if(event.livemode!==false||typeof event.id!=='string')return json({},400);
 const allowed=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','customer.updated','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created','radar.early_fraud_warning.created'];
 if(!allowed.includes(event.type))return json({received:true});
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 const alreadyProcessed=await db.prepare('SELECT id FROM supporter_stripe_events WHERE id=?').bind(event.id).first();
 if(alreadyProcessed)return json({received:true});
 if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
  const session=event.data?.object;
  if(checkoutMetadata(session).dpi_checkout_kind==='credit_topup')await fulfillCreditTopup(env,db,session);
  else{
   const provisioned=await provisionPaidCheckoutSubscription(env,session);
   if(provisioned&&session?.payment_status==='paid')await sendBillingNotification(env,db,'payment_succeeded',{id:session.id,customer:session.customer,amount_paid:Number(session.amount_total||0),currency:session.currency||'jpy'});
  }
 }
 if(event.type==='invoice.paid')await recordInvoicePaid(env,db,event.data?.object);
 if(event.type==='invoice.payment_failed')await recordInvoiceFailed(env,db,event.data?.object);
 if(event.type==='charge.refunded')await revokeCreditTopup(env,db,event.data?.object,'refunded');
 if(event.type==='charge.dispute.created')await revokeCreditTopup(env,db,event.data?.object,'disputed');
 if(['checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)){
  const sessionId=clean(event.data?.object?.id);
  await db.batch([
   db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL,dirty=1 WHERE checkout_id=?').bind(sessionId),
   db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=? WHERE checkout_session_id=? AND status='pending'`).bind(Math.floor(Date.now()/1000),sessionId),
  ]);
 }
 if(event.type==='customer.updated')await syncCustomerEmail(db,event.data?.object);
 if(['customer.subscription.created','customer.subscription.updated'].includes(event.type)){
  const subscription=event.data?.object;
  const summary=subscriptionSummary(subscription,env);
  if(summary.recognizedPlan&&['active','trialing','past_due','unpaid','paused'].includes(subscription?.status))await reconcileStoredRulesForCustomer(db,subscription.customer,summary);
 }
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(eventCustomerId(event))]);
 return json({received:true});
}
export async function runSupporterBillingSchedule(env,nowMs=Date.now()){
 if(!billingReady(env))return {retried:0,paid:0,failed:0,suspended:0,expiredCredits:0};
 const db=env.REUSE_DB||env.NEWSLETTER_DB,now=Math.floor(Number(nowMs)/1000);let retried=0,paid=0,failed=0,suspended=0;
 const due=await db.prepare(`SELECT * FROM supporter_dunning WHERE status='retry_scheduled' AND retry_at<=? ORDER BY retry_at LIMIT 50`).bind(now).all();
 for(const row of due.results||[]){
  const claim=await db.prepare(`UPDATE supporter_dunning SET status='retrying',retry_attempted_at=?,updated_at=? WHERE invoice_id=? AND status='retry_scheduled'`).bind(now,now,row.invoice_id).run();
  if(!claim.meta?.changes)continue;retried+=1;
  let invoice=null,paymentError=null;
  try{invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}/pay`,{},`dpi-month-end-retry-${row.invoice_id}`);}catch(error){paymentError=error;console.error('Supporter month-end payment retry failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
  if(invoice?.status==='paid'){
   try{await recordInvoicePaid(env,db,invoice);}catch(error){console.error('Supporter payment success email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}paid+=1;continue;
  }
  const confirmedPaymentFailure=paymentError&&Number(paymentError.stripeStatus)===402&&!!clean(paymentError.stripeCode);
  if(paymentError&&!confirmedPaymentFailure){
   await db.prepare(`UPDATE supporter_dunning SET status='retry_scheduled',retry_attempted_at=NULL,updated_at=? WHERE invoice_id=? AND status='retrying'`).bind(now,row.invoice_id).run();
   continue;
  }
  const fallback=invoice||{id:row.invoice_id,customer:row.customer_id,subscription:row.subscription_id,amount_due:row.amount_due,currency:row.currency};
  await db.prepare(`UPDATE supporter_dunning SET status='suspend_scheduled',updated_at=? WHERE invoice_id=?`).bind(now,row.invoice_id).run();failed+=1;
  try{await sendBillingNotification(env,db,'final_failed',fallback,row.retry_at,row.suspend_at);}catch(error){console.error('Supporter final payment failure email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}
 }
 const stopping=await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE status='suspend_scheduled' AND suspend_at<=? ORDER BY suspend_at LIMIT 100`).bind(now).all();
 for(const row of stopping.results||[]){const result=await db.prepare(`UPDATE supporter_dunning SET status='suspended',suspended_at=?,updated_at=? WHERE invoice_id=? AND status='suspend_scheduled'`).bind(now,now,row.invoice_id).run();suspended+=Number(result.meta?.changes||0);}
 const failedNotices=await db.prepare(`SELECT n.invoice_id,n.kind,d.customer_id,d.subscription_id,d.amount_due,d.currency,d.retry_at,d.suspend_at
  FROM supporter_billing_notifications n JOIN supporter_dunning d ON d.invoice_id=n.invoice_id
  WHERE n.status='failed' AND n.kind IN ('retry_succeeded','final_failed') ORDER BY n.updated_at LIMIT 25`).all();
 for(const row of failedNotices.results||[]){const invoice={id:row.invoice_id,customer:row.customer_id,subscription:row.subscription_id,amount_due:row.amount_due,amount_paid:row.kind==='retry_succeeded'?row.amount_due:0,currency:row.currency};try{await sendBillingNotification(env,db,row.kind,invoice,row.retry_at,row.suspend_at);}catch(error){console.error('Supporter billing email retry failed',{invoiceId:row.invoice_id,kind:row.kind,errorName:error?.name||'Error'});}}
 const expiredCredits=await expirePurchasedCredits(env,db);
 return {retried,paid,failed,suspended,expiredCredits};
}
