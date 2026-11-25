import { refreshSupporterSnapshotSafely } from './supporter-snapshot.js';
import { getCustomPlan,customLocked,customPublic,enrichCustomSubscriptions,syncCustomWithStripe } from './supporter-custom.js';
import { currentCustomChange,getCustomChange,commitCustomChange } from './supporter-custom-change.js';
import { PLAN_FEATURES } from '../site/supporter/plan-features.js';
import { flushNotices, jstDate, memberLabel, noticeCounts, queueMembershipNotice, queueNotice, retryAdminNotices, suspendedCustomers, yen } from './supporter-ops-notice.js';
import { reconcileSupporterRolesSafely } from './supporter-roles.js';

// 決済のモード。SUPPORTER_BILLING_MODE は 'test' と 'live' だけを受け付け、キーの種類（sk/rk_test_・sk/rk_live_）と
// 一致しないときは決済を無効にする。Stripe の応答・Webhook の livemode も、このモードと一致するものだけを扱う。
export function billingMode(env){
 const mode=env?.SUPPORTER_BILLING_MODE;
 if(mode!=='test'&&mode!=='live')return '';
 const key=String(env.STRIPE_SECRET_KEY||'');
 return key.startsWith(`sk_${mode}_`)||key.startsWith(`rk_${mode}_`)?mode:'';
}
const expectedLivemode=env=>billingMode(env)==='live';
// テスト用（STRIPE_*）と本番用（STRIPE_LIVE_*）の両方を登録しておき、SUPPORTER_BILLING_MODE だけで切り替える。
// 本番用が欠けているときにテスト用を使うことは無い（決済は無効になる）。Worker の入口（index.js）で1回だけ解決する。
export const STRIPE_SETTINGS=Object.freeze(['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_SUPPORTER','STRIPE_PRICE_PLUS','STRIPE_PRICE_PRO','STRIPE_PRICE_ADDON','STRIPE_PORTAL_CONFIG']);
export const liveSettingName=name=>name.replace(/^STRIPE_/,'STRIPE_LIVE_');
export function resolveBillingEnv(env){
 if(env?.SUPPORTER_BILLING_MODE!=='live')return env;
 const resolved={...env};
 for(const name of STRIPE_SETTINGS)resolved[name]=String(env[liveSettingName(name)]||'');
 return resolved;
}
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clean=value=>String(value??'').trim();
const invoiceSubscriptionId=invoice=>typeof invoice?.subscription==='string'?invoice.subscription:typeof invoice?.parent?.subscription_details?.subscription==='string'?invoice.parent.subscription_details.subscription:'';
const STRIPE_DOCUMENT_HOSTS=new Set(['invoice.stripe.com','pay.stripe.com','files.stripe.com']);
const safeInvoiceUrl=value=>{try{const url=new URL(clean(value));return url.protocol==='https:'&&STRIPE_DOCUMENT_HOSTS.has(url.hostname)?url.href:'';}catch{return '';}};
const stripeId=value=>typeof value==='string'?value:value?.id||'';
async function idempotencyKey(prefix,value){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value??'')));
 return `${prefix}${[...new Uint8Array(bytes)].slice(0,16).map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
// 支払い不能の自動解約の時刻: 停止（翌月1日0時）から1か月後の1日0時（日本時間）。
export function autoCancelAt(suspendAt){
 const jst=new Date((Number(suspendAt)+32400)*1000);
 return Math.floor((Date.UTC(jst.getUTCFullYear(),jst.getUTCMonth()+1,1)-32400000)/1000);
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
 supporter:Object.freeze({id:'supporter',name:'BASIC',yen:300,channels:2,servers:1,rules:5,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_SUPPORTER',features:PLAN_FEATURES.supporter}),
 plus:Object.freeze({id:'plus',name:'Plus',yen:800,channels:10,servers:3,rules:15,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_PLUS',features:PLAN_FEATURES.plus}),
 pro:Object.freeze({id:'pro',name:'Pro',yen:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true,priceEnv:'STRIPE_PRICE_PRO',features:PLAN_FEATURES.pro}),
});
// 契約（初回・カスタム）の都度払い。請求書が作られないため、明細と返金ではこの Checkout を直接調べる。
const SUBSCRIBER_LIMIT_MESSAGE='現在の受付人数の上限に達しているため、新しいお申込みを受け付けていません。受付の再開をお待ちください。';
const PLAN_CHECKOUT_KINDS=new Set(['initial_subscription','custom_subscription_initial','custom_change']);
// プラン（サブスク）関連の支払いページでは PayPay を出さない（次回以降の自動課金に使えないため）。
// クレジットチャージなど 1 回払いでは使える。
export const SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS=Object.freeze({'excluded_payment_method_types[0]':'paypay'});
// 銀行振込・コンビニ払いもチャージで使える。クレジットは、入金を確認した通知（payment_status=paid）があるまで付与しない。
export function publicPlans(){return Object.values(PLAN_CATALOG).map(({priceEnv,...plan})=>plan);}
function planDefinition(plan){const value=PLAN_CATALOG[plan];if(!value)fail('プランまたは追加オプション数が不正です。');return value;}
function planPrice(env,plan){const definition=planDefinition(plan);const price=env[definition.priceEnv];if(!price)fail(`${definition.name}プランの決済設定が完了していません。`,503);return price;}
export function billingReady(env){return billingMode(env)!=='' && !!env.STRIPE_WEBHOOK_SECRET && !!env.STRIPE_PRICE_SUPPORTER && !!env.STRIPE_PRICE_PLUS && !!env.STRIPE_PRICE_PRO && !!env.STRIPE_PRICE_ADDON && !!env.STRIPE_PORTAL_CONFIG;}
async function stripe(env,path,params,key,method=params?'POST':'GET'){
 if(!billingReady(env)) fail('決済設定が完了していません。',503);
 const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2026-09-30.endive'};
 if(key)headers['Idempotency-Key']=key;
 if(params)headers['Content-Type']='application/x-www-form-urlencoded';
 // 同時に押された申込みなどで、同じ冪等キーの処理がまだ終わっていないとき（409）だけ、同じキーで少し待ってやり直す（二重には作られない）。
 let r,result;
 for(let attempt=0;;attempt+=1){
  r=await fetch(`https://api.stripe.com/v1/${path}`,{method,headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});
  result=undefined;
  try{result=await r.json();}catch{break;}
  if(!(key&&r.status===409&&result?.error?.code==='idempotency_key_in_use'&&attempt<3))break;
  await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)));
 }
 if(result===undefined){
  console.error('Stripe API returned invalid JSON',{path,status:r.status,requestId:r.headers.get('request-id')||''});
  throw Object.assign(new Error('Stripeから正しい応答を受信できませんでした。時間をおいて再試行してください。'),{status:502,stripeStatus:r.status});
 }
 if(!r.ok){
  const detail=String(result?.error?.message||'').replace(/[\r\n\t]/g,' ').slice(0,300);
  console.error('Stripe API request failed',{path,status:r.status,requestId:r.headers.get('request-id')||'',type:result?.error?.type||'',code:result?.error?.code||'',param:result?.error?.param||'',message:String(result?.error?.message||'').slice(0,300)});
  throw Object.assign(new Error(detail&&env.SUPPORTER_BILLING_MODE==='test'?`Stripeテスト環境が決済情報を拒否しました: ${detail}`:'Stripeへの接続に失敗しました。時間をおいて再試行してください。'),{status:502,stripeStatus:r.status,stripeCode:clean(result?.error?.code)});
 }
 if(typeof result.livemode==='boolean'&&result.livemode!==expectedLivemode(env))fail('決済環境（テスト・本番）が一致しません。',503);
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
export function paymentMethodRegistered(customer,subscription){
 return !!(stripeId(customer?.invoice_settings?.default_payment_method)||stripeId(customer?.default_source)||stripeId(subscription?.default_payment_method));
}
async function recordInvoiceCreditPayment(env,db,uid,customer,invoiceId,amount,transactionId){
 const credits=await customerCredits(env,customer),now=new Date().toISOString();
 await db.prepare(`INSERT INTO supporter_credit_events
  (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
  VALUES(?,?,?,?,?,'invoice_payment','user',?) ON CONFLICT DO NOTHING`)
  .bind(`invoice:${invoiceId}`,uid,-amount,credits,transactionId||`invoice:${invoiceId}`,now).run();
 await purchasedCreditStatus(db,uid,credits);
 return credits;
}
export async function payInvoiceWithCredits(env,db,customer,uid,invoiceId){
 const encoded=encodeURIComponent(invoiceId),invoice=await stripe(env,`invoices/${encoded}`),invoiceCustomer=stripeId(invoice?.customer),subscriptionId=invoiceSubscriptionId(invoice);
 const owned=await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE invoice_id=? AND customer_id=? AND subscription_id=?`).bind(invoiceId,customer,subscriptionId).first();
 if(invoiceCustomer!==customer||!subscriptionId||!owned)fail('この請求書はお支払いできません。',403);
 if(!['open','paid'].includes(invoice?.status))fail('この請求書はお支払いできません。',409);
 const amount=Math.max(0,Number(invoice.amount_remaining)||0),transactions=[];
 await stripeListAll(env,`customers/${encodeURIComponent(customer)}/balance_transactions?limit=100`,item=>{if(item?.metadata?.dpi_credit_invoice===invoiceId)transactions.push(item);});
 const net=transactions.reduce((sum,item)=>sum+(Number(item.amount)||0),0),n=transactions.length;
 const debit=transactions.find(item=>Number(item.amount)>0);
 if(invoice.status==='paid'){
  const credits=net>0?await recordInvoiceCreditPayment(env,db,uid,customer,invoiceId,net,debit?.id):await customerCredits(env,customer);
  return {invoice,amount:net,credits,alreadyPaid:true};
 }
 if(!Number.isSafeInteger(amount)||amount<1)fail('請求額を確認できません。',409);
 if(net>0&&net<amount){
  await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{amount:String(-net),currency:'jpy',description:`DPI-Bot invoice credit reversal: ${invoiceId}`,'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'invoice_payment','metadata[dpi_credit_invoice]':invoiceId},`dpi-credit-invoice-reverse-${invoiceId}-${n}`);
  fail('クレジットの充当状態を復旧しました。もう一度お試しください。',503);
 }
 let transaction=debit;
 if(net<amount){
  const credits=await customerCredits(env,customer);
  if(credits<amount)fail(`クレジットが${(amount-credits).toLocaleString('ja-JP')}円不足しています。`,409);
  transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{amount:String(amount),currency:'jpy',description:`DPI-Bot invoice credit payment: ${invoiceId}`,'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'invoice_payment','metadata[dpi_credit_invoice]':invoiceId},`dpi-credit-invoice-${invoiceId}-${n}`);
 }
 let paid;
 try{paid=await stripe(env,`invoices/${encoded}/pay`,{paid_out_of_band:'true'},`dpi-credit-invoice-pay-${invoiceId}-${n}`);}
 catch(error){
  let current;
  try{current=await stripe(env,`invoices/${encoded}`);}catch{throw error;}
  // 時間切れ・5xx・混雑では、後から支払いが成立することがある。戻さずに残し、次の実行で引き落とし済みとして続ける。
  const refused=[400,402,403,404].includes(Number(error?.stripeStatus));
  if(current?.status==='open'&&!refused)throw error;
  if(current?.status==='paid')paid=current;
  else if(current?.status==='open'){
   await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{amount:String(-amount),currency:'jpy',description:`DPI-Bot invoice credit reversal: ${invoiceId}`,'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'invoice_payment','metadata[dpi_credit_invoice]':invoiceId},`dpi-credit-invoice-reverse-${invoiceId}-${n}`);
   throw error;
  }else throw error;
 }
 if(paid?.status!=='paid')fail('請求書の支払いを確認できません。',503);
 const credits=await recordInvoiceCreditPayment(env,db,uid,customer,invoiceId,amount,transaction?.id);
 try{await recordInvoicePaid(env,db,paid);await reconcileSuspendedInvoices(env,db,customer,5);}catch(error){console.error('Supporter credit invoice reconciliation failed',{invoiceId,errorName:error?.name||'Error'});}
 return {invoice:paid,amount,credits,alreadyPaid:false};
}
async function purchasedCreditStatus(db,uid,stripeCredits){
 const now=Math.floor(Date.now()/1000);
 let lots;
 try{lots=await db.prepare(`SELECT id,source_type,remaining_amount,expires_at,status FROM supporter_credit_lots
  WHERE discord_user_id=? AND source_type IN ('purchase','admin') AND status='active' AND remaining_amount>0
  ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,expires_at,id`).bind(uid).all();}
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
 const active=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN source_type='purchase' THEN remaining_amount ELSE 0 END),0) AS purchased_balance,MIN(expires_at) AS next_expiry
  FROM supporter_credit_lots WHERE discord_user_id=? AND (source_type='purchase' OR (source_type='admin' AND source_id LIKE 'compensation:%')) AND status='active' AND remaining_amount>0`).bind(uid).first();
 const history=await db.prepare(`SELECT request_id,amount,status,purchased_at,expires_at,created_at
  FROM supporter_credit_topups WHERE discord_user_id=? ORDER BY created_at DESC LIMIT 20`).bind(uid).all();
 let compensations=[];
 try{
  const result=await db.prepare(`SELECT c.id,c.amount,c.reason,c.expires_at,c.created_at,r.status,r.credited_at,l.remaining_amount
   FROM supporter_credit_campaign_recipients r
   JOIN supporter_credit_campaigns c ON c.id=r.campaign_id
   LEFT JOIN supporter_credit_lots l ON l.id=r.lot_id
   WHERE r.discord_user_id=? AND r.status IN ('credited','expired')
   ORDER BY COALESCE(r.credited_at,c.created_at) DESC LIMIT 20`).bind(uid).all();
  compensations=(result.results||[]).map(row=>({id:clean(row.id),amount:Number(row.amount)||0,reason:clean(row.reason),expiresAt:unix(row.expires_at),creditedAt:unix(row.credited_at),status:clean(row.status),remainingAmount:Math.max(0,Number(row.remaining_amount)||0)}));
 }catch(error){console.warn('Supporter compensation history is unavailable',{errorName:error?.name||'Error'});}
 let adminConfiscations=[];
 try{
  const result=await db.prepare(`SELECT id,credit_delta,balance_after,reason,actor,created_at
   FROM supporter_credit_events
   WHERE discord_user_id=? AND credit_delta<0 AND actor NOT IN ('user','system')
   ORDER BY created_at DESC LIMIT 20`).bind(uid).all();
  adminConfiscations=(result.results||[]).map(row=>{
   const parsed=Date.parse(clean(row.created_at));
   return {id:clean(row.id),amount:Math.abs(Number(row.credit_delta)||0),balanceAfter:Math.max(0,Number(row.balance_after)||0),reason:clean(row.reason),processedAt:Number.isFinite(parsed)?Math.floor(parsed/1000):null};
  });
 }catch(error){console.warn('Supporter administrator confiscation history is unavailable',{errorName:error?.name||'Error'});}
 return {
  balance:Math.max(0,Number(stripeCredits)||0),
  purchasedBalance:Math.max(0,Number(active?.purchased_balance)||0),
  nextExpiry:unix(active?.next_expiry),
  topups:(history.results||[]).map(row=>({id:clean(row.request_id),amount:Number(row.amount)||0,status:clean(row.status),purchasedAt:unix(row.purchased_at),expiresAt:unix(row.expires_at),createdAt:unix(row.created_at)})),
  compensations,
  adminConfiscations,
 };
}
async function creditPurchaseTimestamp(env,session,paidAt){
 const explicit=Number(paidAt);
 if(Number.isInteger(explicit)&&explicit>0)return explicit;
 const paymentIntentId=clean(stripeId(session?.payment_intent));
 if(paymentIntentId){
  try{
   const intent=await stripe(env,`payment_intents/${encodeURIComponent(paymentIntentId)}`);
   const chargeId=clean(stripeId(intent?.latest_charge));
   if(chargeId){
    const charge=await stripe(env,`charges/${encodeURIComponent(chargeId)}`);
    const chargedAt=Number(charge?.created);
    if(Number.isInteger(chargedAt)&&chargedAt>0)return chargedAt;
   }
   const intentCreated=Number(intent?.created);
   if(Number.isInteger(intentCreated)&&intentCreated>0)return intentCreated;
  }catch(error){console.warn('Credit top-up payment timestamp lookup failed',{sessionId:clean(session?.id),errorName:error?.name||'Error'});}
 }
 // Never shorten the purchased validity period because reconciliation ran late.
 return Math.floor(Date.now()/1000);
}
// A credit grant is claimed in D1 before Stripe is called. Stripe idempotency
// keys expire after 24 hours, so a late retry (webhook redelivery, a leftover
// pending row, a resumed compensation batch) must find the earlier grant via
// the claim/its Stripe metadata instead of creating a second balance credit.
async function findCreditGrantTransaction(env,customer,since,matches,maxPages=10){
 let startingAfter='';
 for(let page=0;page<maxPages;page++){
  const result=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions?limit=100${startingAfter?`&starting_after=${encodeURIComponent(startingAfter)}`:''}`);
  if(!Array.isArray(result?.data))fail('過去のクレジット付与を確認できませんでした。時間をおいて再試行してください。',503);
  const found=result.data.find(matches);if(found)return found;
  const oldest=result.data.at(-1);
  if(!result.has_more||!oldest?.id||Number(oldest.created)<since)return null;
  startingAfter=oldest.id;
 }
 fail('過去のクレジット付与を確認できませんでした。時間をおいて再試行してください。',503);
}
export async function grantCreditOnce(env,db,{grantKey,kind,uid,customer,amount,params,idempotencyKey,matches=null,record}){
 const now=Math.floor(Date.now()/1000);
 if(!grantKey||!customer||!Number.isSafeInteger(amount)||amount<1)fail('クレジット付与情報を確認できませんでした。',409);
 const inserted=await db.prepare(`INSERT INTO supporter_credit_grants
  (grant_key,kind,discord_user_id,customer_id,amount,status,created_at,updated_at)
  VALUES(?,?,?,?,?,'claimed',?,?) ON CONFLICT(grant_key) DO NOTHING`).bind(grantKey,kind,uid,customer,amount,now,now).run();
 let claimedAt=now;const fresh=Number(inserted?.meta?.changes||0)>0;
 if(!fresh){
  const claim=await db.prepare('SELECT * FROM supporter_credit_grants WHERE grant_key=?').bind(grantKey).first();
  if(!claim)fail('クレジット付与の処理状態を確認できませんでした。',503);
  if(claim.customer_id!==customer||Number(claim.amount)!==amount)fail('別の条件で処理済みのクレジット付与です。',409);
  if(claim.status==='granted')return{alreadyRecorded:true,transactionId:clean(claim.stripe_transaction_id),balanceAfter:Math.max(0,Number(claim.balance_after)||0)};
  claimedAt=Number(claim.created_at)||0;
 }
 const match=transaction=>transaction?.metadata?.dpi_credit_grant===grantKey||(typeof matches==='function'&&matches(transaction)===true);
 // An earlier attempt may have reached Stripe and then failed before recording it.
 let transaction=fresh?null:await findCreditGrantTransaction(env,customer,claimedAt-300,match);
 if(!transaction)transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{...params,'metadata[dpi_credit_grant]':grantKey},idempotencyKey);
 const balanceAfter=creditsFromBalance(transaction.ending_balance);
 await db.batch([
  ...await record(transaction,balanceAfter),
  db.prepare(`UPDATE supporter_credit_grants SET status='granted',stripe_transaction_id=?,balance_after=?,updated_at=? WHERE grant_key=?`).bind(transaction.id,balanceAfter,Math.floor(Date.now()/1000),grantKey),
 ]);
 return{alreadyRecorded:false,transactionId:transaction.id,balanceAfter};
}
async function fulfillCreditTopup(env,db,session,paidAt=null){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='credit_topup'||session.payment_status!=='paid')return null;
 const uid=clean(metadata.dpi_user||session.client_reference_id),requestId=clean(metadata.dpi_topup_request_id);
 const customer=clean(stripeId(session.customer)),paymentIntent=clean(stripeId(session.payment_intent));
 const amount=normalizeCreditTopupAmount(metadata.dpi_credit_amount);
 if(!/^\d{17,20}$/.test(uid)||!/^[0-9a-f-]{36}$/i.test(requestId)||!customer||!paymentIntent||clean(session.currency).toLowerCase()!=='jpy'||Number(session.amount_total)!==amount)fail('クレジット決済情報を確認できませんでした。',409);
 const billing=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(!billing?.customer_id||billing.customer_id!==customer)fail('クレジット決済の利用者を確認できませんでした。',409);
 const purchasedAt=await creditPurchaseTimestamp(env,session,paidAt),expiresAt=creditExpiresAt(purchasedAt),now=Math.floor(Date.now()/1000);
 const grant=await grantCreditOnce(env,db,{
  grantKey:`topup:${session.id}`,kind:'credit_topup',uid,customer,amount,
  params:{amount:String(-amount),currency:'jpy',description:`DPI-Bot credit top-up: ${session.id}`,
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'user_topup','metadata[dpi_checkout_session]':session.id},
  idempotencyKey:`dpi-credit-topup-${session.id}`,
  matches:transaction=>transaction?.metadata?.dpi_credit_action==='user_topup'&&transaction?.metadata?.dpi_checkout_session===session.id,
  record:(transaction,balanceAfter)=>[
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
  ],
 });
 // Already granted and recorded atomically by an earlier attempt: never grant or notify twice.
 if(grant.alreadyRecorded)return null;
 return {uid,amount,balanceAfter:grant.balanceAfter,expiresAt};
}
// 銀行振込・コンビニ払いの入金待ちが、期限切れ・取り消しで終わったか。
async function topupPaymentEnded(env,session){
 const id=clean(stripeId(session.payment_intent));if(!id)return false;
 const intent=await stripe(env,`payment_intents/${encodeURIComponent(id)}`);
 return ['canceled','requires_payment_method'].includes(intent?.status);
}
export async function reconcilePendingCreditTopups(env,db,uid,customer){
 if(!customer)return {checked:0,recovered:0,failed:0};
 const pending=await db.prepare(`SELECT request_id,checkout_session_id FROM supporter_credit_topups
  WHERE discord_user_id=? AND customer_id=? AND status='pending' AND checkout_session_id IS NOT NULL
  ORDER BY created_at DESC LIMIT 20`).bind(uid,customer).all();
 let checked=0,recovered=0,failed=0;
 for(const row of pending.results||[]){
  checked+=1;
  try{
   const session=await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_session_id)}`);
   if(session.status==='complete'&&session.payment_status==='paid'){
    if(await rejectDisciplinedCheckout(env,db,session)){failed+=1;continue;}
    const fulfilled=await fulfillCreditTopup(env,db,session);
    if(fulfilled){
     recovered+=1;
     try{await sendBillingNotification(env,db,'credit_topup_succeeded',{id:session.id,customer:session.customer,amount_paid:fulfilled.amount,currency:session.currency||'jpy',expires_at:fulfilled.expiresAt});}
     catch(error){console.error('Recovered credit top-up email failed',{sessionId:session.id,errorName:error?.name||'Error'});}
    }
   }else if(session.status==='expired'||(session.status==='complete'&&session.payment_status==='unpaid'&&await topupPaymentEnded(env,session))){
    await db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=?
     WHERE request_id=? AND status='pending'`).bind(Math.floor(Date.now()/1000),row.request_id).run();
   }
  }catch(error){failed+=1;console.error('Pending credit top-up reconciliation failed',{sessionId:row.checkout_session_id,errorName:error?.name||'Error',stripeStatus:error?.stripeStatus||0});}
 }
 return {checked,recovered,failed};
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
 const topupStatus=target>=Number(topup.amount)?reason:'credited';
 const claim=await db.prepare(`UPDATE supporter_credit_topups SET refunded_amount=?,status=?,updated_at=?
  WHERE request_id=? AND refunded_amount=?`).bind(target,topupStatus,now,topup.request_id,previous).run();
 if(!claim.meta?.changes){
  const current=await db.prepare('SELECT refunded_amount FROM supporter_credit_topups WHERE request_id=?').bind(topup.request_id).first();
  if(Number(current?.refunded_amount||0)>=target)return null;
  fail('返金クレジットの同時更新を検出しました。再処理します。',503);
 }
 let transactionId=`${reason}:${object?.id||paymentIntent}:${target}`,balanceAfter=available;
 try{
  if(remove>0){
   const transaction=await stripe(env,`customers/${encodeURIComponent(topup.customer_id)}/balance_transactions`,{
    amount:String(remove),currency:'jpy',description:`DPI-Bot credit ${reason}: ${topup.checkout_session_id}`,
    'metadata[dpi_user]':topup.discord_user_id,'metadata[dpi_credit_action]':reason,'metadata[dpi_payment_intent]':paymentIntent,
   },await idempotencyKey('dpi-credit-reversal-',`${object?.id||paymentIntent}:${reason}:${target}`));
   transactionId=transaction.id;balanceAfter=creditsFromBalance(transaction.ending_balance);
  }
 }catch(error){
  await db.prepare(`UPDATE supporter_credit_topups SET refunded_amount=?,status=?,updated_at=?
   WHERE request_id=? AND refunded_amount=?`).bind(previous,topup.status,Math.floor(Date.now()/1000),topup.request_id,target).run();
  throw error;
 }
 const nextRemaining=Math.max(0,remaining-lotReduction);
 const statements=[
  db.prepare(`INSERT INTO supporter_credit_events
   (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
   VALUES(?,?,?,?,?,?, 'system',?) ON CONFLICT DO NOTHING`).bind(`${reason}:${object?.id||paymentIntent}:${target}`,topup.discord_user_id,-remove,balanceAfter,transactionId,`credit_${reason}`,new Date(now*1000).toISOString()),
 ];
 if(lot?.id)statements.push(db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=?,status=?,updated_at=?
  WHERE id=? AND remaining_amount=?`).bind(nextRemaining,nextRemaining?'active':'revoked',now,lot.id,remaining));
 await db.batch(statements);
 return {uid:topup.discord_user_id,removed:remove,status:topupStatus};
}
const stripeInvoiceUrl=value=>safeInvoiceUrl(value)||null;
// 契約の都度払い（初回・カスタムの差額）の支払い済み Checkout。請求書は無いが、領収書と返金状態は決済から取れる。
async function planCheckoutPayments(env,customer){
 const result=await stripe(env,`checkout/sessions?customer=${encodeURIComponent(customer)}&limit=20&expand[]=data.payment_intent.latest_charge`);
 return (result.data||[]).filter(session=>session?.mode==='payment'&&session.status==='complete'&&session.payment_status==='paid'
  &&PLAN_CHECKOUT_KINDS.has(checkoutMetadata(session).dpi_checkout_kind)).map(session=>{
  const intent=session.payment_intent,charge=intent&&typeof intent==='object'&&intent.latest_charge&&typeof intent.latest_charge==='object'?intent.latest_charge:null;
  return {kind:checkoutMetadata(session).dpi_checkout_kind,created:Number(charge?.created||session.created)||0,paymentIntent:clean(stripeId(intent)),
   amount:Number(session.amount_total)||0,refunded:Math.max(0,Number(charge?.amount_refunded)||0),currency:clean(session.currency||'jpy').toLowerCase(),receiptUrl:charge?.receipt_url||''};
 });
}
async function planCheckoutInvoices(env,customer){
 try{
  return (await planCheckoutPayments(env,customer)).map(payment=>({
   number:'',label:payment.kind==='custom_change'?'カスタムプランの差額':'初回利用料',
   status:payment.refunded>=payment.amount&&payment.amount>0?'refunded':'paid',created:unix(payment.created),periodStart:null,periodEnd:null,
   currency:payment.currency,amountDue:payment.amount,amountPaid:payment.amount,total:payment.amount,refunded:payment.refunded,
   hostedInvoiceUrl:null,invoicePdf:null,receiptUrl:stripeInvoiceUrl(payment.receiptUrl),
  }));
 }catch(error){console.error('Supporter initial payment history is unavailable',{errorName:error?.name||'Error'});return [];}
}
export async function customerInvoices(env,customer){
 if(!customer||!billingReady(env))return [];
 const [result,initial]=await Promise.all([stripe(env,`invoices?customer=${encodeURIComponent(customer)}&limit=12`),planCheckoutInvoices(env,customer)]);
 const invoices=(result.data||[]).map(invoice=>({
  number:String(invoice.number||''),status:String(invoice.status||'unknown'),created:unix(invoice.created),
  periodStart:unix(invoice.period_start),periodEnd:unix(invoice.period_end),currency:String(invoice.currency||'jpy').toLowerCase(),
  amountDue:Number(invoice.amount_due||0),amountPaid:Number(invoice.amount_paid||0),total:Number(invoice.total||0),
  hostedInvoiceUrl:stripeInvoiceUrl(invoice.hosted_invoice_url),invoicePdf:stripeInvoiceUrl(invoice.invoice_pdf),
 })).filter(invoice=>invoice.number||invoice.hostedInvoiceUrl||invoice.invoicePdf);
 return [...invoices,...initial].sort((a,b)=>Number(b.created||0)-Number(a.created||0)).slice(0,12);
}
async function dunningState(db,customer){
 if(!customer)return {usageSuspended:false,status:null,retryAt:null,suspendAt:null};
 const row=await db.prepare(`SELECT invoice_id,status,retry_at,suspend_at FROM supporter_dunning
  WHERE customer_id=? AND status IN ('retry_scheduled','retrying','suspend_scheduled','suspended')
  ORDER BY CASE WHEN status='suspended' AND invoice_id LIKE 'hold:dispute:%' THEN 0 WHEN status='suspended' THEN 1 ELSE 2 END,initial_failed_at DESC LIMIT 1`).bind(customer).first();
 return {reason:String(row?.invoice_id||'').startsWith(DISPUTE_PREFIX)?'dispute':'payment',usageSuspended:row?.status==='suspended',status:row?.status||null,retryAt:unix(row?.retry_at),suspendAt:unix(row?.suspend_at)};
}
async function unpaidInvoices(env,db,customer){
 if(!customer)return [];
 const rows=await db.prepare(`SELECT invoice_id,initial_failed_at FROM supporter_dunning
  WHERE customer_id=? AND invoice_id LIKE 'in_%' AND status IN ('retry_scheduled','retrying','suspend_scheduled','suspended')
  ORDER BY initial_failed_at,invoice_id`).bind(customer).all();
 const result=[];
 for(const row of rows.results||[]){
  const invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}`);
  if(invoice?.status==='open'&&stripeId(invoice.customer)===customer&&invoiceSubscriptionId(invoice)&&Number(invoice.amount_remaining)>0)result.push({row,invoice,amount:Number(invoice.amount_remaining),debited:0});
 }
 // 引き落とし済みで、支払いの確定だけが残っている分は、もう一度残高を求めない。
 if(result.length)await stripeListAll(env,`customers/${encodeURIComponent(customer)}/balance_transactions?limit=100`,item=>{
  const target=result.find(entry=>entry.invoice.id===item?.metadata?.dpi_credit_invoice);if(target)target.debited+=Number(item.amount)||0;
 });
 return result;
}
const unpaidCreditNeeded=items=>items.reduce((sum,item)=>sum+(item.debited>=item.amount?0:item.amount),0);
const mailDate=value=>new Intl.DateTimeFormat('ja-JP',{dateStyle:'long',timeStyle:'medium',timeZone:'Asia/Tokyo'}).format(new Date(Number(value)*1000));
// 本文（テキスト）から HTML 版を作る。「名前: URL」の行は、名前をクリックすると開けるリンクにする。リンクにするのは当方と Stripe の URL だけ。
const MAIL_LINK_HOSTS=new Set(['dpi-bot.com','discord.gg',...STRIPE_DOCUMENT_HOSTS]);
const escapeHtml=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
function mailLink(line){
 const link=line.match(/^([^:：]{1,60}): (https:\/\/\S+)$/);
 if(link){try{const url=new URL(link[2]);if(url.protocol==='https:'&&MAIL_LINK_HOSTS.has(url.hostname)&&!url.username&&!url.port)return `<a href="${escapeHtml(url.href)}" style="color:#3d4652;font-weight:bold;text-decoration:underline">${escapeHtml(link[1])}</a>`;}catch{}}
 return escapeHtml(line);
}
export function mailHtml(text){
 const body=String(text).split('\n').map(line=>/^-{10,}$/.test(line)?'<hr style="border:0;border-top:1px solid #b9bcc1;margin:14px 0">':line?`<div style="margin:3px 0">${mailLink(line)}</div>`:'<div style="height:10px"></div>').join('');
 return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px;background:#d5d7da"><div style="max-width:620px;margin:0 auto;padding:20px;background:#ececee;border:1px solid #b9bcc1;border-radius:8px;color:#33363b;font-family:'Hiragino Sans','Yu Gothic',Meiryo,sans-serif;font-size:15px;line-height:1.7;overflow-wrap:anywhere">${body}</div></body></html>`;
}
function supporterMailSignature(){
 return ['----------------------------------------','DPI-Bot','契約・支払い方法の管理: https://dpi-bot.com/site/supporter/','お問い合わせ: https://dpi-bot.com/site/supp/index.html','利用規約・特定商取引法に基づく表記: https://dpi-bot.com/terms/index.html','※お支払い・契約に関する重要なお知らせのため、配信停止の設定にかかわらずお送りしています。'].join('\n');
}
function billingMailContent(env,kind,invoice,retryAt,suspendAt,sentAt){
 const amount=new Intl.NumberFormat('ja-JP',{style:'currency',currency:clean(invoice.currency||'jpy').toUpperCase(),maximumFractionDigits:0}).format(Number(invoice.amount_paid||invoice.amount_due||invoice.total||0));
 const date=value=>value?new Intl.DateTimeFormat('ja-JP',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(Number(value)*1000)):'—';
 const number=clean(invoice.number)||clean(invoice.id);
 const definitions={
  payment_succeeded:['【DPI-Bot】お支払い完了のお知らせ',[`DPI-Bot有料プランのお支払いが完了しました。`,...(Number(invoice.credit_applied)>0?[`事前チャージの残高から: ${Number(invoice.credit_applied).toLocaleString('ja-JP')}円`,`カードなどへの請求額: ${amount}`]:[`請求額: ${amount}`]),`請求書: ${number}`]],
  retry_succeeded:['【DPI-Bot】再決済完了のお知らせ',[`月末の再決済が完了しました。引き続き有料プランをご利用いただけます。`,`請求額: ${amount}`,`請求書: ${number}`]],
  payment_failed:['【DPI-Bot】お支払い失敗と月末再決済のお知らせ',[`26日のお支払いを完了できませんでした。`,`月末再決済日時: ${date(retryAt)}`,`請求額: ${amount}`,`請求書: ${number}`,'月末までに契約管理画面から支払方法をご確認ください。','請求額以上のクレジットをチャージすると、契約・支払い方法の管理画面の操作、または月末の再決済でクレジットから支払えます（一部だけの充当はできません）。']],
  final_failed:['【DPI-Bot】月末再決済失敗・利用停止のお知らせ',[`月末の再決済を完了できませんでした。`,`利用停止日時: ${date(suspendAt)}`,`請求額: ${amount}`,`請求書: ${number}`,'翌月以降、有料プランの通知設定は支払い完了まで利用停止となります。未払いの請求が複数ある場合は、すべてのお支払いを確認してから再開します。','停止中は新しい月額料金を請求しません。停止から1か月間お支払いを確認できない場合は、契約を自動的に解約し、未払いの請求を取り消します。','請求額以上のクレジットをチャージすると、契約・支払い方法の管理画面の操作、または月末の再決済でクレジットから支払えます（一部だけの充当はできません）。']],
  auto_canceled:['【DPI-Bot】有料プラン自動解約のお知らせ',['利用停止から1か月間お支払いを確認できなかったため、有料プランの契約を自動的に解約しました。',`取り消した請求: ${amount}`,'今回の未払いの請求を新たにお支払いいただく必要はありません。再度ご利用になる場合は、改めてお申込みください。']],
  credit_topup_succeeded:['【DPI-Bot】クレジットチャージ完了のお知らせ',[`クレジットチャージが完了しました。`,`購入額: ${amount}`,`付与クレジット: ${Number(invoice.amount_paid||0).toLocaleString('ja-JP')}クレジット`,`有効期限: ${date(invoice.expires_at)}`,'購入クレジットは、有料プラン・プラン変更・追加オプションの支払いに利用できます。']],
  credit_topup_failed:['【DPI-Bot】クレジットチャージ失敗のお知らせ',[`クレジットチャージを完了できませんでした。`,`決済予定額: ${amount}`,'クレジットは付与されていません。支払方法を確認し、必要な場合は改めてチャージしてください。']],
  credit_plan_payment_succeeded:['【DPI-Bot】クレジット払いによるプラン申込み完了のお知らせ',[`チャージ済みクレジットによる有料プランのお申込みが完了しました。`,`使用クレジット: ${Number(invoice.amount_paid||0).toLocaleString('ja-JP')}クレジット`,`次回更新日: ${date(invoice.next_renewal_at)}`,'今回の申込みではカード情報を入力していません。次回請求時にクレジットが不足する場合は、契約管理画面から支払方法を登録してください。']],
  credit_expired:['【DPI-Bot】クレジット有効期限切れのお知らせ',[`購入クレジットの有効期限が終了しました。`,`失効クレジット: ${Number(invoice.amount_due||0).toLocaleString('ja-JP')}クレジット`,`失効日時: ${date(invoice.expires_at)}`,'有効期限を過ぎた未使用分は利用規約に基づき失効し、原則として払戻しまたは再発行を行いません。']],
 };
 const [subject,body]=definitions[kind];const links=[];
 if(safeInvoiceUrl(invoice.hosted_invoice_url))links.push(`請求書（画面）: ${safeInvoiceUrl(invoice.hosted_invoice_url)}`);
 if(safeInvoiceUrl(invoice.invoice_pdf))links.push(`請求書（PDF）: ${safeInvoiceUrl(invoice.invoice_pdf)}`);
 if(safeInvoiceUrl(invoice.receipt_url))links.push(`領収書: ${safeInvoiceUrl(invoice.receipt_url)}`);
 const management='お支払い・請求書の確認: https://dpi-bot.com/site/supporter/';
 if(['payment_failed','final_failed'].includes(kind))body.push(management);
 if(links.length)body.push(...links);else if((invoice.link_lookup_failed&&!body.includes(management))||kind==='credit_plan_payment_succeeded')body.push(kind==='credit_plan_payment_succeeded'?'お支払いの内容は契約・支払い方法の管理から確認できます':management);
 const lines=['DPI-Bot 有料プランをご利用いただき、ありがとうございます。','',...body,'',`通知番号: ${clean(invoice.id)}`,`送信日時（日本時間）: ${mailDate(sentAt)}`,'',supporterMailSignature()];
 return {subject,text:lines.join('\n')};
}
async function billingLinkGet(env,path,deadline){
 const remaining=deadline-Date.now();if(remaining<=0)throw new Error('billing link timeout');
 const response=await fetch(`https://api.stripe.com/v1/${path}`,{headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2026-09-30.endive'},signal:AbortSignal.timeout(Math.max(1,remaining))});
 if(!response.ok)throw new Error(`billing link lookup ${response.status}`);return response.json();
}
async function enrichBillingLinks(env,kind,source){
 const invoice={...source},id=clean(source.id);let gets=0,failed=false;const deadline=Date.now()+8000;
 const get=async path=>{if(gets>=2)throw new Error('billing link lookup limit');gets+=1;return billingLinkGet(env,path,deadline);};
 try{
  if(id.startsWith('in_')){
   const paid=['payment_succeeded','retry_succeeded'].includes(kind);let detail=source;
   if(!safeInvoiceUrl(source.hosted_invoice_url)||!safeInvoiceUrl(source.invoice_pdf)||paid)detail=await get(`invoices/${encodeURIComponent(id)}?expand[]=payments.data.payment.payment_intent`);
   invoice.hosted_invoice_url=safeInvoiceUrl(source.hosted_invoice_url)||safeInvoiceUrl(detail.hosted_invoice_url);invoice.invoice_pdf=safeInvoiceUrl(source.invoice_pdf)||safeInvoiceUrl(detail.invoice_pdf);
   if(paid){const payment=(detail.payments?.data||[]).find(item=>item?.payment?.payment_intent)?.payment?.payment_intent;let intent=typeof payment==='object'?payment:null;const intentId=stripeId(payment);if(intentId&&!safeInvoiceUrl(intent?.latest_charge?.receipt_url))intent=await get(`payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge`);invoice.receipt_url=safeInvoiceUrl(intent?.latest_charge?.receipt_url);}
  }else if(id.startsWith('cs_')&&['payment_succeeded','credit_topup_succeeded'].includes(kind)){
   const session=await get(`checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge`);let intent=session.payment_intent;const intentId=stripeId(intent);if(intentId&&!safeInvoiceUrl(intent?.latest_charge?.receipt_url))intent=await get(`payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge`);invoice.receipt_url=safeInvoiceUrl(intent?.latest_charge?.receipt_url);
  }
 }catch(error){failed=true;console.error('Supporter billing links are unavailable',{invoiceId:id,kind,errorName:error?.name||'Error'});}
 invoice.link_lookup_failed=failed;return invoice;
}
export async function sendBillingNotification(env,db,kind,invoice,retryAt=null,suspendAt=null){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id;if(!customer)return;
 const account=await db.prepare(`SELECT a.billing_email FROM supporter_accounts a JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id WHERE b.customer_id=?`).bind(customer).first();
 if(!account?.billing_email)return;
 const now=Math.floor(Date.now()/1000),invoiceId=clean(invoice.id);if(!invoiceId)return;
 await db.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,updated_at) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING`).bind(invoiceId,kind,now).run();
 const notice=await db.prepare('SELECT status,attempts,last_error,updated_at FROM supporter_billing_notifications WHERE invoice_id=? AND kind=?').bind(invoiceId,kind).first();if(notice?.status==='sent'||Number(notice?.attempts)>=5)return;
 const claim=await db.prepare(`UPDATE supporter_billing_notifications SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=?
  WHERE invoice_id=? AND kind=? AND (status IN ('pending','failed') OR (status='sending' AND updated_at<=?))`).bind(now,invoiceId,kind,now-300).run();
 if(!claim.meta?.changes)return;
 const linked=await enrichBillingLinks(env,kind,invoice);
 const content=billingMailContent(env,kind,linked,retryAt,suspendAt,now);
 try{
  await env.NOTICE_EMAIL.send({to:account.billing_email,from:{email:clean(env.NOTICE_FROM_EMAIL),name:'DPI-Bot'},subject:content.subject,text:content.text,html:mailHtml(content.text),...(clean(env.NOTICE_REPLY_TO_EMAIL)?{replyTo:clean(env.NOTICE_REPLY_TO_EMAIL)}:{}),headers:{'Auto-Submitted':'auto-generated','Content-Language':'ja','X-DPI-Mail-Type':`supporter-${kind}`}});
 }catch(error){
  const firstFailed=String(notice?.last_error||'').match(/^(\d+):/)?.[1]||String(now);
  await db.prepare(`UPDATE supporter_billing_notifications SET status='failed',last_error=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(`${firstFailed}:${clean(error?.code||error?.name||'unknown')}`.slice(0,80),now,invoiceId,kind).run();
  throw Object.assign(error,{billingEmailFailure:true});
 }
 // 送れた後の記録だけの失敗では、失敗扱いにしない（同じメールを送り直さない）。
 try{await db.prepare(`UPDATE supporter_billing_notifications SET status='sent',sent_at=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(now,now,invoiceId,kind).run();}
 catch(error){console.error('Supporter billing email was sent but not recorded',{invoiceId,kind,errorName:error?.name||'Error'});}
}
async function sendBillingNotificationSafely(env,db,kind,invoice,retryAt=null,suspendAt=null){
 try{await sendBillingNotification(env,db,kind,invoice,retryAt,suspendAt);}
 catch(error){
  if(!error?.billingEmailFailure)throw error;
  console.error('Supporter billing email failed',{invoiceId:clean(invoice?.id),kind,errorName:error?.name||'Error'});
 }
}
function disciplinaryMailContent(env,kind,details,sentAt){
 const reason=clean(details.reason)||'管理上の措置';
 const credits=Math.max(0,Number(details.confiscatedCredits)||0).toLocaleString('ja-JP');
 const canceled=Math.max(0,Number(details.canceledSubscriptions)||0).toLocaleString('ja-JP');
 const definitions={
  disciplinary_cancel:['【DPI-Bot】有料プラン契約解除のお知らせ',[
   '管理上の措置として、有料プランの契約を即時解除しました。',
   `解除した契約: ${canceled}件`,`没収クレジット: ${credits}クレジット`,`理由: ${reason}`,
   '返金は行われません。再度お支払いいただくことで、有料プランへお申込みいただけます。',
  ]],
  ban_account:['【DPI-Bot】有料プランアカウント停止のお知らせ',[
   '管理上の措置として、有料プランアカウントを停止しました。',
   `解除した契約: ${canceled}件`,`没収クレジット: ${credits}クレジット`,`理由: ${reason}`,
   '返金は行われません。アカウント停止中は、すべての有料プランへの申込み、クレジットチャージ、契約変更および通知設定を利用できません。',
  ]],
  unban_account:['【DPI-Bot】有料プランアカウント停止解除のお知らせ',[
   '有料プランアカウントの停止を解除しました。',`理由: ${reason}`,
   '有料プランを利用する場合は、改めてプランを選択してお申込みください。',
  ]],
 };
 const [subject,lines]=definitions[kind]||[];if(!subject)fail('通知メール種別を確認できません。',500);
 return{subject,text:['DPI-Bot 有料プランの利用者の方へ、大切なお知らせです。','',...lines,'',`通知番号: discipline:${clean(details.requestId)}`,`送信日時（日本時間）: ${mailDate(sentAt)}`,'',supporterMailSignature()].join('\n')};
}
export async function sendSupporterDisciplinaryNotification(env,db,kind,details){
 const requestId=clean(details.requestId),uid=clean(details.uid),email=clean(details.email);
 if(!requestId||!uid||!email||!env.NOTICE_EMAIL||!clean(env.NOTICE_FROM_EMAIL))return false;
 const noticeId=`discipline:${requestId}`,now=Math.floor(Date.now()/1000);
 await db.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,updated_at) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING`).bind(noticeId,kind,now).run();
 const notice=await db.prepare('SELECT status FROM supporter_billing_notifications WHERE invoice_id=? AND kind=?').bind(noticeId,kind).first();if(notice?.status==='sent')return true;
 const claim=await db.prepare(`UPDATE supporter_billing_notifications SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=?
  WHERE invoice_id=? AND kind=? AND (status IN ('pending','failed') OR (status='sending' AND updated_at<=?))`).bind(now,noticeId,kind,now-300).run();
 if(!claim.meta?.changes)return notice?.status==='sent';
 const content=disciplinaryMailContent(env,kind,details,now);
 try{
  await env.NOTICE_EMAIL.send({to:email,from:{email:clean(env.NOTICE_FROM_EMAIL),name:'DPI-Bot'},subject:content.subject,text:content.text,html:mailHtml(content.text),...(clean(env.NOTICE_REPLY_TO_EMAIL)?{replyTo:clean(env.NOTICE_REPLY_TO_EMAIL)}:{}),headers:{'Auto-Submitted':'auto-generated','Content-Language':'ja','X-DPI-Mail-Type':`supporter-${kind}`}});
  await db.prepare(`UPDATE supporter_billing_notifications SET status='sent',sent_at=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(now,now,noticeId,kind).run();
  return true;
 }catch(error){await db.prepare(`UPDATE supporter_billing_notifications SET status='failed',last_error=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(clean(error?.code||error?.name||'unknown').slice(0,80),now,noticeId,kind).run();throw error;}
}
async function recordInvoicePaid(env,db,invoice){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id,invoiceId=clean(invoice.id);if(!customer||!invoiceId||!invoiceSubscriptionId(invoice))return;
 const previous=await db.prepare('SELECT status,retry_at,suspend_at FROM supporter_dunning WHERE invoice_id=?').bind(invoiceId).first();const now=Math.floor(Date.now()/1000);
 // 一度停止したら、未払いの請求書がすべて支払われるまで再開しない。残りの請求書も停止扱いにしてから、この分を支払い済みにする。
 if(previous?.status==='suspended')await db.prepare(`UPDATE supporter_dunning SET status='suspended',suspended_at=?,updated_at=?
  WHERE customer_id=? AND invoice_id<>? AND status IN ('retry_scheduled','retrying','suspend_scheduled')`).bind(now,now,customer,invoiceId).run();
 await db.prepare(`UPDATE supporter_dunning SET status='paid',paid_at=?,suspended_at=NULL,updated_at=? WHERE invoice_id=?`).bind(now,now,invoiceId).run();
 if(previous?.status==='suspended'){
  await resumeServicePause(env,db,customer);
  try{await releaseServiceHolds(env,db,await customerSubscriptionSummaries(env,customer));}
  catch(error){console.error('Supporter hold release failed; the billing schedule retries it',{errorName:error?.name||'Error'});}
 }
 await sendBillingNotificationSafely(env,db,previous?'retry_succeeded':'payment_succeeded',invoice,previous?.retry_at,previous?.suspend_at);
}
async function recordInvoiceFailed(env,db,invoice){
 const customer=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id,invoiceId=clean(invoice.id),subscriptionId=invoiceSubscriptionId(invoice);
 if(!customer||!invoiceId||!subscriptionId||invoice.billing_reason!=='subscription_cycle')return;
 const now=Math.floor(Date.now()/1000),schedule=dunningSchedule(Number(invoice.created)||now);
 const existing=await db.prepare('SELECT status,retry_attempted_at FROM supporter_dunning WHERE invoice_id=?').bind(invoiceId).first();
 // 当サイトの契約者ではない顧客（同じ Stripe アカウントの別の請求）には関わらない。
 if(!await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(customer).first())return;
 // 支払い済み・終了した請求書への遅れた失敗通知では状態を戻さない。停止中の手動支払いの失敗で配信を再開させない。
 if(['paid','closed','suspended'].includes(existing?.status))return;
 let current;
 try{current=await stripe(env,`invoices/${encodeURIComponent(invoiceId)}`,{auto_advance:'false'},`dpi-disable-auto-retry-${invoiceId}`);}
 catch(error){
  // 支払い済み・取り消し済みの請求書は更新できない（400）。遅れて届いた失敗通知かどうかを、今の状態で確かめる。
  if(error?.stripeStatus!==400)throw error;
  current=await stripe(env,`invoices/${encodeURIComponent(invoiceId)}`);
  if(!['paid','void','uncollectible'].includes(current?.status))throw error;
 }
 if(['paid','void','uncollectible'].includes(current?.status))return;
 // 月末の再決済が済んだ後の失敗だけを最終失敗にする。月末より前の手動支払いの失敗では、月末の再決済を取り消さない。
 if(existing?.retry_attempted_at){
  await db.prepare(`UPDATE supporter_dunning SET status='suspend_scheduled',updated_at=? WHERE invoice_id=? AND status IN ('retry_scheduled','retrying','suspend_scheduled')`).bind(now,invoiceId).run();
  return sendBillingNotificationSafely(env,db,'final_failed',invoice,schedule.retryAt,schedule.suspendAt);
 }
 await db.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at)
  VALUES(?,?,?,?,?,'retry_scheduled',?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET amount_due=excluded.amount_due,currency=excluded.currency,retry_at=excluded.retry_at,suspend_at=excluded.suspend_at,updated_at=excluded.updated_at`).bind(invoiceId,customer,subscriptionId,Number(invoice.amount_due||invoice.total||0),clean(invoice.currency||'jpy'),now,schedule.retryAt,schedule.suspendAt,now).run();
 return sendBillingNotificationSafely(env,db,'payment_failed',invoice,schedule.retryAt,schedule.suspendAt);
}
// Stripe list endpoints are paginated. A partial list must never be treated as
// "no subscription" / "zero credits": callers keep their last known state on error.
export const STRIPE_LIST_MAX_PAGES=200;
export async function stripeListAll(env,path,onItem,maxPages=STRIPE_LIST_MAX_PAGES){
 const separator=path.includes('?')?'&':'?';let startingAfter='';
 for(let page=0;page<maxPages;page++){
  const result=await stripe(env,startingAfter?`${path}${separator}starting_after=${encodeURIComponent(startingAfter)}`:path);
  if(!Array.isArray(result?.data))fail('Stripeの一覧を最後まで取得できませんでした。',502);
  for(const item of result.data)onItem(item);
  if(!result.has_more)return;
  const last=result.data.at(-1)?.id;
  if(!last)fail('Stripeの一覧を最後まで取得できませんでした。',502);
  startingAfter=last;
 }
 console.error('Stripe list exceeded the page limit',{path:path.split('?')[0],maxPages});
 fail('Stripeの一覧が上限件数を超えたため、最新の状態を確定できませんでした。',502);
}
export async function creditsByCustomer(env,customers){
 const wanted=new Set((customers||[]).filter(Boolean));
 const resultMap=new Map([...wanted].map(customer=>[customer,0]));
 if(!wanted.size||!billingReady(env))return resultMap;
 await stripeListAll(env,'customers?limit=100',customer=>{if(wanted.has(customer.id))resultMap.set(customer.id,creditsFromBalance(customer.balance));});
 return resultMap;
}
export function selection(input){
 const channelPacks=input.channelPacks??input.packs??0;
 const serverPacks=input.serverPacks??0;
 const rulePacks=input.rulePacks??0;
 const definition=PLAN_CATALOG[input.plan];
 if(!definition||!Number.isInteger(channelPacks)||channelPacks<0||channelPacks>5||!Number.isInteger(serverPacks)||serverPacks<0||serverPacks>5||!Number.isInteger(rulePacks)||rulePacks<0||rulePacks>5)fail('プランまたは追加オプション数が不正です。');
 return {plan:input.plan,packs:channelPacks,channelPacks,serverPacks,rulePacks,baseMonthly:definition.yen,monthly:definition.yen+200*(channelPacks+serverPacks+rulePacks),channels:definition.channels+3*channelPacks,servers:definition.servers+2*serverPacks,rules:definition.rules+3*rulePacks,complexConditions:definition.complexConditions,multiDestination:definition.multiDestination};
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
async function allSubscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data||[];}
function liveSubscriptions(list){return (list||[]).filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
async function subscriptions(env,customer){return liveSubscriptions(await allSubscriptions(env,customer));}
// 初回決済の Checkout から既に契約を作ったか（解約済みの契約も含めて判定）。
// 作った後に解約された Checkout を「Webhook 取りこぼし」とみなして契約を作り直さないための判定。
export function checkoutConsumed(allSubs,session){
 const id=clean(session?.id),created=Number(session?.created||0);
 return (allSubs||[]).some(s=>(id&&(s?.metadata?.dpi_initial_session===id||s?.metadata?.dpi_custom_initial_session===id))||(created>0&&Number(s?.created||0)>=created));
}
async function checkoutDiscipline(db,uid,session){
 if(!db||!uid)return null;
 const account=await db.prepare('SELECT account_status FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 if(account?.account_status==='suspended')return{action:'ban_account',completed_at:Math.floor(Date.now()/1000)};
 const latest=await db.prepare(`SELECT action,completed_at FROM supporter_disciplinary_actions
  WHERE discord_user_id=? AND status='completed' AND action IN ('disciplinary_cancel','ban_account')
  ORDER BY completed_at DESC LIMIT 1`).bind(uid).first();
 return latest&&Number(session?.created||0)<=Number(latest.completed_at||0)?latest:null;
}
export async function rejectDisciplinedCheckout(env,db,session){
 const metadata=checkoutMetadata(session),uid=clean(metadata.dpi_user||session?.client_reference_id);
 if(!await checkoutDiscipline(db,uid,session))return false;
 const sessionId=clean(session?.id),paymentIntent=clean(stripeId(session?.payment_intent)),now=Math.floor(Date.now()/1000);
 if(session?.payment_status==='paid'&&paymentIntent)await stripe(env,'refunds',{payment_intent:paymentIntent,reason:'requested_by_customer','metadata[dpi_user]':uid,'metadata[dpi_reason]':'disciplinary_checkout_rejection'},`dpi-discipline-checkout-refund-${sessionId}`);
 await db.batch([
  db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL,dirty=1 WHERE checkout_id=?').bind(sessionId),
  db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=? WHERE checkout_session_id=? AND status='pending'`).bind(now,sessionId),
 ]);
 return true;
}
export async function expireSupporterPendingCheckouts(env,db,uid,requestId){
 const billing=await db.prepare('SELECT checkout_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const topups=await db.prepare(`SELECT checkout_session_id FROM supporter_credit_topups WHERE discord_user_id=? AND status='pending' AND checkout_session_id IS NOT NULL LIMIT 20`).bind(uid).all();
 // カスタムプランの初回決済・差額決済の支払いURLも、処分後に支払われないよう失効させる。
 const custom=await db.prepare(`SELECT stripe_checkout_id FROM supporter_custom_plans WHERE discord_user_id=? AND status='offered' AND stripe_checkout_id IS NOT NULL`).bind(uid).first();
 const changes=await db.prepare(`SELECT checkout_session_id FROM supporter_custom_plan_changes WHERE discord_user_id=? AND status='pending' AND checkout_session_id IS NOT NULL LIMIT 20`).bind(uid).all();
 const ids=[...new Set([clean(billing?.checkout_id),clean(custom?.stripe_checkout_id),...(changes.results||[]).map(row=>clean(row.checkout_session_id)),...(topups.results||[]).map(row=>clean(row.checkout_session_id))].filter(Boolean))];let expired=0;
 for(const id of ids){
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(id)}`);
  if(session.status==='open'){await stripe(env,`checkout/sessions/${encodeURIComponent(id)}/expire`,{},`dpi-discipline-expire-${requestId}-${id}`);expired+=1;}
 }
 const now=Math.floor(Date.now()/1000);
 await db.batch([
  db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL,dirty=1 WHERE discord_user_id=?').bind(uid),
  db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=? WHERE discord_user_id=? AND status='pending'`).bind(now,uid),
  db.prepare(`UPDATE supporter_custom_plans SET stripe_checkout_id=NULL,checkout_expires_at=NULL,updated_at=? WHERE discord_user_id=? AND status='offered' AND stripe_checkout_id IS NOT NULL`).bind(new Date(now*1000).toISOString(),uid),
  db.prepare(`UPDATE supporter_custom_plan_changes SET status='canceled',updated_at=? WHERE discord_user_id=? AND status='pending'`).bind(new Date(now*1000).toISOString(),uid),
 ]);
 return expired;
}
function checkoutMetadata(session){return session?.metadata&&typeof session.metadata==='object'?session.metadata:{};}
export function paidCheckoutSubscriptionParams(env,session,paymentIntent,now=Math.floor(Date.now()/1000)){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='initial_subscription'||session.payment_status!=='paid')return null;
 const customer=typeof session.customer==='string'?session.customer:session.customer?.id;
 const paymentMethod=typeof paymentIntent?.payment_method==='string'?paymentIntent.payment_method:paymentIntent?.payment_method?.id;
 if(!customer||!paymentMethod)fail('初回決済の支払方法を確認できませんでした。',502);
 const choice=selection({plan:metadata.dpi_plan,channelPacks:Number(metadata.dpi_channel_packs),serverPacks:Number(metadata.dpi_server_packs),rulePacks:Number(metadata.dpi_rule_packs||0)});
 let anchor=Number(metadata.dpi_billing_anchor);
 if(!Number.isInteger(anchor)||anchor<=now+60)anchor=billingSchedule(now*1000).anchor;
 const params={customer,default_payment_method:paymentMethod,collection_method:'charge_automatically',billing_cycle_anchor:String(anchor),proration_behavior:'none','billing_mode[type]':'flexible',
  'items[0][price]':planPrice(env,choice.plan),'items[0][quantity]':'1',
  'metadata[dpi_user]':String(metadata.dpi_user||session.client_reference_id||''),'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':String(metadata.dpi_legal_consent_version||''),
  'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_rule_packs]':String(choice.rulePacks)};
 const optionPacks=choice.channelPacks+choice.serverPacks+choice.rulePacks;
 if(optionPacks){params['items[1][price]']=env.STRIPE_PRICE_ADDON;params['items[1][quantity]']=String(optionPacks);}
 return params;
}
export function creditSignupSubscriptionParams(env,customer,uid,choice,schedule,legalConsentVersion,requestId){
 const params={customer,collection_method:'charge_automatically',billing_cycle_anchor:String(schedule.anchor),proration_behavior:'none',payment_behavior:'error_if_incomplete','billing_mode[type]':'flexible',
  'items[0][price]':planPrice(env,choice.plan),'items[0][quantity]':'1',
  'metadata[dpi_user]':String(uid),'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':String(legalConsentVersion),
  'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_rule_packs]':String(choice.rulePacks),
  'metadata[dpi_initial_payment_method]':'credit_balance','metadata[dpi_credit_signup_request_id]':String(requestId)};
 const optionPacks=choice.channelPacks+choice.serverPacks+choice.rulePacks;
 if(optionPacks){params['items[1][price]']=env.STRIPE_PRICE_ADDON;params['items[1][quantity]']=String(optionPacks);}
 return params;
}
// 支払った顧客が、申し込んだ利用者のものであることを D1 で確かめる（チャージと同じ）。食い違うときは契約を作らない。
async function assertCheckoutOwner(db,session){
 const uid=clean(checkoutMetadata(session).dpi_user||session?.client_reference_id),customer=clean(stripeId(session?.customer));
 const billing=uid?await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first():null;
 if(billing?.customer_id&&billing.customer_id!==customer)fail('初回決済の利用者を確認できませんでした。',409);
}
// 申込みで先に使う事前チャージの額。カードの最低請求額（50円）を残す。全額を払えるときはカードを使わない別の流れ。
export const CARD_MINIMUM_YEN=50;
export function initialCreditUse(credits,total){
 const available=Math.max(0,Math.floor(Number(credits)||0));
 if(available<=0||available>=total)return 0;
 return Math.max(0,Math.min(available,total-CARD_MINIMUM_YEN));
}
// カードの支払いが済んだ申込みの、事前チャージで払う分を1回だけ引き落とす。同じ支払いの通知が何度届いても増えない。
// 支払いまでの間に残高が減っていたら、足りない分は残高のマイナス（次回の請求に加算）になる。
async function applyInitialCredit(env,session){
 const metadata=checkoutMetadata(session),amount=Number(metadata.dpi_credit_applied||0),customer=stripeId(session?.customer);
 if(!customer||!Number.isSafeInteger(amount)||amount<=0)return;
 let applied=false;
 await stripeListAll(env,`customers/${encodeURIComponent(customer)}/balance_transactions?limit=100`,item=>{if(item?.metadata?.dpi_initial_credit_session===session.id)applied=true;});
 if(applied)return;
 const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{amount:String(amount),currency:'jpy',description:`DPI-Bot initial plan credit: ${session.id}`,
  'metadata[dpi_user]':clean(metadata.dpi_user),'metadata[dpi_credit_action]':'initial_plan_credit','metadata[dpi_initial_credit_session]':session.id},`dpi-initial-credit-${session.id}`);
 if(Number(transaction?.ending_balance)>0)console.error('Initial plan credit exceeded the balance',{sessionId:session.id,shortage:Number(transaction.ending_balance)});
}
// 事前チャージの履歴に1回だけ記録し、台帳を残高に合わせる。
async function recordInitialCredit(env,db,session){
 const metadata=checkoutMetadata(session),amount=Number(metadata.dpi_credit_applied||0),uid=clean(metadata.dpi_user),customer=stripeId(session?.customer);
 if(!customer||!/^\d{17,20}$/.test(uid)||!Number.isSafeInteger(amount)||amount<=0)return;
 const credits=await customerCredits(env,customer);
 await db.prepare(`INSERT INTO supporter_credit_events(id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
  VALUES(?,?,?,?,?,'initial_plan_credit','user',?) ON CONFLICT DO NOTHING`).bind(`initial:${session.id}`,uid,-amount,credits,`initial:${session.id}`,new Date().toISOString()).run();
 await purchasedCreditStatus(db,uid,credits);
}
// 開いたままの支払い画面を取り消して記録を消す。支払いの途中なら取り消せず、そのまま残す。
async function discardOpenCheckout(env,db,uid,row){
 if(!row?.checkout_id)return;
 const checkout=await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`);
 if(checkout.status==='open')await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}/expire`,{});
 else if(checkout.status==='complete')fail('決済結果を確認中です。契約状態を更新してください。',409);
 await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();
}
export async function provisionPaidCheckoutSubscription(env,session){
 const metadata=checkoutMetadata(session);
 if(session?.mode!=='payment'||metadata.dpi_checkout_kind!=='initial_subscription'||session.payment_status!=='paid')return null;
 const customer=typeof session.customer==='string'?session.customer:session.customer?.id;
 if(!customer)fail('初回決済の顧客情報を確認できませんでした。',502);
 const all=await allSubscriptions(env,customer),existing=liveSubscriptions(all);
 if(existing.length)return existing[0];
 // 解約済みの契約がこの Checkout 以降に作られていれば、もう使用済み。Webhook の再送や
 // 冪等キー（24時間）切れの後に、解約した人へ新しい月額契約を作らない。
 if(checkoutConsumed(all,session))return null;
 const paymentIntentId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
 if(!paymentIntentId)fail('初回決済情報を確認できませんでした。',502);
 const paymentIntent=await stripe(env,`payment_intents/${encodeURIComponent(paymentIntentId)}`);
 const params=paidCheckoutSubscriptionParams(env,session,paymentIntent);
 params['metadata[dpi_initial_session]']=String(session.id||'');
 await applyInitialCredit(env,session);
 return await stripe(env,'subscriptions',params,`dpi-initial-subscription-v2-${session.id}`);
}
function recoverablePaidCheckout(session,customer,uid){
 const metadata=checkoutMetadata(session);
 const sessionCustomer=typeof session?.customer==='string'?session.customer:session?.customer?.id;
 return session?.mode==='payment'&&session?.status==='complete'&&session?.payment_status==='paid'&&metadata.dpi_checkout_kind==='initial_subscription'&&sessionCustomer===customer&&String(metadata.dpi_user||session.client_reference_id||'')===String(uid);
}
export async function reconcilePaidCheckoutSubscription(env,customer,uid,db=null){
 if(!customer||!uid||!billingReady(env))return {subscription:null,recovered:false,checkoutId:null};
 const all=await allSubscriptions(env,customer),existing=liveSubscriptions(all);
 if(existing.length)return {subscription:existing[0],recovered:false,checkoutId:null};
 const result=await stripe(env,`checkout/sessions?customer=${encodeURIComponent(customer)}&limit=20`);
 // 既に契約を作った（その後に解約・処分された）Checkout は復旧の対象外。返金判定にも回さない。
 const unconsumed=(result.data||[]).filter(item=>!checkoutConsumed(all,item));
 if(db){
  const custom=unconsumed.filter(item=>
   item.mode==='payment'&&item.status==='complete'&&item.payment_status==='paid'
   &&checkoutMetadata(item).dpi_checkout_kind==='custom_subscription_initial'
   &&stripeId(item.customer)===customer&&checkoutMetadata(item).dpi_user===uid)
   .sort((a,b)=>Number(b.created||0)-Number(a.created||0));
  for(const item of custom){
   if(await rejectDisciplinedCheckout(env,db,item))continue;
   let sub=null;
   // 停止・再提示されたカスタムプランの古い決済で 409 が出ても、契約画面（status）全体を止めない。
   try{sub=await provisionCustomPaidCheckoutSubscription(env,db,item);}
   catch(error){console.error('Custom checkout recovery skipped',{sessionId:clean(item?.id),status:error?.status||null});continue;}
   if(sub){
    await syncCustomWithStripe(db,uid,customer,await customerSubscriptionSummaries(env,customer));
    return {subscription:sub,recovered:true,checkoutId:item.id};
   }
  }
 }
 const candidates=unconsumed.filter(item=>recoverablePaidCheckout(item,customer,uid)).sort((a,b)=>Number(b.created||0)-Number(a.created||0));
 let session=null;for(const candidate of candidates){if(db&&await rejectDisciplinedCheckout(env,db,candidate))continue;session=candidate;break;}
 if(!session)return {subscription:null,recovered:false,checkoutId:null};
 const subscription=await provisionPaidCheckoutSubscription(env,session);
 if(subscription&&db)await recordInitialCredit(env,db,session);
 return {subscription,recovered:!!subscription,checkoutId:session.id};
}
function sameCreditSignup(attempt,customer,choice,legalConsentVersion){
 return attempt?.customer_id===customer&&attempt?.plan_id===choice.plan&&Number(attempt?.channel_packs)===choice.channelPacks&&Number(attempt?.server_packs)===choice.serverPacks&&Number(attempt?.rule_packs??0)===choice.rulePacks&&Number(attempt?.amount)>0&&Number(attempt?.billing_anchor)>0&&attempt?.legal_consent_version===legalConsentVersion;
}
function creditSignupSubscription(list,requestId){
 return (list||[]).find(subscription=>String(subscription?.metadata?.dpi_credit_signup_request_id||'')===String(requestId));
}
async function completeCreditSignup(db,attempt,subscription,transaction,amount,balanceAfter,now){
 const statements=[db.prepare(`UPDATE supporter_credit_signups SET balance_transaction_id=COALESCE(balance_transaction_id,?),subscription_id=?,status='provisioned',updated_at=? WHERE request_id=?`).bind(transaction?.id||null,subscription.id,now,attempt.request_id)];
 if(transaction?.id)statements.push(db.prepare(`INSERT INTO supporter_credit_events
  (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
  VALUES(?,?,?,?,?,'initial_plan_payment','user',?) ON CONFLICT DO NOTHING`).bind(`credit-signup:${attempt.request_id}`,attempt.discord_user_id,-amount,balanceAfter,transaction.id,new Date(now*1000).toISOString()));
 await db.batch(statements);
}
export async function provisionCreditFundedSignup(env,db,uid,customer,choice,input={}){
 const requestedId=clean(input.requestId),legalConsentVersion=clean(input.legalConsentVersion);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId))fail('申込み情報が正しくありません。再読み込みしてください。',400);
 if(!legalConsentVersion)fail('申込み同意を確認できません。画面を再読み込みしてください。',400);
 let schedule=billingSchedule(),amount=choice.monthly*schedule.initialMonths;const now=Math.floor(Date.now()/1000);
 let attempt=await db.prepare('SELECT * FROM supporter_credit_signups WHERE request_id=?').bind(requestedId).first();
 if(attempt&&!sameCreditSignup(attempt,customer,choice,legalConsentVersion))fail('別の条件でクレジット申込みを処理済みです。',409);
 if(attempt){amount=Number(attempt.amount);schedule={...schedule,anchor:Number(attempt.billing_anchor),initialMonths:Math.max(1,Math.round(amount/choice.monthly)),lateMonth:amount>choice.monthly};}
 if(attempt?.status==='provisioned'){
  const list=await subscriptions(env,customer),subscription=creditSignupSubscription(list,attempt.request_id)||list.find(item=>item.id===attempt.subscription_id);
  if(subscription)return {subscription,amount,balanceAfter:await customerCredits(env,customer),requestId:attempt.request_id,recovered:true};
 }
 if(['failed','refunded'].includes(attempt?.status))fail('前回のクレジット申込みは完了しませんでした。残高を確認して、もう一度お申し込みください。',409);
 if(!attempt){
  const active=await db.prepare(`SELECT * FROM supporter_credit_signups WHERE discord_user_id=? AND status IN ('pending','debited') ORDER BY created_at DESC LIMIT 1`).bind(uid).first();
  if(active){
   if(!sameCreditSignup(active,customer,choice,legalConsentVersion))fail('別のクレジット申込みを処理中です。少し待って契約情報を再読み込みしてください。',409);
   attempt=active;amount=Number(active.amount);schedule={...schedule,anchor:Number(active.billing_anchor),initialMonths:Math.max(1,Math.round(amount/choice.monthly)),lateMonth:amount>choice.monthly};
  }else{
   try{
    await db.prepare(`INSERT INTO supporter_credit_signups
     (request_id,discord_user_id,customer_id,plan_id,channel_packs,server_packs,rule_packs,amount,billing_anchor,legal_consent_version,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(requestedId,uid,customer,choice.plan,choice.channelPacks,choice.serverPacks,choice.rulePacks,amount,schedule.anchor,legalConsentVersion,now,now).run();
    attempt=await db.prepare('SELECT * FROM supporter_credit_signups WHERE request_id=?').bind(requestedId).first();
   }catch(error){
    attempt=await db.prepare(`SELECT * FROM supporter_credit_signups WHERE discord_user_id=? AND status IN ('pending','debited') ORDER BY created_at DESC LIMIT 1`).bind(uid).first();
    if(!attempt||!sameCreditSignup(attempt,customer,choice,legalConsentVersion))throw error;
    amount=Number(attempt.amount);schedule={...schedule,anchor:Number(attempt.billing_anchor),initialMonths:Math.max(1,Math.round(amount/choice.monthly)),lateMonth:amount>choice.monthly};
   }
  }
 }
 const before=await subscriptions(env,customer),recoveredBefore=creditSignupSubscription(before,attempt.request_id);
 if(recoveredBefore){
  const balanceAfter=await customerCredits(env,customer);
  await completeCreditSignup(db,attempt,recoveredBefore,attempt.balance_transaction_id?{id:attempt.balance_transaction_id}:null,amount,balanceAfter,now);
  return {subscription:recoveredBefore,amount,balanceAfter,requestId:attempt.request_id,recovered:true};
 }
 if(before.length){await db.prepare(`UPDATE supporter_credit_signups SET status='failed',updated_at=? WHERE request_id=? AND status='pending'`).bind(now,attempt.request_id).run();fail('契約が存在します。「プラン・オプションを更新」をご利用ください。',409);}
 // 前回この申込みで引き落とし済み（debited）なら、もう一度引き落とさず契約作成だけをやり直す。
 // 冪等キーは24時間で切れるため、再引き落としすると二重に減る。
 const alreadyDebited=attempt.status==='debited'&&!!attempt.balance_transaction_id;
 if(!alreadyDebited){
  const credits=await customerCredits(env,customer);
  if(credits<amount){await db.prepare(`UPDATE supporter_credit_signups SET status='failed',updated_at=? WHERE request_id=? AND status='pending'`).bind(now,attempt.request_id).run();fail(`クレジット残高が不足しています。申込みには${amount.toLocaleString('ja-JP')}クレジット必要です。`,409);}
 }
 let transaction=null;
 try{
  let balanceAfter;
  if(alreadyDebited){
   transaction={id:attempt.balance_transaction_id};
   balanceAfter=await customerCredits(env,customer);
  }else{
   transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
    amount:String(amount),currency:'jpy',description:`DPI-Bot initial plan payment: ${attempt.request_id}`,
    'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'initial_plan_payment','metadata[dpi_credit_signup_request_id]':attempt.request_id,
   },`dpi-credit-signup-debit-${attempt.request_id}`);
   balanceAfter=creditsFromBalance(transaction.ending_balance);
  }
  await db.prepare(`UPDATE supporter_credit_signups SET balance_transaction_id=?,status='debited',updated_at=? WHERE request_id=? AND status IN ('pending','debited')`).bind(transaction.id,now,attempt.request_id).run();
  const params=creditSignupSubscriptionParams(env,customer,uid,choice,schedule,legalConsentVersion,attempt.request_id);
  const subscription=await stripe(env,'subscriptions',params,`dpi-credit-signup-subscription-${attempt.request_id}`);
  if(!['active','trialing'].includes(subscription?.status))fail('クレジット払いによる契約を有効化できませんでした。',409);
  await completeCreditSignup(db,attempt,subscription,transaction,amount,balanceAfter,now);
  try{await sendBillingNotification(env,db,'credit_plan_payment_succeeded',{id:`credit-signup:${attempt.request_id}`,customer,amount_paid:amount,currency:'jpy',next_renewal_at:schedule.anchor});}
  catch(error){console.error('Credit signup email failed',{requestId:attempt.request_id,errorName:error?.name||'Error'});}
  return {subscription,amount,balanceAfter,requestId:attempt.request_id,recovered:false};
 }catch(error){
  // 契約の有無を確認できないときは払い戻さず debited のまま残す（次回の申込みで引き落とし無しに再開できる）。
  let recovered=null;
  try{recovered=creditSignupSubscription(await subscriptions(env,customer),attempt.request_id);}
  catch(lookupError){console.error('Credit signup recovery lookup failed',{requestId:attempt.request_id,errorName:lookupError?.name||'Error'});throw error;}
  if(recovered){
   const balanceAfter=await customerCredits(env,customer);
   const recoveredTransactionId=transaction?.id||attempt.balance_transaction_id;
   await completeCreditSignup(db,attempt,recovered,recoveredTransactionId?{id:recoveredTransactionId}:null,amount,balanceAfter,now);
   return {subscription:recovered,amount,balanceAfter,requestId:attempt.request_id,recovered:true};
  }
  if(transaction){
   const reversal=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
    amount:String(-amount),currency:'jpy',description:`DPI-Bot initial plan payment reversal: ${attempt.request_id}`,
    'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'initial_plan_payment_reversal','metadata[dpi_credit_signup_request_id]':attempt.request_id,
   },`dpi-credit-signup-reversal-${attempt.request_id}`);
   await db.prepare(`UPDATE supporter_credit_signups SET balance_transaction_id=?,status='refunded',updated_at=? WHERE request_id=?`).bind(transaction.id,now,attempt.request_id).run();
   console.warn('Credit signup was reversed',{requestId:attempt.request_id,reversalId:reversal.id});
  }else await db.prepare(`UPDATE supporter_credit_signups SET status='failed',updated_at=? WHERE request_id=? AND status='pending'`).bind(now,attempt.request_id).run();
  throw error;
 }
}
const unix = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function optionPackSummary(metadata={},addonQuantity=0){
 const combined=Number(addonQuantity);
 const channelRaw=clean(metadata.dpi_channel_packs),serverRaw=clean(metadata.dpi_server_packs),ruleRaw=clean(metadata.dpi_rule_packs);
 const channelPacks=channelRaw===''?(serverRaw===''?combined:0):Number(channelRaw);
 const serverPacks=serverRaw===''?0:Number(serverRaw);
 const rulePacks=ruleRaw===''?0:Number(ruleRaw);
 const valid=Number.isInteger(combined)&&combined>=0&&Number.isInteger(channelPacks)&&channelPacks>=0&&channelPacks<=5&&Number.isInteger(serverPacks)&&serverPacks>=0&&serverPacks<=5&&Number.isInteger(rulePacks)&&rulePacks>=0&&rulePacks<=5&&channelPacks+serverPacks+rulePacks===combined;
 return {valid,channelPacks:valid?channelPacks:0,serverPacks:valid?serverPacks:0,rulePacks:valid?rulePacks:0};
}
// 期間末の解約予約。契約の方式により cancel_at_period_end ではなく cancel_at（日時）で予約される。
// 解約の予約中に変更すると、予約が取り消されて課金が続いてしまう。先に利用者自身が解約を取り消す。
const CANCEL_SCHEDULED_MESSAGE='解約を予約中のため、プランを変更できません。「支払方法・解約の管理」で解約の予約を取り消してから、もう一度お試しください。';
function cancelScheduled(subscription){return subscription?.cancel_at_period_end===true||Number(subscription?.cancel_at)>0;}
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
 const {channelPacks,serverPacks,rulePacks}=options;
 const planId=basePrice===env.STRIPE_PRICE_PRO?'pro':basePrice===env.STRIPE_PRICE_PLUS?'plus':basePrice===env.STRIPE_PRICE_SUPPORTER?'supporter':'';
 const recognizedPlan=!!planId&&options.valid;
 const choice=recognizedPlan?selection({plan:planId,channelPacks,serverPacks,rulePacks}):{channels:0,servers:0,rules:0,complexConditions:false,multiDestination:false};
 return {subscriptionId:subscription.id||'',customId:clean(metadata.dpi_custom_id),customRevision:Number(metadata.dpi_custom_revision)||0,status:subscription.status||'unknown',cancelAtPeriodEnd:cancelScheduled(subscription),pauseCollection:!!subscription.pause_collection,servicePause:metadata.dpi_service_pause==='dunning',startedAt:unix(subscription.start_date)||unix(subscription.created),currentPeriodStart,nextRenewalAt,amount:items.reduce((sum,item)=>sum+item.subtotal,0),currency,plan:planId?PLAN_CATALOG[planId].name:'確認が必要な契約',planId,recognizedPlan,configurationValid:options.valid,channelPacks,serverPacks,rulePacks,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination,items,scheduledChange:null};
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
 const {channelPacks,serverPacks,rulePacks}=options;
 const choice=selection({plan:planId,channelPacks,serverPacks,rulePacks});
 if(choice.plan===currentSummary.planId&&choice.channelPacks===currentSummary.channelPacks&&choice.serverPacks===currentSummary.serverPacks&&choice.rulePacks===currentSummary.rulePacks)return null;
 return {effectiveAt:unix(phase.start_date),plan:PLAN_CATALOG[planId].name,planId,monthly:choice.monthly,channels:choice.channels,servers:choice.servers,rules:choice.rules,channelPacks,serverPacks,rulePacks};
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
 await stripeListAll(env,'subscriptions?status=all&limit=100',subscription=>{
  if(['canceled','incomplete_expired'].includes(subscription.status))return;
  const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
  if(wanted.has(customer))grouped.get(customer).push(subscriptionSummary(subscription,env));
 });
 return grouped;
}
// 段階公開の人数の上限（SUPPORTER_SUBSCRIBER_LIMIT。未設定・0 は上限なし）。既に契約がある人の変更・解約には関係しない。
async function subscriberLimitReached(env){
 const limit=Number(env.SUPPORTER_SUBSCRIBER_LIMIT);
 if(!Number.isInteger(limit)||limit<1)return false;
 const customers=new Set();
 await stripeListAll(env,'subscriptions?status=all&limit=100',subscription=>{
  if(!['canceled','incomplete_expired'].includes(subscription.status))customers.add(stripeId(subscription.customer));
 });
 return customers.size>=limit;
}
export async function billingAction(request,env,db,uid,input={}){
 const action=new URL(request.url).pathname.split('/').pop();
 if(!billingReady(env))return json({message:'決済設定が完了していません。'},503);
 const account=await db.prepare('SELECT discord_user_id,billing_email,account_status,status_reason,status_updated_at FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 if(!account)return json({message:'先に登録してください。'},409);
 const customPlan=await getCustomPlan(db,uid);
 const accountEnforcement={suspended:account.account_status==='suspended',status:account.account_status||'active',reason:clean(account.status_reason),updatedAt:account.status_updated_at||null};
 if(accountEnforcement.suspended&&!['status','portal'].includes(action))return json({message:`有料プランアカウントは管理者によりBANされています。${accountEnforcement.reason?` 理由: ${accountEnforcement.reason}`:''}`,accountEnforcement},403);
 await db.prepare('INSERT INTO supporter_billing(discord_user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(uid).run();
 let row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(action==='status'){
  const creditTopupRecovery=await reconcilePendingCreditTopups(env,db,uid,row.customer_id);
  const recovery=await reconcilePaidCheckoutSubscription(env,row.customer_id,uid,db);
  if(recovery.recovered&&recovery.checkoutId)await db.prepare('UPDATE supporter_billing SET checkout_id=?,dirty=1 WHERE discord_user_id=?').bind(recovery.checkoutId,uid).run();
  // A successfully paid change may have lost its webhook acknowledgment.
  // Retry idempotently before exposing the billing state.
  await recoverCustomPriceChanges(env,db,uid);
  const resumed=await reconcileSuspendedInvoices(env,db,row.customer_id,5);
  const [summaries,invoices,credits,dunning]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerInvoices(env,row.customer_id),customerCredits(env,row.customer_id),dunningState(db,row.customer_id)]);
  const unpaidItems=dunning.status?await unpaidInvoices(env,db,row.customer_id):[];
  const unpaidTotal=unpaidItems.reduce((sum,item)=>sum+item.amount,0);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
  await releaseServiceHolds(env,db,summaries);
  const syncedCustom=await syncCustomWithStripe(db,uid,row.customer_id,summaries);
  const effective=enrichCustomSubscriptions(summaries,syncedCustom);
  const pendingCustomChange=await currentCustomChange(db,uid);
  let customChangeCheckoutUrl='';
  if(syncedCustom?.status==='active'&&pendingCustomChange?.status==='pending'){
   try{customChangeCheckoutUrl=await customDifferenceCheckoutUrl(env,row.customer_id,uid,syncedCustom,pendingCustomChange);}
   catch(error){console.error('Custom difference Checkout verification deferred',{errorName:error?.name||'Error'});}
  }
  const active=effective.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
  // Never silently truncate custom-plan rules. Admin must resolve a lowered quota first.
  const rulesAdjustment=active.length&&!effective.some(item=>item.managedCustom)?await reconcileStoredRulesForCustomer(db,row.customer_id,combinedLimits(active)):{changed:false,removedRules:0,removedDestinations:0,simplifiedRules:0};
  let customCheckoutUrl='';
  if(syncedCustom?.status==='offered'&&syncedCustom.stripe_checkout_id){
   try {
    const checkout=await stripe(env,`checkout/sessions/${encodeURIComponent(syncedCustom.stripe_checkout_id)}`);
    const safe=String(checkout.url||'');
    const host=new URL(safe);
    if(checkout.mode==='payment'&&checkout.status==='open'&&Number(checkout.expires_at)>Date.now()/1000
      &&checkout.customer===row.customer_id&&checkout.client_reference_id===uid
      &&checkout.metadata?.dpi_custom_id===syncedCustom.id&&Number(checkout.metadata?.dpi_custom_revision)===Number(syncedCustom.revision)
      &&host.protocol==='https:'&&host.hostname==='checkout.stripe.com')customCheckoutUrl=safe;
   }catch{ /* An unavailable or stale Checkout URL must never be displayed. */ }
  }
  if(resumed)await refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,'invoice_reconciled');
  return json({mode:billingMode(env),billingDay:26,subscriptions:effective,customPlan:customPublic(syncedCustom),customCheckoutUrl,customChange:pendingCustomChange?{requestId:pendingCustomChange.request_id,status:pendingCustomChange.status,oldMonthlyYen:Number(pendingCustomChange.old_monthly_yen),nextMonthlyYen:Number(pendingCustomChange.next_monthly_yen),amountDueYen:Number(pendingCustomChange.amount_due_yen)}:null,customChangeCheckoutUrl,invoices,credits,creditDetails,dunning,unpaid:{count:unpaidItems.length,total:unpaidTotal,payableWithCredits:unpaidItems.length>0&&credits>=unpaidCreditNeeded(unpaidItems)},accountEnforcement,rulesAdjustment,recoveredSubscription:recovery.recovered,creditTopupRecovery,deliveryEnabled:false});
 }
 // カスタムプランは解約だけを利用者が行える（Stripe の解約専用画面）。ほかの変更は管理者へ問い合わせ。
 if(customLocked(customPlan)&&action==='portal')return await customCancellationPortal(env,row.customer_id,customPlan);
 if(action==='portal'&&input.existingOnly===true&&!row.customer_id)return json({message:'契約情報がありません。'},409);
 if(customLocked(customPlan)&&['checkout','update','preview-update'].includes(action))return json({message:'カスタムプランの提供中はユーザー側でプラン変更・標準プラン申込みを行えません。契約内容の変更は管理者へお問い合わせください。',customPlan:customPublic(customPlan)},403);
 if(action==='portal'&&accountEnforcement.suspended&&!row.customer_id)return json({message:'BAN中のため契約管理画面を作成できません。',accountEnforcement},403);
 if(!row.customer_id){const customer=await createBillingCustomer(env,uid,account.billing_email,`dpi-customer-${uid}`);await db.prepare('UPDATE supporter_billing SET customer_id=? WHERE discord_user_id=? AND customer_id IS NULL').bind(customer.id,uid).run();row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();}
 else if(account.billing_email)await stripe(env,`customers/${encodeURIComponent(row.customer_id)}`,{email:account.billing_email},await idempotencyKey(`dpi-customer-email-${uid}-`,account.billing_email));
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin || !/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 if(action==='portal'){const portal=await stripe(env,'billing_portal/sessions',{customer:row.customer_id,configuration:env.STRIPE_PORTAL_CONFIG,return_url:`${origin}/site/supporter/`});return json({url:portal.url});}
 // 契約できない人に、払い戻しのできないクレジットを購入させない。
 if(action==='topup'&&!(await subscriptions(env,row.customer_id)).length&&await subscriberLimitReached(env))return json({message:SUBSCRIBER_LIMIT_MESSAGE},409);
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
    // 上限は24時間。時計のずれで拒否されないよう5分の余裕をみる（ほかの支払い画面も同じ）。
    expires_at:String(now+86400-300),integration_identifier:integrationIdentifier('dpi_credit_'),
   },`dpi-credit-checkout-${requestId}`);
   await db.prepare('UPDATE supporter_credit_topups SET checkout_session_id=?,updated_at=? WHERE request_id=? AND discord_user_id=?').bind(checkout.id,now,requestId,uid).run();
  }
  if(checkout.status==='expired')return json({message:'チャージ用支払いリンクの有効期限が切れました。もう一度作成してください。'},409);
  if(checkout.status!=='open')return json({message:'チャージ決済の反映を確認中です。残高を再読み込みしてください。'},409);
  return json({url:checkout.url,amount,credits:amount,expiresAt:checkout.expires_at||now+86400,mode:billingMode(env)});
 }
 if(action==='pay-unpaid'){
  const requestId=clean(input.requestId),expectedTotal=Number(input.expectedTotal);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||!Number.isSafeInteger(expectedTotal)||expectedTotal<0)return json({message:'支払い情報が正しくありません。もう一度読み込み直してください。'},400);
  const items=await unpaidInvoices(env,db,row.customer_id),total=items.reduce((sum,item)=>sum+item.amount,0);
  if(total!==expectedTotal)return json({message:'金額が変わりました。もう一度確認してください。'},409);
  const available=await customerCredits(env,row.customer_id);
  const needed=unpaidCreditNeeded(items);
  if(available<needed)return json({message:`クレジットが${(needed-available).toLocaleString('ja-JP')}円不足しています。`},409);
  let paidCount=0,paidTotal=0,lastError=null;
  for(const item of items){
   try{const result=await payInvoiceWithCredits(env,db,row.customer_id,uid,item.invoice.id);paidCount+=1;paidTotal+=result.amount;}
   catch(error){lastError=error;break;}
  }
  const [subscriptionsResult,credits,dunning]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerCredits(env,row.customer_id),dunningState(db,row.customer_id)]);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
  return json({message:lastError?`${paidCount}件を支払いました。残りの支払いは完了していません。`:`${paidCount}件の未払いをクレジットで支払いました。`,paidCount,total,paidTotal,credits,subscriptions:subscriptionsResult,dunning,creditDetails,complete:!lastError});
 }
 const choice=selection(input);
 const recovery=await reconcilePaidCheckoutSubscription(env,row.customer_id,uid,db);
 const allExisting=await allSubscriptions(env,row.customer_id),existing=liveSubscriptions(allExisting);
 if(action==='preview-update'){
  const current=activeSubscription(existing);
  if(!current)return json({message:'更新できる契約がありません。先にプランを申し込んでください。'},409);
  if(cancelScheduled(current))return json({message:CANCEL_SCHEDULED_MESSAGE},409);
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
  if(cancelScheduled(current))return json({message:CANCEL_SCHEDULED_MESSAGE},409);
  const preview=await previewSubscriptionUpdate(env,row.customer_id,current,choice,prorationDate);
  if(preview.creditShortage>0)return json({message:`クレジットが${preview.creditShortage.toLocaleString('ja-JP')}円不足しています。チャージしてから、もう一度お試しください。`},409);
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
 if(await subscriberLimitReached(env))return json({message:SUBSCRIBER_LIMIT_MESSAGE},409);
 const schedule=billingSchedule();
 const legalConsentVersion=String(input.legalConsentVersion||'');
 if(!legalConsentVersion)return json({message:'申込み同意を確認できません。画面を再読み込みしてください。'},400);
 if(input.useCredits===true){
  // カードの支払い画面を開いたまま残高で申し込むと、両方で支払えてしまう。先に取り消す。
  await discardOpenCheckout(env,db,uid,row);
  const result=await provisionCreditFundedSignup(env,db,uid,row.customer_id,choice,input);
  const [summaries,credits]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerCredits(env,row.customer_id)]);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
  await reconcileSupporterRolesSafely(env,db,subscriptionSummariesByCustomer,{discordUserId:uid});
  return json({message:`${result.amount.toLocaleString('ja-JP')}クレジットでお申し込みが完了しました。カード情報の入力は不要でした。`,paidWithCredits:true,creditApplied:result.amount,balanceAfter:result.balanceAfter,billingDay:26,subscriptions:summaries,credits,creditDetails,deliveryEnabled:false});
 }
 row=await recoverStaleCheckoutAttempt(db,uid,row);
 const initialTotal=choice.monthly*schedule.initialMonths;
 let creditApplied=0;
 if(input.applyCredits===true){
  const available=await customerCredits(env,row.customer_id);
  if(available>=initialTotal)return json({message:'事前チャージの残高だけで申し込めます。画面を再読み込みして、もう一度お試しください。'},409);
  creditApplied=initialCreditUse(available,initialTotal);
  if(Number(input.expectedCreditApplied)!==creditApplied)return json({message:'事前チャージの残高が変わりました。画面を再読み込みして、もう一度お試しください。'},409);
 }
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'payment',customer:row.customer_id,client_reference_id:uid,...SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS,
  'payment_intent_data[setup_future_usage]':'off_session','payment_intent_data[metadata][dpi_user]':uid,
  'metadata[dpi_checkout_kind]':'initial_subscription','metadata[dpi_user]':uid,'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':legalConsentVersion,'metadata[dpi_channel_packs]':String(choice.channelPacks),
  'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_rule_packs]':String(choice.rulePacks),'metadata[dpi_billing_anchor]':String(schedule.anchor),
  success_url:`${origin}/site/supporter/?checkout=returned`,cancel_url:`${origin}/site/supporter/?checkout=canceled`,expires_at:String(Math.floor(Date.now()/1000)+3600),integration_identifier:integrationIdentifier('dpi_paid_')};
 const line=0;
 params[`line_items[${line}][price_data][currency]`]='jpy';
 params[`line_items[${line}][price_data][unit_amount]`]=String(initialTotal-creditApplied);
 if(creditApplied>0){params['metadata[dpi_credit_applied]']=String(creditApplied);params['metadata[dpi_initial_total]']=String(initialTotal);}
 params[`line_items[${line}][price_data][product_data][name]`]=`${PLAN_CATALOG[choice.plan].name} ${schedule.lateMonth?'初回利用料（当月分・翌月分の2か月分）':'初回利用料（当月分）'}${creditApplied>0?`（総額${initialTotal.toLocaleString('ja-JP')}円のうち事前チャージ${creditApplied.toLocaleString('ja-JP')}円を使用）`:''}`;
 params[`line_items[${line}][quantity]`]='1';
 await db.prepare('UPDATE supporter_billing SET checkout_key=?,checkout_params=? WHERE discord_user_id=? AND checkout_key IS NULL').bind(crypto.randomUUID(),JSON.stringify(params),uid).run();
 row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const saved=JSON.parse(row.checkout_params);
 if(!row.checkout_id && Number(saved.expires_at)<Date.now()/1000)fail('決済作成の状態確認が必要です。管理者へお問い合わせください。',409);
 const checkout=row.checkout_id?await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`):await stripe(env,'checkout/sessions',saved,`dpi-checkout-${row.checkout_key}`);
 await db.prepare('UPDATE supporter_billing SET checkout_id=? WHERE discord_user_id=? AND checkout_key=?').bind(checkout.id,uid,row.checkout_key).run();
 if(checkout.status==='expired'){await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();return json({message:'前の決済画面が期限切れです。再度お試しください。'},409);}
 // 以前の申込み（完了済み・契約作成済み・その後解約）の Checkout が残っていると、解約後の再申込みが
 // 「決済結果を確認中」のまま進めなくなる。使用済みなら記録を消して、もう一度押してもらう。
 if(checkout.status==='complete'&&checkoutConsumed(allExisting,checkout)){
  await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();
  return json({message:'前回のお申込みは完了済みでした。もう一度「申し込む」を押してください。'},409);
 }
 if(checkout.status!=='open')return json({message:'決済結果を確認中です。契約状態を更新してください。'},409);
 if(saved['metadata[dpi_plan]']!==params['metadata[dpi_plan]']||saved['metadata[dpi_channel_packs]']!==params['metadata[dpi_channel_packs]']||saved['metadata[dpi_server_packs]']!==params['metadata[dpi_server_packs]']||String(saved['metadata[dpi_rule_packs]']||0)!==params['metadata[dpi_rule_packs]']||String(saved['metadata[dpi_credit_applied]']||0)!==String(params['metadata[dpi_credit_applied]']||0)){
  // プラン・残高が変わった。前の支払い画面は取り消し、新しい条件で作り直せるようにする。
  await discardOpenCheckout(env,db,uid,row);
  return json({message:'条件が変わったため、前の決済画面を取り消しました。もう一度「申し込む」を押してください。'},409);
 }
 return json({url:checkout.url,mode:billingMode(env)});
}
// 途中で止まった申込みの復旧。Stripe の状態を確かめ、支払い済みなら契約を作り、未払いの支払い画面は失効させてから記録を消す。
export async function recoverCheckoutState(env,db,uid){
 if(!billingReady(env))fail('決済設定が完了していません。',503);
 const row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(!row||(!row.checkout_key&&!row.checkout_id&&!row.checkout_params))return {changed:0,message:'途中の申込みはありませんでした。'};
 const clear=async()=>Number((await db.prepare(`UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=?
  AND COALESCE(checkout_key,'')=COALESCE(?,'') AND COALESCE(checkout_id,'')=COALESCE(?,'')`).bind(uid,row.checkout_key,row.checkout_id).run()).meta?.changes||0);
 if(!row.checkout_id){
  let expires=0;try{expires=Number(JSON.parse(row.checkout_params||'{}').expires_at)||0;}catch{/* 壊れた記録は消してよい */}
  if(expires>Date.now()/1000)fail('支払い画面を作成中の可能性があります。1時間ほど待ってからお試しください。',409);
  return {changed:await clear(),message:'作成されなかった申込みの記録を消しました。'};
 }
 let session;
 try{session=await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`);}
 catch(error){
  if(error?.stripeStatus!==404)throw error;
  return {changed:await clear(),message:'Stripeに存在しない申込みの記録を消しました。'};
 }
 if(stripeId(session.customer)!==row.customer_id)fail('申込みの記録とStripeの顧客が一致しません。',409);
 if(session.status==='open'){
  await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}/expire`,{});
  return {changed:await clear(),message:'未払いの支払い画面を失効させ、申込みの記録を消しました。'};
 }
 if(session.status==='complete'&&session.payment_status!=='paid')fail('支払いの確認待ちです。確認が終わるまでお待ちください。',409);
 if(session.status==='complete'){
  const result=await reconcilePaidCheckoutSubscription(env,row.customer_id,uid,db);
  return {changed:await clear(),message:result.recovered?'支払い済みの申込みから契約を作成しました。':'申込みは反映済みでした。記録を消しました。'};
 }
 return {changed:await clear(),message:'失効した申込みの記録を消しました。'};
}
async function customCancellationPortal(env,customer,plan){
 const subscriptionId=clean(plan?.stripe_subscription_id);
 if(plan?.status!=='active'||!customer||!subscriptionId)return json({message:'解約できるカスタムプランの契約がありません。管理者へお問い合わせください。',customPlan:customPublic(plan)},409);
 const current=await stripe(env,`subscriptions/${encodeURIComponent(subscriptionId)}`);
 if(stripeId(current.customer)!==customer||['canceled','incomplete_expired'].includes(current.status))return json({message:'契約情報を確認できませんでした。管理者へお問い合わせください。'},409);
 if(cancelScheduled(current))return json({message:'解約は予約済みです。取り消しは管理者へお問い合わせください。'},409);
 const returnUrl=`${actionOrigin(env)}/site/supporter/`;
 const portal=await stripe(env,'billing_portal/sessions',{customer,configuration:env.STRIPE_PORTAL_CONFIG,return_url:returnUrl,
  'flow_data[type]':'subscription_cancel','flow_data[subscription_cancel][subscription]':subscriptionId,
  'flow_data[after_completion][type]':'redirect','flow_data[after_completion][redirect][return_url]':returnUrl});
 return json({url:portal.url});
}
function adminChoice(input){
 const plan=String(input.plan||'');
 const channelPacks=Number(input.channelPacks??input.packs);
 const serverPacks=Number(input.serverPacks??0);
 const rulePacks=Number(input.rulePacks??0);
 return selection({plan,channelPacks,serverPacks,rulePacks});
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
 if(currentSummary.planId===choice.plan&&currentSummary.channelPacks===choice.channelPacks&&currentSummary.serverPacks===choice.serverPacks&&currentSummary.rulePacks===choice.rulePacks)fail('プラン・オプションの変更内容がありません。',409);
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
 const customerObject=await stripe(env,`customers/${encodeURIComponent(customer)}`),credits=creditsFromBalance(customerObject.balance);
 const creditUse=creditApplication(credits,changeTiming==='immediate'?planProration:0,choice.monthly);
 const hasPaymentMethod=paymentMethodRegistered(customerObject,current);
 return {
  prorationDate,expiresAt:prorationDate+600,billingDay:26,
  current:{plan:currentSummary.plan,planId:currentSummary.planId,monthly:currentSummary.amount,channels:currentSummary.channels,servers:currentSummary.servers,rules:currentSummary.rules},
  next:{plan:PLAN_CATALOG[choice.plan].name,planId:choice.plan,monthly:choice.monthly,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination},
  monthlyDifference:choice.monthly-currentSummary.amount,
  planChanged,changeTiming,effectiveAt:changeTiming==='next_period'?currentSummary.nextRenewalAt:null,planProration,planProrationBreakdown,
  creditApplied:creditUse.totalCreditApplied,immediateCreditApplied:creditUse.immediateCreditApplied,nextInvoiceCreditApplied:creditUse.nextInvoiceCreditApplied,
  immediateDue:changeTiming==='next_period'?0:creditUse.immediateDue,nextInvoiceSubtotal:choice.monthly,nextInvoiceDue:creditUse.nextInvoiceDue,remainingCreditsAfterNext:creditUse.remainingAfterNext,
  paymentMethodRegistered:hasPaymentMethod,creditShortage:!hasPaymentMethod&&changeTiming!=='next_period'&&creditUse.immediateDue>0?creditUse.immediateDue:0,
  creditGenerated:changeTiming==='next_period'?0:Math.max(0,-planProration),
  optionChange:{currentChannelPacks:currentSummary.channelPacks,nextChannelPacks:choice.channelPacks,currentServerPacks:currentSummary.serverPacks,nextServerPacks:choice.serverPacks,currentRulePacks:currentSummary.rulePacks,nextRulePacks:choice.rulePacks,prorated:false,effectiveAt:currentSummary.nextRenewalAt},
  nextRenewalAt:currentSummary.nextRenewalAt,
  notice:changeTiming==='next_period'?'変更は次回26日から適用され、返金はありません。利用するクレジットは次回の請求に反映します。':'基本プランの差額は日割りで精算します。追加オプションは日割りせず、次回26日分から反映します。利用するクレジットは今回の差額、次回の請求の順に充当します。',
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
 phaseItems(params,1,[{price:planPrice(env,choice.plan),quantity:1},...(choice.channelPacks+choice.serverPacks+choice.rulePacks?[{price:env.STRIPE_PRICE_ADDON,quantity:choice.channelPacks+choice.serverPacks+choice.rulePacks}]:[])]);
 const metadata={dpi_plan:choice.plan,dpi_channel_packs:String(choice.channelPacks),dpi_server_packs:String(choice.serverPacks),dpi_rule_packs:String(choice.rulePacks),...extraMetadata};
 for(const [name,value] of Object.entries(metadata))params[`phases[1][metadata][${name}]`]=String(value);
 return await stripe(env,`subscription_schedules/${encodeURIComponent(schedule.id)}`,params,`${key}-schedule-update`);
}
async function updateSubscription(env,current,choice,key,extra={},prorationDate){
 const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
 const addon=current.items?.data?.find(item=>item.price?.id===env.STRIPE_PRICE_ADDON);
 if(!base?.id)fail('契約項目を確認できませんでした。',409);
 const currentSummary=subscriptionSummary(current,env);
 const optionPacks=choice.channelPacks+choice.serverPacks+choice.rulePacks;
 const currentOptionPacks=currentSummary.channelPacks+currentSummary.serverPacks+currentSummary.rulePacks;
 const baseChanged=currentSummary.planId!==choice.plan;
 const optionsChanged=currentOptionPacks!==optionPacks||currentSummary.channelPacks!==choice.channelPacks||currentSummary.serverPacks!==choice.serverPacks||currentSummary.rulePacks!==choice.rulePacks;
 const metadata={'metadata[dpi_plan]':choice.plan,'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_rule_packs]':String(choice.rulePacks),...extra};
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
 if(['grant_credit','remove_credit','confiscate_credit'].includes(action)){
  const current=await customerCredits(env,customer);
  const amount=action==='confiscate_credit'?current:Number(input.amount);
  if(action==='confiscate_credit'&&(!Number.isSafeInteger(amount)||amount<1))fail('没収できるクレジット残高がありません。',409);
  if(action!=='confiscate_credit'&&(!Number.isInteger(amount)||amount<1||amount>1_000_000))fail('クレジット数を1〜1,000,000で指定してください。',400);
  if(action==='remove_credit'&&amount>current)fail('利用可能クレジットを超えて削除できません。',409);
  const delta=action==='grant_credit'?amount:-amount;
  const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
   amount:String(-delta),currency:'jpy',description:`DPI-Bot ${action==='grant_credit'?'credit grant':action==='confiscate_credit'?'credit confiscation':'credit removal'}: ${reason}`.slice(0,500),
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':action,'metadata[dpi_admin_reason]':reason,
  },key);
  const balanceAfter=creditsFromBalance(transaction.ending_balance);
  const operation=action==='grant_credit'?'付与':action==='confiscate_credit'?'没収':'削除';
  return {message:`${amount.toLocaleString('ja-JP')}クレジットを${operation}しました。`,credits:balanceAfter,creditEvent:{delta,balanceAfter,stripeTransactionId:transaction.id}};
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
  // 初回利用料とカスタムの差額は請求書が無い都度払いなので、あわせて調べて新しい支払いから返金する。
  const candidates=[
   ...invoices.filter(item=>Number(item.amount_paid)>=amount).map(item=>({created:Number(item.status_transitions?.paid_at||item.created)||0,
    paymentIntent:(item.payments?.data||[]).find(payment=>payment.payment?.payment_intent)?.payment.payment_intent})),
   ...(await planCheckoutPayments(env,customer)).filter(item=>item.amount-item.refunded>=amount),
  ].filter(item=>item.paymentIntent).sort((a,b)=>b.created-a.created);
  if(!candidates.length)fail('返金可能な支払いを確認できませんでした。',409);
  const paymentIntent=candidates[0].paymentIntent;
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
export async function adminDisciplinaryBillingAction(env,customer,uid,input){
 if(!billingReady(env))fail('決済設定が完了していません。',503);
 const action=clean(input?.action),requestId=clean(input?.requestId),reason=clean(input?.reason);
 if(!['disciplinary_cancel','ban_account'].includes(action))fail('処分内容を確認してください。',400);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)fail('操作理由を5〜500文字で入力してください。',400);
 if(!customer){
  if(action==='disciplinary_cancel')fail('解除できる契約またはクレジット情報がありません。',409);
  return{message:'契約・クレジット情報はありません。アカウントをBANします。',canceledSubscriptions:0,confiscatedCredits:0,credits:0,creditEvent:null,subscriptions:[]};
 }
 const key=`dpi-admin-${action}-${requestId}`;
 const list=await subscriptions(env,customer);let canceledSubscriptions=0;
 for(const subscription of list){
  const attachedSchedule=scheduleId(subscription);
  if(attachedSchedule)await stripe(env,`subscription_schedules/${encodeURIComponent(attachedSchedule)}/release`,{},`${key}-release-${attachedSchedule}`);
  await stripe(env,`subscriptions/${encodeURIComponent(subscription.id)}`,{invoice_now:'false',prorate:'false'},`${key}-cancel-${subscription.id}`,'DELETE');
  canceledSubscriptions+=1;
 }
 const current=await customerCredits(env,customer);let creditEvent=null;
 if(current>0){
  const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
   amount:String(current),currency:'jpy',description:`DPI-Bot disciplinary credit confiscation: ${reason}`.slice(0,500),
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'disciplinary_confiscation','metadata[dpi_disciplinary_action]':action,'metadata[dpi_admin_reason]':reason,
  },`${key}-confiscate`);
  creditEvent={delta:-current,balanceAfter:creditsFromBalance(transaction.ending_balance),stripeTransactionId:transaction.id};
 }
 return{message:action==='ban_account'?'全契約を即時解除し、残クレジットを没収しました。アカウントをBANします。':'全契約を即時解除し、残クレジットを没収しました。再度のお支払いで申込みできます。',canceledSubscriptions,confiscatedCredits:current,credits:creditEvent?.balanceAfter??0,creditEvent,subscriptions:[]};
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
 const due=await db.prepare(`SELECT l.id,l.discord_user_id,l.source_type,l.remaining_amount,l.source_id,l.expires_at,b.customer_id
  FROM supporter_credit_lots l JOIN supporter_billing b ON b.discord_user_id=l.discord_user_id
  WHERE (l.source_type='purchase' OR (l.source_type='admin' AND l.source_id LIKE 'compensation:%'))
   AND l.status='active' AND l.remaining_amount>0 AND l.expires_at<=?
  ORDER BY l.expires_at,l.id LIMIT ?`).bind(now,limit).all();
 let expired=0;
 for(const candidate of due.results||[])try{
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
  if(candidate.source_type==='purchase')await db.prepare(`UPDATE supporter_credit_topups SET status='expired',updated_at=? WHERE checkout_session_id=? AND status='credited'`).bind(now,candidate.source_id).run();
  else await db.prepare(`UPDATE supporter_credit_campaign_recipients SET status='expired' WHERE lot_id=? AND status='credited'`).bind(candidate.id).run();
  try{await sendBillingNotification(env,db,'credit_expired',{id:`expiry:${candidate.id}`,customer:candidate.customer_id,amount_due:remaining,currency:'jpy',expires_at:candidate.expires_at});}
  catch(error){console.error('Supporter credit expiry email failed',{creditLotId:candidate.id,errorName:error?.name||'Error'});}
  expired+=1;
 }catch(error){
  // 1 件の失敗（Stripe で確認できないなど）で、残りの失効と後続の定期処理を止めない。次回また試す。
  console.error('Supporter credit expiry failed',{creditLotId:candidate.id,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});
 }
 return expired;
}
const PAYMENT_ALERT_KINDS=Object.freeze({'charge.refunded':'refunded','charge.dispute.created':'disputed','charge.dispute.closed':'dispute_closed','radar.early_fraud_warning.created':'fraud_warning'});
// 返金・支払異議・不正の警告を管理画面に残す（契約の扱いは管理者が判断する）。
async function recordPaymentAlert(env,db,event){
 const kind=PAYMENT_ALERT_KINDS[event.type];if(!kind)return;
 const object=event.data?.object||{};
 const chargeId=clean(kind==='refunded'?object.id:stripeId(object.charge));
 let charge=kind==='refunded'?object:null,customer=clean(stripeId(object.customer)),paymentIntent=clean(stripeId(object.payment_intent));
 if(!customer&&chargeId){charge=await stripe(env,`charges/${encodeURIComponent(chargeId)}`);customer=clean(stripeId(charge.customer));paymentIntent=paymentIntent||clean(stripeId(charge.payment_intent));}
 const owner=customer?await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(customer).first():null;
 const amount=Number(kind==='refunded'?object.amount_refunded:object.amount||charge?.amount)||0;
 await db.prepare(`INSERT INTO supporter_payment_alerts(event_id,kind,outcome,payment_intent_id,customer_id,discord_user_id,amount,created_at)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`).bind(event.id,kind,clean(object.status).slice(0,40),paymentIntent,customer,clean(owner?.discord_user_id),amount,Number(event.created)||Math.floor(Date.now()/1000)).run();
 return{kind,object,charge,paymentIntent,customer};
}
// 契約管理画面（Stripe）でのカード変更は顧客の既定カードに入る。契約にはカードを固定しているため、
// 同じカードへそろえないと、毎月の更新と月末の再決済が古いカードのままになる。
async function syncDefaultPaymentMethod(env,db,event){
 const customer=clean(event.data?.object?.id),previous=event.data?.previous_attributes?.invoice_settings;
 if(!customer||!previous||!Object.hasOwn(previous,'default_payment_method'))return 0;
 if(!await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(customer).first())return 0;
 const current=await stripe(env,`customers/${encodeURIComponent(customer)}`);
 const method=clean(stripeId(current.invoice_settings?.default_payment_method));if(!method)return 0;
 let updated=0;
 for(const subscription of await subscriptions(env,customer)){
  const schedule=scheduleId(subscription);
  if(schedule)await stripe(env,`subscription_schedules/${encodeURIComponent(schedule)}`,{'default_settings[default_payment_method]':method},`dpi-default-pm-schedule-${schedule}-${event.id}`);
  if(stripeId(subscription.default_payment_method)===method)continue;
  await stripe(env,`subscriptions/${encodeURIComponent(subscription.id)}`,{default_payment_method:method},`dpi-default-pm-${subscription.id}-${event.id}`);updated+=1;
 }
 return updated;
}
export async function billingWebhook(request,env,ctx){
 if(request.method!=='POST')return json({message:'Method not allowed'},405);
 if(!billingReady(env))return json({message:'Unavailable'},503);
 const reader=request.body?.getReader();if(!reader)return json({},400);const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return json({},413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const raw=new TextDecoder().decode(bytes);
 if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET))return json({},400);
 let event;try{event=JSON.parse(raw);}catch{return json({},400);}
 if(event.livemode!==expectedLivemode(env)||typeof event.id!=='string')return json({},400);
 const allowed=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','customer.updated','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created','charge.dispute.closed','charge.dispute.funds_withdrawn','radar.early_fraud_warning.created'];
 if(!allowed.includes(event.type))return json({received:true});
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 const alreadyProcessed=await db.prepare('SELECT id FROM supporter_stripe_events WHERE id=?').bind(event.id).first();
 if(alreadyProcessed)return json({received:true});
 if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
  const session=event.data?.object;
  if(checkoutMetadata(session).dpi_checkout_kind==='preview_demo'){
   // 以前のテスト公開で使った、誰にも紐づかない支払い。遅れて届いても、契約・クレジット・通知には何も反映しない。
   console.log('Preview checkout completed (no-op)',{sessionId:clean(session?.id)});
  }else if(await rejectDisciplinedCheckout(env,db,session)){
   console.warn('Checkout completed after disciplinary action and was rejected',{sessionId:clean(session?.id),uid:clean(checkoutMetadata(session).dpi_user||session?.client_reference_id)});
  }else if(checkoutMetadata(session).dpi_checkout_kind==='custom_change'){
   const metadata=checkoutMetadata(session),uid=clean(metadata.dpi_user),changeId=clean(metadata.dpi_change_request);
   if(/^\d{17,20}$/.test(uid)&&/^[0-9a-f-]{36}$/i.test(changeId))
    await settleCustomPriceChange(env,db,uid,changeId);
  }else if(checkoutMetadata(session).dpi_checkout_kind==='custom_subscription_initial'){
   const subscription=await provisionCustomPaidCheckoutSubscription(env,db,session);
   const uid=clean(checkoutMetadata(session).dpi_user);
   if(subscription&&/^\d{17,20}$/.test(uid))
    await syncCustomWithStripe(db,uid,stripeId(session.customer),
     await customerSubscriptionSummaries(env,stripeId(session.customer)));
  }else if(checkoutMetadata(session).dpi_checkout_kind==='credit_topup'){
   const fulfilled=await fulfillCreditTopup(env,db,session,event.created);
   // The credit is already recorded: a mail failure must not 503 the webhook and trigger a redelivery of the grant.
   if(fulfilled){
    try{await sendBillingNotification(env,db,'credit_topup_succeeded',{id:session.id,customer:session.customer,amount_paid:fulfilled.amount,currency:session.currency||'jpy',expires_at:fulfilled.expiresAt});}
    catch(error){console.error('Credit top-up email failed',{sessionId:clean(session?.id),errorName:error?.name||'Error'});}
   }
  }
  else{
   if(checkoutMetadata(session).dpi_checkout_kind==='initial_subscription')await assertCheckoutOwner(db,session);
   const provisioned=await provisionPaidCheckoutSubscription(env,session);
   if(provisioned)await recordInitialCredit(env,db,session);
   if(provisioned&&session?.payment_status==='paid')await sendBillingNotificationSafely(env,db,'payment_succeeded',{id:session.id,customer:session.customer,amount_paid:Number(session.amount_total||0),currency:session.currency||'jpy',credit_applied:Number(checkoutMetadata(session).dpi_credit_applied||0)});
  }
 }
 if(event.type==='invoice.paid'){
  // 支払いの記録は済んでいるので、メールの失敗（Stripe に再送させる）でも配信の再開は遅らせない。
  try{await recordInvoicePaid(env,db,event.data?.object);}
  catch(error){await refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,'stripe_invoice.paid');throw error;}
 }
 if(event.type==='invoice.payment_failed')await recordInvoiceFailed(env,db,event.data?.object);
 if(event.type==='charge.refunded')await revokeCreditTopup(env,db,event.data?.object,'refunded');
 if(event.type==='charge.dispute.created')await revokeCreditTopup(env,db,event.data?.object,'disputed');
 if(['checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)){
  const session=event.data?.object,sessionId=clean(session?.id);
  await db.batch([
   db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL,dirty=1 WHERE checkout_id=?').bind(sessionId),
   db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=? WHERE checkout_session_id=? AND status='pending'`).bind(Math.floor(Date.now()/1000),sessionId),
  ]);
  if(checkoutMetadata(session).dpi_checkout_kind==='custom_change'){
   // Expiry/failure cannot cancel a payment already confirmed elsewhere.
   await db.prepare(`UPDATE supporter_custom_plan_changes SET status='canceled',updated_at=?
    WHERE checkout_session_id=? AND status='pending'`)
    .bind(new Date().toISOString(),sessionId).run();
  }
  if(event.type==='checkout.session.async_payment_failed'&&checkoutMetadata(session).dpi_checkout_kind==='credit_topup')await sendBillingNotificationSafely(env,db,'credit_topup_failed',{id:sessionId,customer:session.customer,amount_due:Number(session.amount_total||0),currency:session.currency||'jpy'});
 }
 const paymentAlert=await recordPaymentAlert(env,db,event);
 if(event.type.startsWith('charge.dispute.'))await syncDisputeHold(env,db,event.data?.object);
 if(event.type==='customer.updated'){await syncCustomerEmail(db,event.data?.object);await syncDefaultPaymentMethod(env,db,event);}
 if(['customer.subscription.created','customer.subscription.updated'].includes(event.type)){
  const subscription=event.data?.object;
  const summary=subscriptionSummary(subscription,env);
  // 支払いの回復・一時停止の解除は、Stripe の現在の状態で確かめてから停止を解く。
  const holder=clean(stripeId(subscription?.customer));
  // 支払い不能・一時停止は、定期処理を待たずに翌月1日0時の停止を予約する（月末の定期処理の後に起きても1か月ずれない）。
  if(holder&&subscription?.id&&(['unpaid','paused'].includes(subscription.status)||subscription.pause_collection)&&await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(holder).first()){
   const current=(await customerSubscriptionSummaries(env,holder)).find(item=>item.subscriptionId===subscription.id);
   if(current&&serviceHeld(current))await openServiceHold(env,db,holder,current,Number(event.created)||Math.floor(Date.now()/1000));
  }
  if(holder&&subscription?.id&&await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE invoice_id=? AND status IN ('suspend_scheduled','suspended')`).bind(`${HOLD_PREFIX}${subscription.id}`).first())
   await releaseServiceHolds(env,db,await customerSubscriptionSummaries(env,holder));
  if(summary.customId){
   const uid=clean(subscription?.metadata?.dpi_user);
   if(/^\d{17,20}$/.test(uid)){
    const billing=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
    const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    if(billing?.customer_id===customer)await syncCustomWithStripe(db,uid,customer,await customerSubscriptionSummaries(env,customer));
   }
  }else if(summary.recognizedPlan&&['active','trialing','past_due','unpaid','paused'].includes(subscription?.status)){
   // 再送された古いイベント本文の上限でルールを削らない。上限は Stripe の現在の契約から取り直す。
   const customer=stripeId(subscription.customer);
   const live=(await customerSubscriptionSummaries(env,customer)).filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
   if(live.length&&!live.some(item=>item.customId))await reconcileStoredRulesForCustomer(db,customer,combinedLimits(live));
  }
 }
 if(event.type==='customer.subscription.deleted'){
  // 終了した契約の未払い記録を閉じる。残したままだと、後で新しく契約して支払っても利用停止のままになる。
  const subscriptionId=clean(event.data?.object?.id);
  if(subscriptionId)await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE subscription_id=? AND status IN ('retry_scheduled','retrying','suspend_scheduled','suspended')`).bind(Math.floor(Date.now()/1000),subscriptionId).run();
 }
 await queueEventNotices(env,db,event,paymentAlert);
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(eventCustomerId(event))]);
 const snapshotTask=refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,`stripe_${event.type}`);
 const noticeTask=flushNotices(env,db);
 const roleTask=reconcileSupporterRolesSafely(env,db,subscriptionSummariesByCustomer,{customer:eventCustomerId(event)||''});
 if(ctx?.waitUntil){ctx.waitUntil(snapshotTask);ctx.waitUntil(noticeTask);ctx.waitUntil(roleTask);}else{await snapshotTask;await noticeTask;await roleTask;}
 return json({received:true});
}
// 運営向けの通知（Discord）。失敗しても Webhook の処理は止めない。
const ALERT_TARGET_LABELS=Object.freeze({credit_topup:'クレジットチャージ',custom_subscription_initial:'カスタム',custom_change:'カスタム',initial_subscription:'プラン料金'});
const alertTarget=(object,charge)=>ALERT_TARGET_LABELS[clean(object?.metadata?.dpi_checkout_kind||charge?.metadata?.dpi_checkout_kind)]||'プラン料金';
const disputeReason=value=>({bank_cannot_process:'カード会社で処理できない',check_returned:'小切手の返却',credit_not_processed:'返金が反映されていない',customer_initiated:'利用者による申立て',debit_not_authorized:'引き落としの承認がない',duplicate:'重複請求',fraudulent:'不正利用',general:'理由未特定',incorrect_account_details:'口座情報が違う',insufficient_funds:'残高不足',product_not_received:'商品・サービスが届かない',product_unacceptable:'商品・サービスに問題がある',subscription_canceled:'解約後の請求',unrecognized:'心当たりのない請求'})[clean(value)]||'その他';
const fraudType=value=>({card_never_received:'カード未着',fraudulent_card_application:'不正なカード申込み',made_with_counterfeit_card:'偽造カード',made_with_lost_card:'紛失カード',made_with_stolen_card:'盗難カード',misc:'その他',unauthorized_use_of_card:'カードの不正使用'})[clean(value)]||'その他';
const alertDate=seconds=>{if(!Number(seconds))return'';const d=new Date((Number(seconds)+32400)*1000);return`${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}（日本時間）`;};
async function queueEventNotices(env,db,event,paymentAlert=null){
 try{
  const object=event.data?.object||{},at=Number(event.created)||Math.floor(Date.now()/1000);
  if(event.type.startsWith('customer.subscription.')){
   const summary=subscriptionSummary(object,env);
   const custom=summary.customId?await db.prepare('SELECT name FROM supporter_custom_plans WHERE id=?').bind(summary.customId).first():null;
   let scheduled=null;
   if(event.type==='customer.subscription.updated'&&Object.hasOwn(event.data?.previous_attributes||{},'schedule')&&object.schedule){
    try{scheduled=(await summaryWithSchedule(env,object)).scheduledChange;}catch{/* 予約の内容が取れないときは通知しない */}
   }
   await queueMembershipNotice(env,db,event,{summarize:subscription=>subscriptionSummary(subscription,env),cancelScheduled,customName:custom?.name||'',scheduled});
   return;
  }
  const alert=PAYMENT_ALERT_KINDS[event.type];
  if(alert){
    const row=await db.prepare('SELECT kind,outcome,payment_intent_id,customer_id,amount FROM supporter_payment_alerts WHERE event_id=?').bind(event.id).first();
   const member=row?.customer_id?await memberLabel(db,row.customer_id):null;
   if(!member)return;
    const label={refunded:'返金',disputed:'支払異議の申立て',dispute_closed:'支払異議の終了',fraud_warning:'不正の警告'}[alert],charge=paymentAlert?.charge,lines=[`利用者: ${member.text}`],target=alertTarget(object,charge);
    if(alert==='refunded'){
     const refunds=object.refunds?.data||[],latest=[...refunds].sort((a,b)=>Number(b.created)-Number(a.created))[0],refundAmount=Number(latest?.amount)||Number(object.amount_refunded)||0,original=Number(object.amount)||0,cumulative=Number(object.amount_refunded)||refundAmount;
     lines.push('【返金】',`区分: ${original>0&&cumulative>=original?'全額返金':'一部返金'}`,refundAmount?`返金額: ${yen(refundAmount)}`:'',original?`元の支払額: ${yen(original)}`:'',cumulative?`累計返金額: ${yen(cumulative)}`:'',`対象: ${target}`,'【契約への影響】');
     if(target==='クレジットチャージ'){
      const credit=await db.prepare(`SELECT credit_delta FROM supporter_credit_events WHERE id LIKE ? AND reason='credit_refunded' ORDER BY created_at DESC LIMIT 1`).bind(`refunded:${clean(object.id)}:%`).first();
      if(Number(credit?.credit_delta)<0)lines.push(`クレジットを取り消した額: ${yen(-Number(credit.credit_delta))}`);
     }else lines.push('契約は続きます');
    }else if(alert==='disputed'){
     const held=await db.prepare(`SELECT status FROM supporter_dunning WHERE invoice_id=?`).bind(`${DISPUTE_PREFIX}${clean(object.id)}`).first();
     lines.push('【申立て】',`理由: ${disputeReason(object.reason)}`,Number(row.amount)?`金額: ${yen(row.amount)}`:'',object.evidence_details?.due_by?`回答期限: ${alertDate(object.evidence_details.due_by)}`:'',`対象: ${target}`,'【配信】',`状態: ${held?.status==='suspended'?'申立てで停止した':'停止していない'}`,'【次にすること】','Stripe のダッシュボードで期限までに証拠を提出してください',object.evidence_details?.due_by?'期限を過ぎると異議に負けます':'','管理画面: https://dpi-bot.com/site/supporter-admin/');
    }else if(alert==='dispute_closed'){
     const result=({won:'勝ち',lost:'負け',warning_closed:'照会の終了',prevented:'申立ての取りやめ'})[clean(row.outcome)]||'その他',held=await db.prepare(`SELECT status FROM supporter_dunning WHERE invoice_id=?`).bind(`${DISPUTE_PREFIX}${clean(object.id)}`).first();
     lines.push('【結果】',`結果: ${result}`,'【配信】',`状態: ${held?.status==='suspended'?'止めたまま':'再開した'}`,result==='負け'?'【次にすること】':'',result==='負け'?'管理画面で停止を解除できます':'',result==='負け'?'管理画面: https://dpi-bot.com/site/supporter-admin/':'');
    }else{
     lines.push('【警告】',`種類: ${fraudType(object.fraud_type)}`,`対応できるか: ${object.actionable===true?'はい':object.actionable===false?'いいえ':'不明'}`,Number(row.amount)?`金額: ${yen(row.amount)}`:'',`対象: ${target}`,'【次にすること】',object.actionable===false?'Stripe では対応できません':'Stripe のダッシュボードで内容を確認し、必要に応じて返金を検討してください','管理画面: https://dpi-bot.com/site/supporter-admin/');
    }
    await queueNotice(env,db,{id:`${event.id}:${alert}`,channel:'billing',kind:alert,title:label,tone:alert==='refunded'?'quiet':'bad',at,lines});
   return;
  }
 }catch(error){console.error('Supporter event notice failed',{type:event?.type,errorName:error?.name||'Error'});}
}
// 26日の請求の開始と結果。対象は当サイトの契約だけ。
const planKey=summary=>summary?.customId?'カスタム':summary?.planId==='supporter'?'Basic':summary?.planId==='plus'?'Plus':summary?.planId==='pro'?'Pro':'カスタム';
const emptyPlans=()=>Object.fromEntries(['Basic','Plus','Pro','カスタム'].map(key=>[key,{count:0,amount:0,success:0,failed:0}]));
const addPlan=(plans,summary,field='count',amount=0)=>{const item=plans[planKey(summary)];item[field]+=1;item.amount+=Number(amount)||0;};
const planLines=(plans,mode='amount')=>['【プラン別】',...Object.entries(plans).map(([name,value])=>mode==='result'?`${name}: 成功 ${value.success}件 / 失敗 ${value.failed}件`:`${name}: ${value.count}件（${yen(value.amount)}）`)];
const percent=(success,total)=>total?`${(success*100/total).toFixed(1)}%`:'—';
export const paymentFailureCategory=value=>({insufficient_funds:'残高不足',card_expired:'カードの期限切れ',expired_card:'カードの期限切れ',card_declined:'カード会社による拒否',do_not_honor:'カード会社による拒否',generic_decline:'カード会社による拒否',authentication_required:'本人確認が必要',payment_intent_authentication_failure:'本人確認が必要',payment_method_missing:'支払い方法が無い',payment_method_unexpected_state:'支払い方法が無い'})[clean(value)]||'その他';
async function renewalFailureReasons(env,invoices){
 // 失敗分だけ・最大20件・全体で10秒まで。取れなくても集計の通知は送る。
 const counts={},deadline=Date.now()+10000;
 for(const invoice of invoices.slice(0,20)){
  const left=deadline-Date.now();if(left<=0)break;
  let timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),left);});
   const detail=await Promise.race([stripe(env,`invoices/${encodeURIComponent(invoice.id)}?expand[]=payments.data.payment.payment_intent`),timeout]);
   const error=(detail?.payments?.data||[]).map(item=>item?.payment?.payment_intent).find(intent=>intent?.last_payment_error)?.last_payment_error;
   if(!error)continue;
   const category=paymentFailureCategory(error.decline_code||error.code);counts[category]=(counts[category]||0)+1;
  }catch{/* 理由が取れなくても通知は送る */}
  finally{clearTimeout(timer);}
 }
 return Object.entries(counts).map(([name,count])=>`${name} ${count}件`).join('、');
}
async function queueRenewalNotices(env,db,now){
 try{
  const day=jstDate(now);
  if(day.day!==26)return;
  const rows=await db.prepare('SELECT customer_id FROM supporter_billing WHERE customer_id IS NOT NULL').all();
  const customers=new Set((rows.results||[]).map(row=>row.customer_id).filter(Boolean));
  if(day.hour<6){
    let count=0,amount=0,stopped=0,canceled=0,addons=0;const plans=emptyPlans();
   for(const summary of [...(await subscriptionSummariesByCustomer(env,[...customers])).values()].flat()){
    // 0時ちょうどは、Stripe が新しい期間へ切り替える前後のどちらもあり得る。
    const due=[summary.nextRenewalAt,summary.currentPeriodStart].some(time=>Math.abs(Number(time||0)-day.start)<=3600);
    if(!due||Number(summary.startedAt||0)>=day.start)continue;
    if(summary.servicePause){stopped+=1;continue;}
     if(summary.cancelAtPeriodEnd){canceled+=1;continue;}
    const next=summary.scheduledChange;
     const dueAmount=Number(next?.monthly??summary.amount)||0;count+=1;amount+=dueAmount;addPlan(plans,next||summary,'count',dueAmount);if(Number((next||summary).channelPacks)+Number((next||summary).serverPacks)+Number((next||summary).rulePacks)>0)addons+=1;
   }
   await queueNotice(env,db,{id:`renewal-start:${day.key}`,channel:'billing',kind:'renewal_start',title:`${day.month}月26日の請求を開始`,tone:'info',at:now,
     lines:['【対象】',`対象: ${count}件（合計 ${yen(amount)}）`,...planLines(plans),`追加オプションがある契約: ${addons}件`,`停止中で請求しない契約: ${stopped}件`,`解約予約中で請求しない契約: ${canceled}件`,'【次の予定】','結果: 26日 12時ごろ',`月末の再請求: ${day.month}月${day.lastDay}日 12時`]});
   return;
  }
  if(day.hour<11)return;
   const result={paid:0,paidAmount:0,credit:0,partialCredit:0,partialCreditAmount:0,failed:0,failedAmount:0,voided:0,voidedAmount:0,other:0,otherAmount:0},failedInvoices=[],plans=emptyPlans();
   let bySubscription=new Map();
   try{bySubscription=new Map([...(await subscriptionSummariesByCustomer(env,[...customers])).values()].flat().map(item=>[item.subscriptionId,item]));}
   catch(error){console.error('Supporter renewal plan breakdown failed',{errorName:error?.name||'Error'});}
  await stripeListAll(env,`invoices?created%5Bgte%5D=${day.start-60}&limit=100`,invoice=>{
   if(!customers.has(stripeId(invoice.customer))||invoice.billing_reason!=='subscription_cycle'||Number(invoice.created)<day.start-60)return;
    const paid=Number(invoice.amount_paid)||0,total=Number(invoice.total||invoice.amount_due)||paid,credit=Math.max(0,total-paid),summary=bySubscription.get(invoiceSubscriptionId(invoice));
    if(invoice.status==='paid'){if(paid>0){result.paid+=1;result.paidAmount+=paid;if(credit>0){result.partialCredit+=1;result.partialCreditAmount+=credit;}}else result.credit+=1;if(summary)addPlan(plans,summary,'success');}
    else if(invoice.status==='void'){result.voided+=1;result.voidedAmount+=total;}
    else if(['open','uncollectible'].includes(invoice.status)&&Number(invoice.attempt_count)>0){result.failed+=1;result.failedAmount+=Number(invoice.amount_remaining||0);failedInvoices.push(invoice);if(summary)addPlan(plans,summary,'failed');}
    else{result.other+=1;result.otherAmount+=Number(invoice.amount_remaining||total);}
  });
   const reasons=await renewalFailureReasons(env,failedInvoices),successful=result.paid+result.credit,target=successful+result.failed+result.voided+result.other;
  await queueNotice(env,db,{id:`renewal-result:${day.key}`,channel:'billing',kind:'renewal_result',title:`${day.month}月26日の請求結果`,tone:result.failed?'warn':'good',at:now,
    lines:['【結果】',`成功: ${result.paid}件（請求額 ${yen(result.paidAmount+result.partialCreditAmount)}）`,`クレジットで全額: ${result.credit}件`,`クレジットを一部使用: ${result.partialCredit}件（使用額 ${yen(result.partialCreditAmount)}）`,`失敗: ${result.failed}件（${yen(result.failedAmount)}）`,`取り消し: ${result.voided}件（${yen(result.voidedAmount)}）`,`確認中: ${result.other}件（${yen(result.otherAmount)}）`,`成功率: ${percent(successful,target)}`,...(bySubscription.size?planLines(plans,'result'):[]),'【入金】',`カード等の入金合計: ${yen(result.paidAmount)}`,reasons?'【失敗理由】':'',reasons,...(result.failed?['【次の予定】',`失敗した分の再請求: ${day.month}月${day.lastDay}日 12時`,'再請求でも支払いを確認できないものの停止: 翌月1日 0時']:[])]});
 }catch(error){console.error('Supporter renewal notice failed',{errorName:error?.name||'Error'});}
}
// 1日0時の停止・自動解約と、前月の加入・変更・解約の集計。
async function queueStopNotices(env,db,now,{suspended,autoCanceled,voidedAmount=0,resumed=0,grouped=null}){
 try{
  const day=jstDate(now);
   const total=await suspendedCustomers(db),plans=emptyPlans();
   for(const summary of grouped?[...grouped.values()].flat():[])if(['active','trialing','past_due','unpaid','paused'].includes(summary.status))addPlan(plans,summary);
  if(day.day===1&&day.hour<6){
   const last=jstDate(day.start-86400),from=Math.floor(Date.UTC(last.year,last.month-1,1)/1000)-32400;
    const counts=await noticeCounts(db,'membership',from,day.start),alerts=await noticeCounts(db,'billing',from,day.start);
   await queueNotice(env,db,{id:`month-start:${day.monthKey}`,channel:'billing',kind:'month_start',title:`${day.month}月1日の停止・解約の結果`,tone:suspended||autoCanceled?'warn':'good',at:now,
     lines:['【結果】',`今回停止: ${suspended}件`,`停止中の合計: ${total}件`,`自動解約: ${autoCanceled}件`,`取り消した請求の合計額: ${yen(voidedAmount)}`,`再開: ${resumed}件`,'【契約中】',...Object.entries(plans).map(([name,value])=>`${name}: ${value.count}件`),'【前月の集計】',`加入: ${counts.join||0}件`,`変更: ${counts.change||0}件`,`解約予約: ${counts.leave_reserved||0}件`,`解約: ${counts.leave||0}件`,`返金: ${alerts.refunded||0}件`,`支払異議: ${alerts.disputed||0}件`,`不正の警告: ${alerts.fraud_warning||0}件`,'【次の予定】',`次の請求日: ${day.month}月26日`]});
  }else if(suspended||autoCanceled)
    await queueNotice(env,db,{id:`stop:${day.key}:${day.hour}`,channel:'billing',kind:'stop',title:'停止・自動解約',tone:'warn',at:now,lines:['【結果】',`今回停止: ${suspended}件`,`停止中の合計: ${total}件`,`自動解約: ${autoCanceled}件`,`取り消した請求の合計額: ${yen(voidedAmount)}`,`再開: ${resumed}件`,'【契約中】',...Object.entries(plans).map(([name,value])=>`${name}: ${value.count}件`),'【次の予定】',`次の請求日: ${day.month===12?1:day.month+1}月26日`]});
 }catch(error){console.error('Supporter stop notice failed',{errorName:error?.name||'Error'});}
}
async function publishScheduledSnapshot(env,db,reason){
 try{
  const result=await refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,reason);
  if(result?.reason==='failed')console.error('Supporter delivery snapshot was not republished by the billing schedule; the previous snapshot stays until it expires',{reason});
  return result;
 }catch(error){
  console.error('Supporter delivery snapshot was not republished by the billing schedule; the previous snapshot stays until it expires',{reason,errorName:error?.name||'Error'});
  return{published:false,reason:'failed'};
 }
}
export async function runSupporterBillingSchedule(env,nowMs=Date.now()){
 if(!billingReady(env))return {retried:0,paid:0,failed:0,suspended:0,expiredCredits:0};
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 // Paid delivery depends on a snapshot that expires after 30 hours. Republish it
 // before anything else so a failing billing task can never stop delivery.
 await publishScheduledSnapshot(env,db,'billing_schedule_start');
 let tasks,taskError=null;
 try{tasks=await runBillingScheduleTasks(env,db,nowMs);}
 catch(error){taskError=error;console.error('Supporter billing schedule task failed',{errorName:error?.name||'Error',status:Number(error?.status)||null,stripeStatus:Number(error?.stripeStatus)||null});}
 await flushNotices(env,db,50);
 // Republish again so suspensions/recoveries from this run reach delivery promptly.
 await publishScheduledSnapshot(env,db,'billing_schedule');
 await reconcileSupporterRolesSafely(env,db,subscriptionSummariesByCustomer,{nowMs,renew:true});
 if(taskError)throw taskError;
 return tasks;
}
// --- 未払い・一時停止の停止と再開 ---
// 請求書ごとの督促（supporter_dunning）に加えて、請求書に結び付かない状態（unpaid・paused・支払いの一時停止など）を
// invoice_id='hold:<契約ID>' の行で管理する。どちらも翌月1日0時（日本時間）に停止し、支払い・解除を確認したら再開する。
const HOLD_PREFIX='hold:';
const DISPUTE_PREFIX='hold:dispute:';
const HOLD_STATUSES=new Set(['past_due','unpaid','paused']);
// 停止中の請求を止めるために当方が付けた一時停止（servicePause）は、利用者側の一時停止として扱わない。
const userPaused=summary=>summary?.pauseCollection===true&&summary?.servicePause!==true;
export function serviceHeld(summary){return HOLD_STATUSES.has(summary?.status)||userPaused(summary);}
// 請求書を払っても、Stripe の契約は次の更新まで past_due のままのことがある。未払いの請求書が残っているかで判断する。
async function stillHeld(env,summary){
 if(userPaused(summary)||summary?.status==='paused')return true;
 if(!HOLD_STATUSES.has(summary?.status))return false;
 for(const status of ['open','uncollectible'])
  if((await stripe(env,`invoices?subscription=${encodeURIComponent(summary.subscriptionId)}&status=${status}&limit=1`)).data?.length)return true;
 return false;
}
async function releaseServiceHolds(env,db,summaries){
 const now=Math.floor(Date.now()/1000);let released=0;
 for(const summary of summaries||[]){
  if(!summary?.subscriptionId)continue;
  if(!await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE invoice_id=? AND status IN ('suspend_scheduled','suspended')`).bind(`${HOLD_PREFIX}${summary.subscriptionId}`).first())continue;
  if(await stillHeld(env,summary))continue;
  const result=await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=? AND status IN ('suspend_scheduled','suspended')`).bind(now,`${HOLD_PREFIX}${summary.subscriptionId}`).run();
  released+=Number(result.meta?.changes||0);
 }
 return released;
}
async function openServiceHold(env,db,customer,summary,now){
 if(['past_due','unpaid'].includes(summary.status)&&!userPaused(summary)){
  const open=await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE subscription_id=? AND invoice_id NOT LIKE 'hold:%'
   AND status IN ('retry_scheduled','retrying','suspend_scheduled','suspended') LIMIT 1`).bind(summary.subscriptionId).first();
  if(open)return;
 }
 if(!await stillHeld(env,summary))return;
 const {suspendAt}=dunningSchedule(now);
 await db.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at)
  VALUES(?,?,?,0,'jpy','suspend_scheduled',?,?,?,?)
  ON CONFLICT(invoice_id) DO UPDATE SET customer_id=excluded.customer_id,status='suspend_scheduled',initial_failed_at=excluded.initial_failed_at,
   retry_at=excluded.retry_at,suspend_at=excluded.suspend_at,suspended_at=NULL,updated_at=excluded.updated_at
  WHERE supporter_dunning.status IN ('closed','paid')`).bind(`${HOLD_PREFIX}${summary.subscriptionId}`,customer,summary.subscriptionId,now,suspendAt,suspendAt,now).run();
}
async function syncServiceHolds(env,db,now){
 const rows=await db.prepare('SELECT customer_id FROM supporter_billing WHERE customer_id IS NOT NULL').all();
 const customers=(rows.results||[]).map(row=>row.customer_id).filter(Boolean);
 if(!customers.length)return;
 const grouped=await subscriptionSummariesByCustomer(env,customers);
 const all=[...grouped.values()].flat(),known=new Set(all.map(item=>item.subscriptionId));
 await releaseServiceHolds(env,db,all);
 const open=await db.prepare(`SELECT invoice_id,subscription_id FROM supporter_dunning WHERE invoice_id LIKE 'hold:%' AND invoice_id NOT LIKE 'hold:dispute:%' AND status IN ('suspend_scheduled','suspended')`).all();
 for(const row of open.results||[])if(!known.has(row.subscription_id))
  await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=?`).bind(now,row.invoice_id).run();
 for(const [customer,summaries] of grouped)for(const summary of summaries)
  if(summary.subscriptionId&&serviceHeld(summary))await openServiceHold(env,db,customer,summary,now-3600); // 1日0時に初めて見つけたものは前月中の変化とみなし、すぐ停止する
 return grouped;
}
// プラン料金への支払異議（チャージバック）の間は配信を止め、取り下げ・勝訴で再開する。負けたときは止めたままにし、管理者が解除する。
// カード会社からの問い合わせだけの段階（warning_*、お金は動いていない）と、クレジット購入への異議（クレジットを取り消す）は対象外。
const DISPUTE_CLEARED=new Set(['won','warning_closed','prevented']);
async function syncDisputeHold(env,db,dispute){
 const id=clean(dispute?.id);if(!id)return;
 let current=dispute;
 // 通知の順序が前後しても、Stripe の現在の状態で決める（権限が無いキーのときだけ通知の内容を使う）。
 try{current=await stripe(env,`disputes/${encodeURIComponent(id)}`);}
 catch(error){if(![401,403].includes(error?.stripeStatus))throw error;console.error('Supporter dispute lookup is not permitted',{stripeStatus:error.stripeStatus});}
 const status=clean(current?.status),now=Math.floor(Date.now()/1000),key=`${DISPUTE_PREFIX}${id}`;
 if(DISPUTE_CLEARED.has(status)){
  const row=await db.prepare(`SELECT customer_id FROM supporter_dunning WHERE invoice_id=? AND status='suspended'`).bind(key).first();
  if(!row)return;
  await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=?`).bind(now,key).run();
  await resumeServicePause(env,db,row.customer_id);return;
 }
 if(!status||status.startsWith('warning_'))return;
 const chargeId=clean(stripeId(current.charge));if(!chargeId)return;
 const charge=await stripe(env,`charges/${encodeURIComponent(chargeId)}`);
 const customer=clean(stripeId(charge.customer)),paymentIntent=clean(stripeId(charge.payment_intent));
 if(!customer||!await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(customer).first())return;
 if(paymentIntent&&await db.prepare('SELECT request_id FROM supporter_credit_topups WHERE payment_intent_id=?').bind(paymentIntent).first())return;
 // 管理者が解除したもの（closed）は、後から届く通知で止め直さない。
 await db.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,suspended_at,updated_at)
  VALUES(?,?,NULL,?,'jpy','suspended',?,?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING`).bind(key,customer,Number(current.amount)||0,now,now,now,now,now).run();
}
async function reconcileDisputeHolds(env,db){
 const rows=await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE invoice_id LIKE 'hold:dispute:%' AND status='suspended' ORDER BY updated_at LIMIT 50`).all();
 for(const row of rows.results||[]){
  try{await syncDisputeHold(env,db,{id:row.invoice_id.slice(DISPUTE_PREFIX.length)});}
  catch(error){console.error('Supporter dispute check failed',{errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
 }
}
export async function releaseDisputeHolds(env,db,customer){
 const result=await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE customer_id=? AND invoice_id LIKE 'hold:dispute:%' AND status='suspended'`).bind(Math.floor(Date.now()/1000),customer).run();
 const released=Number(result.meta?.changes||0);
 if(released)await resumeServicePause(env,db,customer);
 return released;
}
const customerDisputed=async(db,customer)=>!!await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE customer_id=? AND invoice_id LIKE 'hold:dispute:%' AND status='suspended' LIMIT 1`).bind(customer).first();
// 停止中は新しい月額料金を請求しない。停止前の請求書は残り、支払いを確認したら請求も再開する。
const pauseParams=on=>on?{'pause_collection[behavior]':'void','metadata[dpi_service_pause]':'dunning'}:{pause_collection:'','metadata[dpi_service_pause]':''};
async function syncServicePauses(env,db,grouped){
 const rows=await db.prepare(`SELECT DISTINCT subscription_id FROM supporter_dunning WHERE status='suspended' AND invoice_id NOT LIKE 'hold:%' AND subscription_id IS NOT NULL`).all();
 const stopped=new Set((rows.results||[]).map(row=>row.subscription_id));
 const disputes=await db.prepare(`SELECT DISTINCT customer_id FROM supporter_dunning WHERE status='suspended' AND invoice_id LIKE 'hold:dispute:%'`).all();
 const disputed=new Set((disputes.results||[]).map(row=>row.customer_id));
 for(const [customer,summaries] of grouped)for(const summary of summaries){
  if(!summary.subscriptionId)continue;
  const stop=stopped.has(summary.subscriptionId)||disputed.has(customer);
  const pause=stop&&!summary.pauseCollection,resume=!stop&&summary.servicePause;
  if(!pause&&!resume)continue;
  try{
   // 一覧を取った後に支払い・再停止の Webhook が届いていないか、直前の状態で確かめる。
   const still=await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE subscription_id=? AND status='suspended' AND invoice_id NOT LIKE 'hold:%' LIMIT 1`).bind(summary.subscriptionId).first();
   if((!!still||await customerDisputed(db,customer))!==pause)continue;
   await stripe(env,`subscriptions/${encodeURIComponent(summary.subscriptionId)}`,pauseParams(pause));
  }
  catch(error){console.error('Supporter service pause update failed',{subscriptionId:summary.subscriptionId,pause,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
 }
}
async function resumeServicePause(env,db,customer){
 try{
  if(await customerDisputed(db,customer))return;
  const rows=await db.prepare(`SELECT DISTINCT subscription_id FROM supporter_dunning WHERE customer_id=? AND status='suspended' AND invoice_id NOT LIKE 'hold:%'`).bind(customer).all();
  const stopped=new Set((rows.results||[]).map(row=>row.subscription_id));
  for(const subscription of await subscriptions(env,customer))
   if(subscription?.metadata?.dpi_service_pause==='dunning'&&!stopped.has(subscription.id))await stripe(env,`subscriptions/${encodeURIComponent(subscription.id)}`,pauseParams(false));
 }catch(error){console.error('Supporter service resume failed; the billing schedule retries it',{errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
}
// 停止から1か月たっても支払われない契約を解約し、未払いの請求書を取り消す。請求書・契約を Stripe で確かめてから行う。
async function cancelLongUnpaid(env,db,now){
 const rows=await db.prepare(`SELECT * FROM supporter_dunning WHERE status='suspended' AND invoice_id NOT LIKE 'hold:%' AND subscription_id IS NOT NULL
  AND suspended_at<=? ORDER BY suspended_at LIMIT 50`).bind(now-27*86400).all();
 let canceled=0,voidedAmount=0;
 for(const row of rows.results||[]){
  if(now<autoCancelAt(row.suspend_at))continue;
  try{
   const invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}`);
   if(!['open','uncollectible','void'].includes(invoice.status)||stripeId(invoice.customer)!==row.customer_id||invoiceSubscriptionId(invoice)!==row.subscription_id)continue;
   const subscription=await stripe(env,`subscriptions/${encodeURIComponent(row.subscription_id)}`);
   if(stripeId(subscription.customer)!==row.customer_id)continue;
   const ended=['canceled','incomplete_expired'].includes(subscription.status),marked=subscription.metadata?.dpi_auto_cancel===row.invoice_id;
   if(invoice.status==='void'&&!ended&&!marked){
    // 管理者が請求を取り消したもの。自動解約の途中ではないので、停止を解いて契約を続ける。
    await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=? AND status='suspended'`).bind(now,row.invoice_id).run();
    await resumeServicePause(env,db,row.customer_id);continue;
   }
   // 先に請求書を取り消す。直前に支払われていれば取り消しが失敗するので、支払った人を解約しない。
   // 取り消した後に処理が落ちても、契約に付けた印から次回に解約を続ける。
    if(invoice.status!=='void'){
    if(!ended&&!marked)await stripe(env,`subscriptions/${encodeURIComponent(row.subscription_id)}`,{'metadata[dpi_auto_cancel]':row.invoice_id});
    const voided=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}/void`,{});
     if(voided.status!=='void')continue;voidedAmount+=Number(voided.amount_remaining||voided.amount_due||row.amount_due)||0;
   }
   if(!ended){
    const attached=scheduleId(subscription);
    if(attached)await stripe(env,`subscription_schedules/${encodeURIComponent(attached)}/release`,{});
    await stripe(env,`subscriptions/${encodeURIComponent(row.subscription_id)}`,{invoice_now:'false',prorate:'false'},null,'DELETE');
   }
   await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=? AND status='suspended'`).bind(now,row.invoice_id).run();
   canceled+=1;
   try{await sendBillingNotification(env,db,'auto_canceled',invoice);}catch(error){console.error('Supporter automatic cancellation email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}
  }catch(error){console.error('Supporter automatic cancellation failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
 }
 return{count:canceled,voidedAmount};
}
// 停止中の請求書を Stripe と照合する（支払い完了の Webhook を取りこぼしても再開できるように）。
async function reconcileSuspendedInvoices(env,db,customer=null,limit=50,nowSeconds=Math.floor(Date.now()/1000)){
 const query=`SELECT invoice_id,suspend_at FROM supporter_dunning WHERE status='suspended' AND invoice_id NOT LIKE 'hold:%'`;
 const rows=customer?await db.prepare(`${query} AND customer_id=? ORDER BY updated_at LIMIT ?`).bind(customer,limit).all()
  :await db.prepare(`${query} ORDER BY updated_at LIMIT ?`).bind(limit).all();
 let resumed=0;
 for(const row of rows.results||[]){
  const now=nowSeconds;
  try{
   const invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}`);
   if(invoice.status==='void'){
    // 自動解約の時刻を過ぎたものは、解約の続きか管理者の取り消しかを cancelLongUnpaid で確かめる。
    if(now>=autoCancelAt(row.suspend_at))continue;
    await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=? AND status='suspended'`).bind(now,row.invoice_id).run();resumed+=1;await resumeServicePause(env,db,clean(stripeId(invoice.customer)));}
   else if(invoice.status==='paid'){
    resumed+=1;
    try{await recordInvoicePaid(env,db,invoice);}catch(error){console.error('Supporter payment success email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}
   }else await db.prepare(`UPDATE supporter_dunning SET updated_at=? WHERE invoice_id=? AND status='suspended'`).bind(now,row.invoice_id).run();
  }catch(error){console.error('Supporter suspended invoice check failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
 }
 return resumed;
}
async function runBillingScheduleTasks(env,db,nowMs){
 const now=Math.floor(Number(nowMs)/1000);let retried=0,paid=0,failed=0,suspended=0;
 // 再決済の途中で処理が落ちた行を戻す（次の確認で、支払い済みかどうかを Stripe に聞いてから進む）。
 await db.prepare(`UPDATE supporter_dunning SET status='retry_scheduled',retry_attempted_at=NULL,updated_at=? WHERE status='retrying' AND updated_at<=?`).bind(now,now-1800).run();
 // 停止の巻き添え（別の請求書が停止中）で先に停止した行も、本来の月末に1回だけ再決済する。
 const due=await db.prepare(`SELECT * FROM supporter_dunning WHERE invoice_id NOT LIKE 'hold:%' AND retry_at<=?
  AND (status='retry_scheduled' OR (status='suspended' AND retry_attempted_at IS NULL AND suspended_at<retry_at))
  AND NOT EXISTS (SELECT 1 FROM supporter_dunning x WHERE x.customer_id=supporter_dunning.customer_id AND x.invoice_id LIKE 'hold:dispute:%' AND x.status='suspended')
  ORDER BY retry_at LIMIT 300`).bind(now).all();
 await queueRenewalNotices(env,db,now);
 const runDay=jstDate(now),retryRun=(due.results||[]).length>0||(runDay.day===runDay.lastDay&&runDay.hour>=12);
 if(retryRun){
   await queueNotice(env,db,{id:`retry-start:${runDay.key}:${runDay.hour}`,channel:'billing',kind:'retry_start',title:'再請求を開始',tone:'info',at:now,
    lines:['【対象】',`対象: ${(due.results||[]).length}件（合計 ${yen((due.results||[]).reduce((sum,row)=>sum+(Number(row.amount_due)||0),0))}）`,'【次の予定】','支払いを確認できないものは翌月1日 0時に停止します']});
  await flushNotices(env,db);
 }
 let paidAmount=0,failedAmount=0,postponed=0;
 for(const row of due.results||[]){
  const claim=await db.prepare(`UPDATE supporter_dunning SET status=CASE WHEN status='suspended' THEN 'suspended' ELSE 'retrying' END,retry_attempted_at=?,updated_at=?
   WHERE invoice_id=? AND status IN ('retry_scheduled','suspended') AND retry_attempted_at IS NULL`).bind(now,now,row.invoice_id).run();
  if(!claim.meta?.changes)continue;retried+=1;
  let invoice=null,paymentError=null;
  try{
   // Stripe は同じ冪等キーには前回の応答（500 も）を返す。先に請求書の状態を確かめ、試行した時刻ごとのキーで支払う。
   invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}`);
   if(invoice?.status==='void'){await db.prepare(`UPDATE supporter_dunning SET status='closed',updated_at=? WHERE invoice_id=?`).bind(now,row.invoice_id).run();continue;}
   if(invoice?.status!=='paid'){
    const holder=await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(row.customer_id).first();
    if(holder?.discord_user_id&&Number(invoice.amount_remaining)>0){
     // 残高不足・対象外（409・403）のときだけカードを試す。引き落とし済みで結果が不明なときは、カードに課金せず次回に続ける。
     try{invoice=(await payInvoiceWithCredits(env,db,row.customer_id,holder.discord_user_id,row.invoice_id)).invoice;}
     catch(error){if(![403,409].includes(error?.status))throw error;}
    }
    if(invoice?.status!=='paid')invoice=await stripe(env,`invoices/${encodeURIComponent(row.invoice_id)}/pay`,{},`dpi-month-end-retry-${row.invoice_id}-${Math.floor(now/3600)}`);
   }
  }catch(error){paymentError=error;console.error('Supporter month-end payment retry failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
  if(invoice?.status==='paid'){
   try{await recordInvoicePaid(env,db,invoice);}catch(error){console.error('Supporter payment success email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}paid+=1;paidAmount+=Number(invoice.amount_paid||row.amount_due)||0;continue;
  }
  const confirmedPaymentFailure=paymentError&&Number(paymentError.stripeStatus)===402&&!!clean(paymentError.stripeCode);
  if(paymentError&&!confirmedPaymentFailure){
   await db.prepare(`UPDATE supporter_dunning SET status=CASE WHEN status='retrying' THEN 'retry_scheduled' ELSE status END,retry_attempted_at=NULL,updated_at=? WHERE invoice_id=? AND status IN ('retrying','suspended')`).bind(now,row.invoice_id).run();
   postponed+=1;continue;
  }
  const fallback=invoice||{id:row.invoice_id,customer:row.customer_id,subscription:row.subscription_id,amount_due:row.amount_due,currency:row.currency};
  await db.prepare(`UPDATE supporter_dunning SET status='suspend_scheduled',updated_at=? WHERE invoice_id=? AND status='retrying'`).bind(now,row.invoice_id).run();failed+=1;failedAmount+=Number(row.amount_due)||0;
  try{await sendBillingNotification(env,db,'final_failed',fallback,row.retry_at,row.suspend_at);}catch(error){console.error('Supporter final payment failure email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}
 }
 let grouped=null;
 try{grouped=await syncServiceHolds(env,db,now);}catch(error){console.error('Supporter service hold check failed',{errorName:error?.name||'Error',stripeStatus:Number(error?.stripeStatus)||null});}
 if(retryRun){
  const summaries=new Map(grouped?[...grouped.values()].flat().map(item=>[item.subscriptionId,item]):[]),retryPlans=Object.fromEntries(['Basic','Plus','Pro','カスタム'].map(name=>[name,0]));
  for(const row of due.results||[]){const summary=summaries.get(row.subscription_id);if(summary)retryPlans[planKey(summary)]+=1;}
  await queueNotice(env,db,{id:`retry-result:${runDay.key}:${runDay.hour}`,channel:'billing',kind:'retry_result',title:'再請求の結果',tone:failed||postponed?'warn':'good',at:now,
   lines:['【結果】',`対象: ${(due.results||[]).length}件（${yen((due.results||[]).reduce((sum,row)=>sum+Number(row.amount_due||0),0))}）`,`成功: ${paid}件（${yen(paidAmount)}）`,`失敗: ${failed}件（${yen(failedAmount)}）`,`保留: ${postponed}件`,`成功率: ${percent(paid,paid+failed+postponed)}`,grouped?'【プラン別】':'',...(grouped?Object.entries(retryPlans).map(([name,count])=>`${name}: ${count}件`):[]),...(failed||postponed?['【次の予定】',...(postponed?['保留: Stripe の障害などのため、次回もう一度確認します']:[]),runDay.day===1?'支払いを確認できないものは停止します':'支払いを確認できないものは、翌月1日 0時に停止します']:[])]});
 }
 // 翌月1日0時を過ぎても支払いを確認できないものは、再決済の結果を待たずに必ず停止する。
 const unfinished=await db.prepare(`SELECT * FROM supporter_dunning WHERE status='retry_scheduled' AND suspend_at<=? ORDER BY suspend_at LIMIT 100`).bind(now).all();
 const stopped=await db.prepare(`UPDATE supporter_dunning SET status='suspended',suspended_at=?,updated_at=? WHERE status IN ('suspend_scheduled','retry_scheduled') AND suspend_at<=?`).bind(now,now,now).run();
 suspended+=Number(stopped.meta?.changes||0);
 for(const row of unfinished.results||[]){
  try{await sendBillingNotification(env,db,'final_failed',{id:row.invoice_id,customer:row.customer_id,subscription:row.subscription_id,amount_due:row.amount_due,currency:row.currency},row.retry_at,row.suspend_at);}
  catch(error){console.error('Supporter suspension email failed',{invoiceId:row.invoice_id,errorName:error?.name||'Error'});}
 }
 const resumed=await reconcileSuspendedInvoices(env,db,null,50,now);
 await reconcileDisputeHolds(env,db);
 if(grouped)await syncServicePauses(env,db,grouped);
 const canceled=await cancelLongUnpaid(env,db,now);
 await queueStopNotices(env,db,now,{suspended,autoCanceled:canceled.count,voidedAmount:canceled.voidedAmount,resumed,grouped});
 const failedNotices=await db.prepare(`SELECT invoice_id,kind,attempts,last_error,updated_at FROM supporter_billing_notifications
  WHERE status='failed' AND attempts<5 AND updated_at>=? AND kind IN ('payment_succeeded','payment_failed','retry_succeeded','final_failed','auto_canceled','credit_topup_succeeded','credit_topup_failed','credit_plan_payment_succeeded','credit_expired')
  ORDER BY updated_at LIMIT 25`).bind(now-3*86400).all();
 for(const row of failedNotices.results||[]){
  const firstFailed=Number(String(row.last_error||'').match(/^(\d+):/)?.[1]||row.updated_at||0);
  if(!firstFailed||now-firstFailed>3*86400)continue;
  try{
   const restored=await restoreFailedBillingNotice(env,db,row);
   if(restored)await sendBillingNotification(env,db,row.kind,restored.invoice,restored.retryAt,restored.suspendAt);
  }catch(error){console.error('Supporter billing email retry failed',{invoiceId:row.invoice_id,kind:row.kind,errorName:error?.name||'Error'});}
 }
 try{await retryAdminNotices(env,db,25,now);}catch(error){console.error('Supporter admin email retry failed',{errorName:error?.name||'Error'});}
 const disciplinaryNotices=await db.prepare(`SELECT d.request_id,d.discord_user_id,d.action,d.reason,d.canceled_subscriptions,d.confiscated_credits,a.billing_email
  FROM supporter_disciplinary_actions d JOIN supporter_accounts a ON a.discord_user_id=d.discord_user_id
  WHERE d.status='completed' AND d.email_status IN ('pending','failed') ORDER BY d.updated_at LIMIT 25`).all();
 for(const row of disciplinaryNotices.results||[]){
  try{const sent=await sendSupporterDisciplinaryNotification(env,db,row.action,{requestId:row.request_id,uid:row.discord_user_id,email:row.billing_email,reason:row.reason,canceledSubscriptions:row.canceled_subscriptions,confiscatedCredits:row.confiscated_credits});await db.prepare(`UPDATE supporter_disciplinary_actions SET email_status=?,last_error=NULL,updated_at=? WHERE request_id=?`).bind(sent?'sent':'skipped',now,row.request_id).run();}
  catch(error){console.error('Supporter disciplinary email retry failed',{requestId:row.request_id,errorName:error?.name||'Error'});}
 }
 const expiredCredits=await expirePurchasedCredits(env,db);
 await recoverCustomPriceChanges(env,db);
 return {retried,paid,failed,suspended,autoCanceled:canceled.count,expiredCredits};
}

async function restoreFailedBillingNotice(env,db,row){
 const id=clean(row.invoice_id),kind=clean(row.kind);
 if(['payment_failed','retry_succeeded','final_failed','auto_canceled'].includes(kind)){
  const d=await db.prepare('SELECT * FROM supporter_dunning WHERE invoice_id=?').bind(id).first();if(!d)return null;
  const allowed={payment_failed:['retry_scheduled','retrying'],retry_succeeded:['paid'],final_failed:['suspend_scheduled','suspended'],auto_canceled:['closed']}[kind];
  // 状態が進んだ後に古い失敗案内を送らない。督促状態が通知の意味と一致する場合だけ復元する。
  if(!allowed.includes(d.status))return null;
  return{invoice:{id,customer:d.customer_id,subscription:d.subscription_id,amount_due:d.amount_due,amount_paid:kind==='retry_succeeded'?d.amount_due:0,currency:d.currency},retryAt:d.retry_at,suspendAt:d.suspend_at};
 }
 if(kind==='payment_succeeded'){
  const invoice=id.startsWith('in_')?await stripe(env,`invoices/${encodeURIComponent(id)}`):id.startsWith('cs_')?await stripe(env,`checkout/sessions/${encodeURIComponent(id)}`):null;
  if(!invoice||(id.startsWith('in_')?invoice.status!=='paid':invoice.payment_status!=='paid'))return null;
  return{invoice:{...invoice,amount_paid:Number(invoice.amount_paid??invoice.amount_total??0),credit_applied:Number(checkoutMetadata(invoice).dpi_credit_applied||0)}};
 }
 if(['credit_topup_succeeded','credit_topup_failed'].includes(kind)){
  if(!id.startsWith('cs_'))return null;
  const topup=await db.prepare('SELECT customer_id,amount,currency,status,expires_at FROM supporter_credit_topups WHERE checkout_session_id=?').bind(id).first();if(!topup)return null;
  const expected=kind==='credit_topup_succeeded'?'credited':'failed';if(topup.status!==expected)return null;
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(id)}`);
  if(kind==='credit_topup_succeeded'&&session.payment_status!=='paid'||kind==='credit_topup_failed'&&session.payment_status==='paid')return null;
  return{invoice:{id,customer:topup.customer_id,amount_paid:kind==='credit_topup_succeeded'?topup.amount:0,amount_due:topup.amount,currency:topup.currency||'jpy',expires_at:topup.expires_at}};
 }
 if(kind==='credit_plan_payment_succeeded'&&id.startsWith('credit-signup:')){
  const signup=await db.prepare('SELECT customer_id,amount,billing_anchor,status FROM supporter_credit_signups WHERE request_id=?').bind(id.slice(14)).first();
  return signup?.status==='provisioned'?{invoice:{id,customer:signup.customer_id,amount_paid:signup.amount,currency:'jpy',next_renewal_at:signup.billing_anchor}}:null;
 }
 if(kind==='credit_expired'&&id.startsWith('expiry:')){
  const lot=await db.prepare(`SELECT l.original_amount,l.expires_at,l.status,b.customer_id,ABS(e.credit_delta) AS expired_amount FROM supporter_credit_lots l
   JOIN supporter_billing b ON b.discord_user_id=l.discord_user_id LEFT JOIN supporter_credit_events e ON e.id=('expiry:'||l.id) WHERE l.id=?`).bind(id.slice(7)).first();
  return lot?.status==='expired'?{invoice:{id,customer:lot.customer_id,amount_due:Number(lot.expired_amount??lot.original_amount),currency:'jpy',expires_at:lot.expires_at}}:null;
 }
 // 処分通知など、元の宛先・本文をこの表だけから安全に復元できない種類はここでは再送しない。
 return null;
}

/** Custom monthly checkout. A 24-hour single-user session is used,
 * never a reusable open-amount Stripe Payment Link. */
export function customInitialCheckoutParams(customer,uid,offer,requestId,now=Date.now(),origin='https://dpi-bot.com'){
 const schedule=billingSchedule(now);
 if(!customer||!/^\d{17,20}$/.test(uid)||offer?.status!=='offered'
  ||!Number.isInteger(Number(offer.confirmed_yen))||Number(offer.confirmed_yen)<100)
  fail('カスタムプランの提供内容を確認してください。',409);
 const amount=Number(offer.confirmed_yen)*schedule.initialMonths;
 if(!Number.isSafeInteger(amount)||amount>2000000)fail('初回の請求額が上限を超えています。',409);
 return {
  mode:'payment',customer,client_reference_id:uid,...SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS,
  'line_items[0][price_data][currency]':'jpy',
  'line_items[0][price_data][unit_amount]':String(amount),
  'line_items[0][price_data][product_data][name]':`${String(offer.name||'カスタムプラン').slice(0,55)} 初回利用料`,
  'line_items[0][quantity]':'1',
  'payment_intent_data[setup_future_usage]':'off_session',
  'metadata[dpi_checkout_kind]':'custom_subscription_initial',
  'metadata[dpi_custom_id]':offer.id,
  'metadata[dpi_custom_revision]':String(offer.revision),
  'metadata[dpi_custom_monthly_yen]':String(offer.confirmed_yen),
  'metadata[dpi_initial_months]':String(schedule.initialMonths),
  'metadata[dpi_initial_amount_yen]':String(amount),
  'metadata[dpi_billing_anchor]':String(schedule.anchor),
  'metadata[dpi_user]':uid,'metadata[dpi_request_id]':requestId,
  'payment_intent_data[metadata][dpi_checkout_kind]':'custom_subscription_initial',
  'payment_intent_data[metadata][dpi_user]':uid,
  'payment_intent_data[metadata][dpi_custom_id]':offer.id,
  success_url:`${origin}/site/supporter/?custom=completed`,
  cancel_url:`${origin}/site/supporter/?custom=canceled`,
  expires_at:String(Math.floor(now/1000)+86400-300),
  integration_identifier:integrationIdentifier('dpi_custom_'),
 };
}
export async function createCustomCheckout(env,customer,uid,offer,requestId){
 if(!billingReady(env))fail('Stripe接続を確認できません。',503);
 const input=customInitialCheckoutParams(customer,uid,offer,requestId,Date.now(),actionOrigin(env));
 const checkout=await stripe(env,'checkout/sessions',input,`dpi-custom-checkout-${offer.id}-${offer.revision}-${requestId}`);
 if(!checkout.url||checkout.mode!=='payment'||checkout.status!=='open'
  ||Number(checkout.amount_total)!==Number(input['line_items[0][price_data][unit_amount]']))
  fail('Stripe専用決済セッションの初回金額を確認できませんでした。',502);
 return {id:checkout.id,url:checkout.url,expiresAt:checkout.expires_at,
  amount:Number(input['line_items[0][price_data][unit_amount]'])};
}
export async function expireCustomCheckout(env,sessionId,key){
 if(!sessionId)return;
 const session=await stripe(env,`checkout/sessions/${encodeURIComponent(sessionId)}`);
 if(session.status==='open')await stripe(env,`checkout/sessions/${encodeURIComponent(sessionId)}/expire`,{},key);
 else if(session.status==='complete'||session.payment_status==='paid')fail('この決済はすでに処理済みのため無効化できません。Stripeと契約状態を確認してください。',409);
}
export async function cancelCustomSubscription(env,subscriptionId,key){
 if(!subscriptionId)return;
 const item=await stripe(env,`subscriptions/${encodeURIComponent(subscriptionId)}`);
 if(!['canceled','incomplete_expired'].includes(item.status))
  await stripe(env,`subscriptions/${encodeURIComponent(subscriptionId)}`,{},key,'DELETE');
}


/** Restrict managed price mutations to a single paid monthly Stripe item.
 * No discounts/schedules/multi-item subscriptions: these need manual settlement
 * rather than quietly producing the wrong amount or resetting renewal dates. */
export async function verifiedCustomSubscription(env,customer,uid,offer){
 if(!billingReady(env)||!offer?.stripe_subscription_id)fail('カスタム契約のStripe情報を確認できません。',409);
 const subscription=await stripe(env,`subscriptions/${encodeURIComponent(offer.stripe_subscription_id)}`);
 const realCustomer=stripeId(subscription.customer),items=subscription.items?.data||[];
 const item=items[0],meta=subscription.metadata||{};
 if(subscription.livemode!==expectedLivemode(env)||realCustomer!==customer||meta.dpi_user!==uid
  ||meta.dpi_custom_id!==offer.id||!['active'].includes(subscription.status)
  ||subscription.pending_update||scheduleId(subscription)||cancelScheduled(subscription)
  ||items.length!==1||!item?.id||Number(item.quantity)!==1
  ||item.price?.currency!=='jpy'||item.price?.recurring?.interval!=='month'
  ||Number(item.price?.recurring?.interval_count||1)!==1
  ||!/^prod_/.test(stripeId(item.price?.product))||subscription.discounts?.length
  ||subscription.collection_method!=='charge_automatically'
 )fail('Stripe契約に未処理請求・予約変更・複数料金・割引等があるため自動変更できません。内容をご確認ください。',409);
 const lastInvoiceId=stripeId(subscription.latest_invoice);
 if(lastInvoiceId){
  const invoice=await stripe(env,`invoices/${encodeURIComponent(lastInvoiceId)}`);
  if(invoice.livemode!==expectedLivemode(env)||invoice.status!=='paid'||stripeId(invoice.customer)!==customer
   ||invoice.currency!=='jpy'||Number(invoice.amount_remaining||0)!==0
   ||invoiceSubscriptionId(invoice)!==subscription.id)
   fail('最新の月額料金の支払い完了を確認できません。未払いや別契約の請求書を確認してください。',409);
 }else{
  // A subscription created after a fully paid one-off initial Checkout
  // has no invoice until its first 26th renewal. Verify that *paid*
  // Checkout directly rather than rejecting legitimate early upgrades.
  const initialId=clean(meta.dpi_custom_initial_session);
  if(!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(initialId))
   fail('初回請求の支払済みセッションを確認できません。',409);
  const checkout=await stripe(env,`checkout/sessions/${encodeURIComponent(initialId)}`);
  const checkoutMeta=checkoutMetadata(checkout);
  const firstMonths=Number(checkoutMeta.dpi_initial_months);
  const initialRevision=Number(checkoutMeta.dpi_custom_revision),initialMonthly=Number(checkoutMeta.dpi_custom_monthly_yen);
  if(checkout.livemode!==expectedLivemode(env)||checkout.mode!=='payment'
   ||checkout.status!=='complete'||checkout.payment_status!=='paid'
   ||stripeId(checkout.customer)!==customer||checkout.client_reference_id!==uid
   ||checkoutMeta.dpi_checkout_kind!=='custom_subscription_initial'
   ||checkoutMeta.dpi_custom_id!==offer.id
   // 最初の26日より前に料金を変更済みなら、初回決済は変更前の条件（古い改訂番号）のまま。初回の条件どうしで確かめる。
   ||!(initialRevision>=1&&initialRevision<=Number(offer.revision))
   ||(initialRevision===Number(offer.revision)&&initialMonthly!==Number(offer.confirmed_yen))
   ||!(initialMonthly>=100)||!([1,2].includes(firstMonths))
   ||Number(checkout.amount_total)!==initialMonthly*firstMonths
   ||checkout.currency!=='jpy')
   fail('カスタム初回Checkoutの支払完了・契約情報を確認できません。',409);
 }
 return subscription;
}
export async function createCustomDifferenceCheckout(env,customer,uid,offer,change){
 if(!billingReady(env)||change.status!=='pending'||Number(change.amount_due_yen)<50)
  fail('差額決済は50円以上で作成してください。50円未満の変更は運営者が請求方法を確認してください。',409);
 const amount=Number(change.amount_due_yen);
 const origin=actionOrigin(env),now=Math.floor(Date.now()/1000);
 const checkout=await stripe(env,'checkout/sessions',{
  mode:'payment',customer,client_reference_id:uid,...SUBSCRIPTION_EXCLUDED_PAYMENT_METHODS,
  'line_items[0][price_data][currency]':'jpy',
  'line_items[0][price_data][unit_amount]':String(amount),
  'line_items[0][price_data][product_data][name]':`${offer.name} 当月分変更差額`.slice(0,80),
  'line_items[0][quantity]':'1',
  'payment_intent_data[metadata][dpi_custom_change]':change.request_id,
  'metadata[dpi_checkout_kind]':'custom_change',
  'metadata[dpi_user]':uid,
  'metadata[dpi_custom_id]':offer.id,
  'metadata[dpi_change_request]':change.request_id,
  'metadata[dpi_custom_revision]':String(change.old_revision),
  'metadata[dpi_new_monthly]':String(change.next_monthly_yen),
  'metadata[dpi_old_monthly]':String(change.old_monthly_yen),
  expires_at:String(now+86400-300),
  success_url:`${origin}/site/supporter/?custom=change-completed`,
  cancel_url:`${origin}/site/supporter/?custom=change-canceled`,
  integration_identifier:integrationIdentifier('dpi_custom_change_'),
 },`dpi-custom-difference-${change.request_id}`);
 if(!checkout.url||checkout.mode!=='payment'||checkout.status!=='open')fail('Stripeの差額決済URLの生成に失敗しました。',502);
 return {id:checkout.id,url:checkout.url,expiresAt:Number(checkout.expires_at)};
}
export async function customDifferenceCheckoutUrl(env,customer,uid,offer,change){
 if(!change||change.status!=='pending'||!change.checkout_session_id)return '';
 const checkout=await stripe(env,`checkout/sessions/${encodeURIComponent(change.checkout_session_id)}`);
 const url=clean(checkout.url);
 let valid=false;try{const parsed=new URL(url);valid=parsed.protocol==='https:'&&parsed.hostname==='checkout.stripe.com';}catch{}
 return valid&&checkout.status==='open'&&Number(checkout.expires_at)>Date.now()/1000
  &&stripeId(checkout.customer)===customer&&checkout.client_reference_id===uid
  &&checkout.mode==='payment'&&checkout.metadata?.dpi_change_request===change.request_id
  &&checkout.metadata?.dpi_custom_id===offer.id&&Number(checkout.amount_total)===Number(change.amount_due_yen)
  ?url:'';
}
export async function applyCustomStripePrice(env,customer,uid,offer,change){
 const subscription=await verifiedCustomSubscription(env,customer,uid,offer);
 const item=subscription.items?.data?.[0];
 const meta=subscription.metadata||{};
 if(Number(meta.dpi_custom_revision)===Number(change.next_revision)
  &&Number(item.price.unit_amount)===Number(change.next_monthly_yen))return subscription;
 if(Number(meta.dpi_custom_revision)!==Number(change.old_revision)
  ||Number(item.price.unit_amount)!==Number(change.old_monthly_yen)
  ||Number(change.old_revision)!==Number(offer.revision))
  fail('Stripe契約の料金・改訂番号が変更されています。自動変更を停止しました。',409);
 const metadata={
  proration_behavior:'none', // 請求日は指定しなければ変わらない（今の Stripe API では 'unchanged' を受け付けない）
  payment_behavior:'error_if_incomplete',
  'metadata[dpi_custom_revision]':String(change.next_revision),
  'metadata[dpi_updated_by]':'admin',
  'metadata[dpi_custom_change_request]':change.request_id,
 };
 const priceParams=Number(change.next_monthly_yen)===Number(change.old_monthly_yen)?{}:{
  'items[0][id]':item.id,
  'items[0][price_data][currency]':'jpy',
  'items[0][price_data][unit_amount]':String(change.next_monthly_yen),
  'items[0][price_data][product]':stripeId(item.price.product),
  'items[0][price_data][recurring][interval]':'month',
  'items[0][quantity]':'1',
 };
 const updated=await stripe(env,`subscriptions/${encodeURIComponent(subscription.id)}`,
  {...priceParams,...metadata},`dpi-custom-recurring-${change.request_id}`);
 if(updated.pending_update||Number(updated.items?.data?.[0]?.price?.unit_amount)!==Number(change.next_monthly_yen)
  ||Number(updated.metadata?.dpi_custom_revision)!==Number(change.next_revision))fail('Stripe契約料金の切替結果を確認できませんでした。',502);
 return updated;
}
/** Idempotent recovery: checkout is fetched from Stripe, not trusted from
 * the webhook payload. A paid change stays in D1 until a recurring price
 * update AND local limits can be committed. */
export async function settleCustomPriceChange(env,db,uid,requestId){
 let change=await getCustomChange(db,requestId);
 if(!change||change.discord_user_id!==uid)fail('料金変更要求が見つかりません。',404);
 if(change.status==='applied')return {applied:true,change};
 if(!['pending','paid'].includes(change.status))fail('無効な料金変更要求です。',409);
 const row=await getCustomPlan(db,uid);
 const customer=change.stripe_customer_id;
 const binding=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(!row||row.status!=='active'||row.id!==change.custom_plan_id
  ||row.stripe_subscription_id!==change.stripe_subscription_id
  ||binding?.customer_id!==customer)fail('契約ユーザーとStripeの紐付けを確認できません。',409);
 if(change.status==='pending'){
  if(!change.checkout_session_id)return {applied:false,pending:true,change};
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(change.checkout_session_id)}`);
  if(session.mode!=='payment'||session.status!=='complete'||session.payment_status!=='paid'
   ||session.currency!=='jpy'||stripeId(session.customer)!==customer||session.client_reference_id!==uid
   ||Number(session.amount_total)!==Number(change.amount_due_yen)
   ||session.metadata?.dpi_checkout_kind!=='custom_change'
   ||session.metadata?.dpi_user!==uid||session.metadata?.dpi_custom_id!==row.id
   ||session.metadata?.dpi_change_request!==change.request_id
   ||Number(session.metadata?.dpi_custom_revision)!==Number(change.old_revision))
   return {applied:false,pending:true,change};
  await db.prepare(`UPDATE supporter_custom_plan_changes SET status='paid',updated_at=?
   WHERE request_id=? AND status='pending'`).bind(new Date().toISOString(),requestId).run();
  change=await getCustomChange(db,requestId);
 }
 if(change.status!=='paid')return {applied:change.status==='applied',change};
 // Protect already applied requests from a repeated Stripe mutation.
 if(row.revision===Number(change.next_revision)
  &&Number(row.confirmed_yen)===Number(change.next_monthly_yen)){
  await db.prepare(`UPDATE supporter_custom_plan_changes SET status='applied',updated_at=?
   WHERE request_id=? AND status='paid'`).bind(new Date().toISOString(),requestId).run();
  return {applied:true,change:await getCustomChange(db,requestId)};
 }
 if(row.revision!==Number(change.old_revision)||Number(row.confirmed_yen)!==Number(change.old_monthly_yen))
  fail('変更中に契約状態が更新されたため差額の適用を保留しました。',409);
 await applyCustomStripePrice(env,customer,uid,row,change);
 const plan=await commitCustomChange(db,change);
 return {applied:true,plan,change:await getCustomChange(db,requestId)};
}
export async function recoverCustomPriceChanges(env,db,uid){
 if(!billingReady(env))return [];
 const rows=uid?
  (await db.prepare(`SELECT request_id FROM supporter_custom_plan_changes WHERE discord_user_id=?
    AND status IN ('pending','paid') ORDER BY created_at LIMIT 4`).bind(uid).all()).results||[]:
  (await db.prepare(`SELECT request_id,discord_user_id FROM supporter_custom_plan_changes WHERE
    status IN ('pending','paid') ORDER BY updated_at LIMIT 15`).all()).results||[];
 const results=[];
 for(const row of rows){
  try{results.push(await settleCustomPriceChange(env,db,uid||row.discord_user_id,row.request_id));}
  catch(error){console.error('Custom plan price settlement deferred',{requestId:row.request_id,errorName:error?.name||'Error'});}
 }
 return results;
}


/** Create exactly one fixed-26th custom subscription *after* an initial
 * payment-mode Checkout has succeeded. All Stripe mutations have stable
 * idempotency keys; replays reconcile instead of starting another contract. */
export async function provisionCustomPaidCheckoutSubscription(env,db,session){
 const meta=checkoutMetadata(session);
 if(session?.mode!=='payment'||session.payment_status!=='paid'
  ||session.status!=='complete'||meta.dpi_checkout_kind!=='custom_subscription_initial')return null;
 const uid=clean(meta.dpi_user),customer=stripeId(session.customer);
 if(!/^\d{17,20}$/.test(uid)||!customer||session.client_reference_id!==uid)
  fail('カスタム契約の決済対象者が一致しません。',409);
 {
  // 既にこの決済から契約を作っていれば（解約済みでも）作り直さない。Webhook の再送で 409 を繰り返さない。
  const all=await allSubscriptions(env,customer);
  const prior=liveSubscriptions(all).find(x=>x.metadata?.dpi_custom_initial_session===session.id);
  if(prior)return prior;
  if(all.some(x=>x.metadata?.dpi_custom_initial_session===session.id))return null;
 }
 const offer=await getCustomPlan(db,uid);
 const billing=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const monthly=Number(meta.dpi_custom_monthly_yen),months=Number(meta.dpi_initial_months);
 if(!offer||offer.id!==meta.dpi_custom_id||!['offered','active'].includes(offer.status)
  ||billing?.customer_id!==customer||Number(meta.dpi_custom_revision)!==Number(offer.revision)
  ||monthly!==Number(offer.confirmed_yen)||!Number.isInteger(months)||!([1,2].includes(months))
  ||String(session.currency).toLowerCase()!=='jpy'
  ||months*monthly!==Number(session.amount_total)
  ||Number(meta.dpi_initial_amount_yen)!==Number(session.amount_total))
  fail('カスタム契約または初回決済額が変更されています。手動で精算を確認してください。',409);
 const existing=await subscriptions(env,customer);
 const prior=existing.find(x=>x.metadata?.dpi_custom_id===offer.id
  &&Number(x.metadata?.dpi_custom_revision)===Number(offer.revision)
  &&x.metadata?.dpi_custom_initial_session===session.id);
 if(prior)return prior;
 if(existing.some(x=>!['canceled','incomplete_expired'].includes(x.status))
  ||offer.status!=='offered'||offer.stripe_subscription_id)
  fail('別のStripe契約が残っているため月額契約を追加しません。',409);
 const now=Math.floor(Date.now()/1000),anchor=Number(meta.dpi_billing_anchor);
 if(!Number.isInteger(anchor)||anchor<=now+60||anchor>now+70*86400)
  fail('次回26日の請求日が過ぎています。二重請求回避のため手動対応してください。',409);
 const paymentIntentId=stripeId(session.payment_intent);
 if(!paymentIntentId)fail('カスタムプランの初回支払い情報がありません。',502);
 const intent=await stripe(env,`payment_intents/${encodeURIComponent(paymentIntentId)}`);
 const paymentMethod=stripeId(intent.payment_method);
 if(intent.status!=='succeeded'||!paymentMethod||stripeId(intent.customer)!==customer
  ||Number(intent.amount_received)!==Number(session.amount_total))
  fail('初回決済の入金・支払い方法を照合できません。',409);
 const product=await stripe(env,'products',{
  name:`DPI-Bot カスタムプラン ${String(offer.name||'').slice(0,65)}`,
  'metadata[dpi_custom_id]':offer.id,'metadata[dpi_user]':uid,
 },`dpi-custom-product-${offer.id}`);
 if(!/^prod_/.test(product.id||'')||product.livemode!==expectedLivemode(env))
  fail('Stripeの商品情報を作成できませんでした。',502);
 const result=await stripe(env,'subscriptions',{
  customer,default_payment_method:paymentMethod,collection_method:'charge_automatically',
  billing_cycle_anchor:String(anchor),proration_behavior:'none',
  payment_behavior:'error_if_incomplete','billing_mode[type]':'flexible',
  'items[0][price_data][currency]':'jpy',
  'items[0][price_data][unit_amount]':String(monthly),
  'items[0][price_data][product]':product.id,
  'items[0][price_data][recurring][interval]':'month',
  'items[0][quantity]':'1',
  'metadata[dpi_user]':uid,'metadata[dpi_custom_id]':offer.id,
  'metadata[dpi_custom_revision]':String(offer.revision),
  'metadata[dpi_custom_initial_session]':session.id,
 },`dpi-custom-initial-sub-${session.id}`);
 if(!['active','trialing'].includes(result.status)||stripeId(result.customer)!==customer
  ||result.metadata?.dpi_custom_id!==offer.id
  ||Number(result.items?.data?.[0]?.price?.unit_amount)!==monthly)
  fail('作成後の月額契約を検証できませんでした。',502);
 return result;
}
