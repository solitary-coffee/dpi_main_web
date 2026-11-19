import { refreshSupporterSnapshotSafely } from './supporter-snapshot.js';
import { getCustomPlan,customLocked,customPublic,enrichCustomSubscriptions,syncCustomWithStripe } from './supporter-custom.js';
import { currentCustomChange,getCustomChange,commitCustomChange } from './supporter-custom-change.js';
import { PLAN_FEATURES } from '../site/supporter/plan-features.js';

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
 supporter:Object.freeze({id:'supporter',name:'BASIC',yen:300,channels:2,servers:1,rules:5,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_SUPPORTER',features:PLAN_FEATURES.supporter}),
 plus:Object.freeze({id:'plus',name:'Plus',yen:800,channels:10,servers:3,rules:15,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_PLUS',features:PLAN_FEATURES.plus}),
 pro:Object.freeze({id:'pro',name:'Pro',yen:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true,priceEnv:'STRIPE_PRICE_PRO',features:PLAN_FEATURES.pro}),
});
// テスト公開中だけの「ログイン不要のテスト支払い」。誰の契約にも紐づけず（customer・dpi_user なし）、
// Webhook でも dpi_checkout_kind=preview_demo は何も反映しない。テストモードの鍵でだけ動く。
export async function createPreviewCheckout(env,plan){
 const definition=PLAN_CATALOG[plan];
 if(!definition)fail('プランを選び直してください。');
 if(!billingReady(env))fail('テスト支払いページを用意できません。時間をおいて再試行してください。',503);
 const origin=env.SUPPORTER_PUBLIC_ORIGIN||'https://dpi-bot.com';
 const session=await stripe(env,'checkout/sessions',{mode:'payment',
  'line_items[0][price_data][currency]':'jpy','line_items[0][price_data][unit_amount]':String(definition.yen),
  'line_items[0][price_data][product_data][name]':`DPI-Bot ${definition.name}プラン 月額（テスト決済）`,'line_items[0][quantity]':'1',
  'metadata[dpi_checkout_kind]':'preview_demo','metadata[dpi_plan]':definition.id,
  success_url:`${origin}/site/supporter/?preview_checkout=completed`,cancel_url:`${origin}/site/supporter/?preview_checkout=canceled`,
  expires_at:String(Math.floor(Date.now()/1000)+1800),integration_identifier:integrationIdentifier('dpi_preview_')},`dpi-preview-${crypto.randomUUID()}`);
 if(!session?.url)fail('テスト支払いページを用意できませんでした。',502);
 return {url:session.url};
}
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
   }else if(session.status==='expired'){
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
  credit_topup_succeeded:['【DPI-Bot】クレジットチャージ完了のお知らせ',[`クレジットチャージが完了しました。`,`購入額: ${amount}`,`付与クレジット: ${Number(invoice.amount_paid||0).toLocaleString('ja-JP')}クレジット`,`有効期限: ${date(invoice.expires_at)}`,'購入クレジットは、有料プラン・プラン変更・追加オプションの支払いに利用できます。']],
  credit_topup_failed:['【DPI-Bot】クレジットチャージ失敗のお知らせ',[`クレジットチャージを完了できませんでした。`,`決済予定額: ${amount}`,'クレジットは付与されていません。支払方法を確認し、必要な場合は改めてチャージしてください。']],
  credit_plan_payment_succeeded:['【DPI-Bot】クレジット払いによるプラン申込み完了のお知らせ',[`チャージ済みクレジットによる有料プランのお申込みが完了しました。`,`使用クレジット: ${Number(invoice.amount_paid||0).toLocaleString('ja-JP')}クレジット`,`次回更新日: ${date(invoice.next_renewal_at)}`,'今回の申込みではカード情報を入力していません。次回請求時にクレジットが不足する場合は、契約管理画面から支払方法を登録してください。']],
  credit_expired:['【DPI-Bot】クレジット有効期限切れのお知らせ',[`購入クレジットの有効期限が終了しました。`,`失効クレジット: ${Number(invoice.amount_due||0).toLocaleString('ja-JP')}クレジット`,`失効日時: ${date(invoice.expires_at)}`,'有効期限を過ぎた未使用分は利用規約に基づき失効し、原則として払戻しまたは再発行を行いません。']],
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
function disciplinaryMailContent(kind,details){
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
 lines.push('','----------------------------------------','DPI-Bot 運営','公式サイト: https://dpi-bot.com/','公式サポートサーバー: https://discord.gg/qFuZcGUb4K');
 return{subject,text:lines.join('\n')};
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
 const content=disciplinaryMailContent(kind,details);
 try{
  await env.NOTICE_EMAIL.send({to:email,from:{email:clean(env.NOTICE_FROM_EMAIL),name:'DPI-Bot'},subject:content.subject,text:content.text,...(clean(env.NOTICE_REPLY_TO_EMAIL)?{replyTo:clean(env.NOTICE_REPLY_TO_EMAIL)}:{}),headers:{'Auto-Submitted':'auto-generated','Content-Language':'ja','X-DPI-Mail-Type':`supporter-${kind}`}});
  await db.prepare(`UPDATE supporter_billing_notifications SET status='sent',sent_at=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(now,now,noticeId,kind).run();
  return true;
 }catch(error){await db.prepare(`UPDATE supporter_billing_notifications SET status='failed',last_error=?,updated_at=? WHERE invoice_id=? AND kind=?`).bind(clean(error?.code||error?.name||'unknown').slice(0,80),now,noticeId,kind).run();throw error;}
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
async function subscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data.filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
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
 const ids=[...new Set([clean(billing?.checkout_id),...(topups.results||[]).map(row=>clean(row.checkout_session_id))].filter(Boolean))];let expired=0;
 for(const id of ids){
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(id)}`);
  if(session.status==='open'){await stripe(env,`checkout/sessions/${encodeURIComponent(id)}/expire`,{},`dpi-discipline-expire-${requestId}-${id}`);expired+=1;}
 }
 const now=Math.floor(Date.now()/1000);
 await db.batch([
  db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL,dirty=1 WHERE discord_user_id=?').bind(uid),
  db.prepare(`UPDATE supporter_credit_topups SET status='failed',updated_at=? WHERE discord_user_id=? AND status='pending'`).bind(now,uid),
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
export async function reconcilePaidCheckoutSubscription(env,customer,uid,db=null){
 if(!customer||!uid||!billingReady(env))return {subscription:null,recovered:false,checkoutId:null};
 const existing=await subscriptions(env,customer);
 if(existing.length)return {subscription:existing[0],recovered:false,checkoutId:null};
 const result=await stripe(env,`checkout/sessions?customer=${encodeURIComponent(customer)}&limit=20`);
 if(db){
  const custom=(result.data||[]).filter(item=>
   item.mode==='payment'&&item.status==='complete'&&item.payment_status==='paid'
   &&checkoutMetadata(item).dpi_checkout_kind==='custom_subscription_initial'
   &&stripeId(item.customer)===customer&&checkoutMetadata(item).dpi_user===uid)
   .sort((a,b)=>Number(b.created||0)-Number(a.created||0));
  for(const item of custom){
   if(await rejectDisciplinedCheckout(env,db,item))continue;
   const sub=await provisionCustomPaidCheckoutSubscription(env,db,item);
   if(sub){
    await syncCustomWithStripe(db,uid,customer,await customerSubscriptionSummaries(env,customer));
    return {subscription:sub,recovered:true,checkoutId:item.id};
   }
  }
 }
 const candidates=(result.data||[]).filter(item=>recoverablePaidCheckout(item,customer,uid)).sort((a,b)=>Number(b.created||0)-Number(a.created||0));
 let session=null;for(const candidate of candidates){if(db&&await rejectDisciplinedCheckout(env,db,candidate))continue;session=candidate;break;}
 if(!session)return {subscription:null,recovered:false,checkoutId:null};
 const subscription=await provisionPaidCheckoutSubscription(env,session);
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
 const credits=await customerCredits(env,customer);
 if(credits<amount){await db.prepare(`UPDATE supporter_credit_signups SET status='failed',updated_at=? WHERE request_id=? AND status='pending'`).bind(now,attempt.request_id).run();fail(`クレジット残高が不足しています。申込みには${amount.toLocaleString('ja-JP')}クレジット必要です。`,409);}
 let transaction=null;
 try{
  transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
   amount:String(amount),currency:'jpy',description:`DPI-Bot initial plan payment: ${attempt.request_id}`,
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':'initial_plan_payment','metadata[dpi_credit_signup_request_id]':attempt.request_id,
  },`dpi-credit-signup-debit-${attempt.request_id}`);
  const balanceAfter=creditsFromBalance(transaction.ending_balance);
  await db.prepare(`UPDATE supporter_credit_signups SET balance_transaction_id=?,status='debited',updated_at=? WHERE request_id=? AND status IN ('pending','debited')`).bind(transaction.id,now,attempt.request_id).run();
  const params=creditSignupSubscriptionParams(env,customer,uid,choice,schedule,legalConsentVersion,attempt.request_id);
  const subscription=await stripe(env,'subscriptions',params,`dpi-credit-signup-subscription-${attempt.request_id}`);
  if(!['active','trialing'].includes(subscription?.status))fail('クレジット払いによる契約を有効化できませんでした。',409);
  await completeCreditSignup(db,attempt,subscription,transaction,amount,balanceAfter,now);
  try{await sendBillingNotification(env,db,'credit_plan_payment_succeeded',{id:`credit-signup:${attempt.request_id}`,customer,amount_paid:amount,currency:'jpy',next_renewal_at:schedule.anchor});}
  catch(error){console.error('Credit signup email failed',{requestId:attempt.request_id,errorName:error?.name||'Error'});}
  return {subscription,amount,balanceAfter,requestId:attempt.request_id,recovered:false};
 }catch(error){
  const recovered=creditSignupSubscription(await subscriptions(env,customer),attempt.request_id);
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
 return {subscriptionId:subscription.id||'',customId:clean(metadata.dpi_custom_id),customRevision:Number(metadata.dpi_custom_revision)||0,status:subscription.status||'unknown',cancelAtPeriodEnd:subscription.cancel_at_period_end===true,startedAt:unix(subscription.start_date)||unix(subscription.created),currentPeriodStart,nextRenewalAt,amount:items.reduce((sum,item)=>sum+item.subtotal,0),currency,plan:planId?PLAN_CATALOG[planId].name:'確認が必要な契約',planId,recognizedPlan,configurationValid:options.valid,channelPacks,serverPacks,rulePacks,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination,items,scheduledChange:null};
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
  const [summaries,invoices,credits,dunning]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerInvoices(env,row.customer_id),customerCredits(env,row.customer_id),dunningState(db,row.customer_id)]);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
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
  return json({mode:'test',billingDay:26,subscriptions:effective,customPlan:customPublic(syncedCustom),customCheckoutUrl,customChange:pendingCustomChange?{requestId:pendingCustomChange.request_id,status:pendingCustomChange.status,oldMonthlyYen:Number(pendingCustomChange.old_monthly_yen),nextMonthlyYen:Number(pendingCustomChange.next_monthly_yen),amountDueYen:Number(pendingCustomChange.amount_due_yen)}:null,customChangeCheckoutUrl,invoices,credits,creditDetails,dunning,accountEnforcement,rulesAdjustment,recoveredSubscription:recovery.recovered,creditTopupRecovery,deliveryEnabled:false});
 }
 if(customLocked(customPlan)&&['checkout','update','preview-update','portal'].includes(action))return json({message:'カスタムプランの提供中はユーザー側でプラン変更・標準プラン申込みを行えません。契約の変更・解約は管理者へお問い合わせください。',customPlan:customPublic(customPlan)},403);
 if(action==='portal'&&accountEnforcement.suspended&&!row.customer_id)return json({message:'BAN中のため契約管理画面を作成できません。',accountEnforcement},403);
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
 if(input.useCredits===true){
  const result=await provisionCreditFundedSignup(env,db,uid,row.customer_id,choice,input);
  const [summaries,credits]=await Promise.all([customerSubscriptionSummaries(env,row.customer_id),customerCredits(env,row.customer_id)]);
  const creditDetails=await purchasedCreditStatus(db,uid,credits);
  return json({message:`${result.amount.toLocaleString('ja-JP')}クレジットでお申し込みが完了しました。カード情報の入力は不要でした。`,paidWithCredits:true,creditApplied:result.amount,balanceAfter:result.balanceAfter,billingDay:26,subscriptions:summaries,credits,creditDetails,deliveryEnabled:false});
 }
 row=await recoverStaleCheckoutAttempt(db,uid,row);
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'payment',customer:row.customer_id,client_reference_id:uid,
  'payment_intent_data[setup_future_usage]':'off_session','payment_intent_data[metadata][dpi_user]':uid,
  'metadata[dpi_checkout_kind]':'initial_subscription','metadata[dpi_user]':uid,'metadata[dpi_plan]':choice.plan,
  'metadata[dpi_legal_consent_version]':legalConsentVersion,'metadata[dpi_channel_packs]':String(choice.channelPacks),
  'metadata[dpi_server_packs]':String(choice.serverPacks),'metadata[dpi_rule_packs]':String(choice.rulePacks),'metadata[dpi_billing_anchor]':String(schedule.anchor),
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
 if(saved['metadata[dpi_plan]']!==params['metadata[dpi_plan]']||saved['metadata[dpi_channel_packs]']!==params['metadata[dpi_channel_packs]']||saved['metadata[dpi_server_packs]']!==params['metadata[dpi_server_packs]']||String(saved['metadata[dpi_rule_packs]']||0)!==params['metadata[dpi_rule_packs]'])return json({message:'別の条件で決済画面を作成済みです。期限切れ後に変更できます（最大1時間）。'},409);
 return json({url:checkout.url,mode:'test'});
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
  if(candidate.source_type==='purchase')await db.prepare(`UPDATE supporter_credit_topups SET status='expired',updated_at=? WHERE checkout_session_id=? AND status='credited'`).bind(now,candidate.source_id).run();
  else await db.prepare(`UPDATE supporter_credit_campaign_recipients SET status='expired' WHERE lot_id=? AND status='credited'`).bind(candidate.id).run();
  try{await sendBillingNotification(env,db,'credit_expired',{id:`expiry:${candidate.id}`,customer:candidate.customer_id,amount_due:remaining,currency:'jpy',expires_at:candidate.expires_at});}
  catch(error){console.error('Supporter credit expiry email failed',{creditLotId:candidate.id,errorName:error?.name||'Error'});}
  expired+=1;
 }
 return expired;
}
export async function billingWebhook(request,env,ctx){
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
  if(checkoutMetadata(session).dpi_checkout_kind==='preview_demo'){
   // ログイン不要のテスト支払い（テスト公開中の確認用）。契約・クレジット・通知には何も反映しない。
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
   const provisioned=await provisionPaidCheckoutSubscription(env,session);
   if(provisioned&&session?.payment_status==='paid')await sendBillingNotification(env,db,'payment_succeeded',{id:session.id,customer:session.customer,amount_paid:Number(session.amount_total||0),currency:session.currency||'jpy'});
  }
 }
 if(event.type==='invoice.paid')await recordInvoicePaid(env,db,event.data?.object);
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
  if(event.type==='checkout.session.async_payment_failed'&&checkoutMetadata(session).dpi_checkout_kind==='credit_topup')await sendBillingNotification(env,db,'credit_topup_failed',{id:sessionId,customer:session.customer,amount_due:Number(session.amount_total||0),currency:session.currency||'jpy'});
 }
 if(event.type==='customer.updated')await syncCustomerEmail(db,event.data?.object);
 if(['customer.subscription.created','customer.subscription.updated'].includes(event.type)){
  const subscription=event.data?.object;
  const summary=subscriptionSummary(subscription,env);
  if(summary.customId){
   const uid=clean(subscription?.metadata?.dpi_user);
   if(/^\d{17,20}$/.test(uid)){
    const billing=await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
    const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    if(billing?.customer_id===customer)await syncCustomWithStripe(db,uid,customer,await customerSubscriptionSummaries(env,customer));
   }
  }else if(summary.recognizedPlan&&['active','trialing','past_due','unpaid','paused'].includes(subscription?.status))await reconcileStoredRulesForCustomer(db,subscription.customer,summary);
 }
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(eventCustomerId(event))]);
 const snapshotTask=refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,`stripe_${event.type}`);
 if(ctx?.waitUntil)ctx.waitUntil(snapshotTask);else await snapshotTask;
 return json({received:true});
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
 // Republish again so suspensions/recoveries from this run reach delivery promptly.
 await publishScheduledSnapshot(env,db,'billing_schedule');
 if(taskError)throw taskError;
 return tasks;
}
async function runBillingScheduleTasks(env,db,nowMs){
 const now=Math.floor(Number(nowMs)/1000);let retried=0,paid=0,failed=0,suspended=0;
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
 const disciplinaryNotices=await db.prepare(`SELECT d.request_id,d.discord_user_id,d.action,d.reason,d.canceled_subscriptions,d.confiscated_credits,a.billing_email
  FROM supporter_disciplinary_actions d JOIN supporter_accounts a ON a.discord_user_id=d.discord_user_id
  WHERE d.status='completed' AND d.email_status IN ('pending','failed') ORDER BY d.updated_at LIMIT 25`).all();
 for(const row of disciplinaryNotices.results||[]){
  try{const sent=await sendSupporterDisciplinaryNotification(env,db,row.action,{requestId:row.request_id,uid:row.discord_user_id,email:row.billing_email,reason:row.reason,canceledSubscriptions:row.canceled_subscriptions,confiscatedCredits:row.confiscated_credits});await db.prepare(`UPDATE supporter_disciplinary_actions SET email_status=?,last_error=NULL,updated_at=? WHERE request_id=?`).bind(sent?'sent':'skipped',now,row.request_id).run();}
  catch(error){console.error('Supporter disciplinary email retry failed',{requestId:row.request_id,errorName:error?.name||'Error'});}
 }
 const expiredCredits=await expirePurchasedCredits(env,db);
 await recoverCustomPriceChanges(env,db);
 return {retried,paid,failed,suspended,expiredCredits};
}

/** Test-mode custom monthly checkout. A 24-hour single-user session is used,
 * never a reusable open-amount Stripe Payment Link. */
export function customInitialCheckoutParams(customer,uid,offer,requestId,now=Date.now(),origin='https://dpi-bot.com'){
 const schedule=billingSchedule(now);
 if(!customer||!/^\d{17,20}$/.test(uid)||offer?.status!=='offered'
  ||!Number.isInteger(Number(offer.confirmed_yen))||Number(offer.confirmed_yen)<100)
  fail('カスタムプランの提供内容を確認してください。',409);
 const amount=Number(offer.confirmed_yen)*schedule.initialMonths;
 if(!Number.isSafeInteger(amount)||amount>2000000)fail('初回の請求額が上限を超えています。',409);
 return {
  mode:'payment',customer,client_reference_id:uid,
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
  expires_at:String(Math.floor(now/1000)+86400),
  integration_identifier:integrationIdentifier('dpi_custom_'),
 };
}
export async function createCustomCheckout(env,customer,uid,offer,requestId){
 if(!billingReady(env))fail('Stripeテスト接続を確認できません。',503);
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
 if(subscription.livemode!==false||realCustomer!==customer||meta.dpi_user!==uid
  ||meta.dpi_custom_id!==offer.id||!['active'].includes(subscription.status)
  ||subscription.pending_update||scheduleId(subscription)||subscription.cancel_at_period_end
  ||items.length!==1||!item?.id||Number(item.quantity)!==1
  ||item.price?.currency!=='jpy'||item.price?.recurring?.interval!=='month'
  ||Number(item.price?.recurring?.interval_count||1)!==1
  ||!/^prod_/.test(stripeId(item.price?.product))||subscription.discounts?.length
  ||subscription.collection_method!=='charge_automatically'
 )fail('Stripe契約に未処理請求・予約変更・複数料金・割引等があるため自動変更できません。内容をご確認ください。',409);
 const lastInvoiceId=stripeId(subscription.latest_invoice);
 if(lastInvoiceId){
  const invoice=await stripe(env,`invoices/${encodeURIComponent(lastInvoiceId)}`);
  if(invoice.livemode!==false||invoice.status!=='paid'||stripeId(invoice.customer)!==customer
   ||invoice.currency!=='jpy'||Number(invoice.amount_remaining||0)!==0
   ||invoiceSubscriptionId(invoice)!==subscription.id)
   fail('最新の月額料金の支払い完了を確認できません。未払いや別契約の請求書を確認してください。',409);
 }else{
  // A subscription created after a fully paid one-off initial Checkout
  // has no invoice until its first 26th renewal. Verify that *paid*
  // Checkout directly rather than rejecting legitimate early upgrades.
  const initialId=clean(meta.dpi_custom_initial_session);
  if(!/^cs_(?:test_)?[A-Za-z0-9]+$/.test(initialId))
   fail('初回請求の支払済みセッションを確認できません。',409);
  const checkout=await stripe(env,`checkout/sessions/${encodeURIComponent(initialId)}`);
  const checkoutMeta=checkoutMetadata(checkout);
  const firstMonths=Number(checkoutMeta.dpi_initial_months);
  if(checkout.livemode!==false||checkout.mode!=='payment'
   ||checkout.status!=='complete'||checkout.payment_status!=='paid'
   ||stripeId(checkout.customer)!==customer||checkout.client_reference_id!==uid
   ||checkoutMeta.dpi_checkout_kind!=='custom_subscription_initial'
   ||checkoutMeta.dpi_custom_id!==offer.id
   ||Number(checkoutMeta.dpi_custom_revision)!==Number(offer.revision)
   ||Number(checkoutMeta.dpi_custom_monthly_yen)!==Number(offer.confirmed_yen)
   ||!([1,2].includes(firstMonths))
   ||Number(checkout.amount_total)!==Number(offer.confirmed_yen)*firstMonths
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
  mode:'payment',customer,client_reference_id:uid,
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
  expires_at:String(now+86400),
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
  proration_behavior:'none',billing_cycle_anchor:'unchanged',
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
 if(!/^prod_/.test(product.id||'')||product.livemode!==false)
  fail('Stripeテスト用の商品情報を作成できませんでした。',502);
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
