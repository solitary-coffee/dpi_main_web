import { requireSession, assertCsrf, assertSameOrigin, readJson, fetchGuildChannels } from './reuse.js';
import { authenticateNewsletterAdmin } from './access.js';
import { adminBillingAction, adminDisciplinaryBillingAction, billingAction, billingReady, createBillingCustomer, creditsByCustomer, customerSubscriptionSummaries, grantCreditOnce, expireSupporterPendingCheckouts, publicPlans, reconcilePaidCheckoutSubscription, sendSupporterDisciplinaryNotification, subscriptionSummariesByCustomer, createCustomCheckout, expireCustomCheckout, cancelCustomSubscription,verifiedCustomSubscription,createCustomDifferenceCheckout,settleCustomPriceChange,recoverCustomPriceChanges } from './supporter-billing.js';
import { getCustomPlan,customLocked,customPublic,normalizeCustomPlan,enrichCustomSubscriptions } from './supporter-custom.js';
import { customChangeQuote,currentCustomChange,customChangePublic,stageCustomChange } from './supporter-custom-change.js';
import { refreshSupporterSnapshotSafely } from './supporter-snapshot.js';
import { reconcileSupporterRolesSafely } from './supporter-roles.js';
import { PREFECTURES, loadSupporterAreaCatalogue, geographicEntitlements, normalizeGeographicRule } from './supporter-geo.js';
import { planFeatures } from '../site/supporter/plan-features.js';
import { billingMode, recoverCheckoutState, releaseDisputeHolds } from './supporter-billing.js';
import { basicCredentialsValid, reviewAccessConfigured, reviewChallenge, reviewCookie, reviewCookieValid } from './supporter-review.js';
import { imageRulesEnabled, imageRulesV2Enabled, isImageRuleType, isImageRuleV2Type, imageRuleOptions, savedTsunamiOutputs, savedRadarContents, savedRadarMinutes, radarIntervalText, HIRES_RADAR_CONTENTS, TSUNAMI_MAP_OUTPUTS, WARNING_TABLE_KINDS, WARNING_TABLE_DELIVER_ON, normalizeImageRuleFields, loadEarthquakeMunicipalities, IMAGE_RULE_TYPE_OPTIONS, HIRES_RADAR_CONDITIONS, WEATHER_MAP_PRODUCTS, WEATHER_MAP_SEVERITIES, EARTHQUAKE_MAP_PRODUCTS, EARTHQUAKE_MAP_INTENSITIES } from './supporter-image-rules.js';
import { supporterAdminPayments } from './supporter-admin-payments.js';
import {customRequestsEnabled,handleSupporterCustomRequestApi,handleSupporterCustomRequestAdminApi} from './supporter-custom-request.js';

const response = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const refreshSupporterAccessSafely = (env, db, reason, discordUserId) => Promise.all([
 refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,reason),
 reconcileSupporterRolesSafely(env,db,subscriptionSummariesByCustomer,{discordUserId}),
]);
const notFound = () => new Response('Not Found', {
 status: 404,
 headers: {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
 },
});

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function ruleCount(settingsJson) {
 try {
  const settings = JSON.parse(settingsJson || '{}');
  return Array.isArray(settings.rules) ? settings.rules.length : 0;
 } catch { return 0; }
}
export function supporterAdminAccount(row, subscriptions = [], billingError = '', credits = 0, customPlan = null, pendingCustomChange = null) {
 return {
  discordUserId: row.discord_user_id,
  discordName: row.discord_name || '',
  billingEmail: row.billing_email || '',
  registeredAt: row.registered_at,
  updatedAt: row.updated_at,
  revision: Number(row.revision || 0),
  ruleCount: ruleCount(row.settings_json),
  subscriptions,
  credits: Number(credits || 0),
  accountStatus: row.account_status || 'active',
  statusReason: row.status_reason || '',
  statusUpdatedAt: row.status_updated_at || null,
  statusUpdatedBy: row.status_updated_by || '',
  billingError,
  customPlan:customPublic(customPlan),
  pendingCustomChange:customChangePublic(pendingCustomChange),
 };
}
export function supporterAccountEnforcement(row){
 return {suspended:row?.account_status==='suspended',status:row?.account_status||'active',reason:clean(row?.status_reason),updatedAt:row?.status_updated_at||null};
}
export function assertSupporterAccountActive(row){
 const state=supporterAccountEnforcement(row);
 if(state.suspended)throw Object.assign(new Error(`有料プランアカウントは管理者によりBANされています。${state.reason?` 理由: ${state.reason}`:''}`),{status:403,accountEnforcement:state});
 return state;
}
export async function supporterCreditMetrics(db,billingRows=[],creditBalances=new Map(),stripeAvailable=true){
 const now=Math.floor(Date.now()/1000),balancesByUser=new Map();
 for(const row of billingRows||[])balancesByUser.set(row.discord_user_id,Math.max(0,Number(creditBalances.get(row.customer_id)||0)));
 const lots=await db.prepare(`SELECT id,discord_user_id,source_type,remaining_amount,expires_at FROM supporter_credit_lots
  WHERE source_type IN ('purchase','admin') AND status='active' AND remaining_amount>0
  ORDER BY discord_user_id,CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,expires_at,id`).all();
 const grouped=new Map();
 for(const lot of lots.results||[]){const group=grouped.get(lot.discord_user_id)||[];group.push(lot);grouped.set(lot.discord_user_id,group);}
 // Read-only: this backs a GET admin view, so consumption is estimated in memory
 // and never written to the ledger (a partial/failed Stripe read must not consume lots).
 const remainingById=new Map((lots.results||[]).map(lot=>[lot.id,Math.max(0,Number(lot.remaining_amount)||0)]));
 if(stripeAvailable){
  for(const [uid,userLots] of grouped){
   if(!balancesByUser.has(uid))continue;
   let tracked=userLots.reduce((sum,lot)=>sum+remainingById.get(lot.id),0);
   let consumed=Math.max(0,tracked-balancesByUser.get(uid));
   for(const lot of userLots){
    if(consumed<=0)break;
    const current=remainingById.get(lot.id),used=Math.min(current,consumed);
    remainingById.set(lot.id,current-used);consumed-=used;
   }
  }
 }
 const purchaseLots=(lots.results||[]).filter(lot=>lot.source_type==='purchase'&&remainingById.get(lot.id)>0);
 const expiries=purchaseLots.map(lot=>Number(lot.expires_at)).filter(value=>Number.isFinite(value)&&value>0);
 const active={
  balance:purchaseLots.reduce((sum,lot)=>sum+remainingById.get(lot.id),0),
  users:new Set(purchaseLots.map(lot=>lot.discord_user_id)).size,
  next_expiry:expiries.length?Math.min(...expiries):null,
  expiring_30d:purchaseLots.filter(lot=>Number.isFinite(Number(lot.expires_at))&&lot.expires_at!==null&&Number(lot.expires_at)<=now+30*86400).reduce((sum,lot)=>sum+remainingById.get(lot.id),0),
 };
 const [topups,expired]=await Promise.all([
  db.prepare(`SELECT COALESCE(SUM(amount-refunded_amount),0) AS net_purchased,
   COUNT(DISTINCT CASE WHEN status NOT IN ('pending','failed') THEN discord_user_id END) AS purchasers
   FROM supporter_credit_topups WHERE status NOT IN ('pending','failed')`).first(),
  db.prepare(`SELECT COALESCE(-SUM(credit_delta),0) AS expired
   FROM supporter_credit_events WHERE reason='credit_expired' AND credit_delta<0`).first(),
 ]);
 const totalCredits=stripeAvailable?[...balancesByUser.values()].reduce((sum,value)=>sum+value,0):null;
 const creditUsers=stripeAvailable?[...balancesByUser.values()].filter(value=>value>0).length:null;
 const purchasedBalance=Math.max(0,Number(active?.balance)||0);
 return {
  totalCredits,creditUsers,purchasedBalance,purchasedUsers:Math.max(0,Number(active?.users)||0),
  otherCredits:totalCredits===null?null:Math.max(0,totalCredits-purchasedBalance),
  netPurchased:Math.max(0,Number(topups?.net_purchased)||0),purchasers:Math.max(0,Number(topups?.purchasers)||0),
  expiredCredits:Math.max(0,Number(expired?.expired)||0),expiring30Days:Math.max(0,Number(active?.expiring_30d)||0),
  nextExpiry:active?.next_expiry?Number(active.next_expiry):null,
  legalThreshold:10_000_000,legalUsageRate:purchasedBalance/10_000_000,
  stripeAvailable,
 };
}
function normalizeBillingEmail(value) {
 const email = clean(value).toLowerCase();
 if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('有効なメールアドレスを入力してください。'),{status:400});
 return email;
}
export function supporterConsentVersion(input, env) {
 const version = clean(env.SUPPORTER_CONSENT_VERSION);
 if (!version) throw Object.assign(new Error('申込み同意の設定が完了していません。'),{status:503,publicMessage:'申込み同意の設定が完了していません。運営へお問い合わせください。'});
 if (input.legalConsent !== true) throw Object.assign(new Error('利用規約、プライバシーポリシーおよび特定商取引法に基づく表記への同意が必要です。'),{status:400});
 return version;
}
function assertAdminOrigin(request) {
 const url = new URL(request.url);
 const origin = clean(request.headers.get('origin'));
 const site = clean(request.headers.get('sec-fetch-site'));
 if ((origin && origin !== url.origin) || site === 'cross-site') throw Object.assign(new Error('別サイトからの管理操作は許可されていません。'),{status:403});
}
async function writeSupporterAudit(db, actor, action, uid, details) {
 try {
  await db.prepare(`INSERT INTO admin_audit_events
   (id, actor, action, entity_type, entity_id, details_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`)
   .bind(crypto.randomUUID(),actor,`supporter.${action}`,'supporter_account',uid,JSON.stringify(details).slice(0,8000),new Date().toISOString()).run();
  return true;
 } catch (error) {
  console.error('Paid plan billing audit write failed',{action,errorName:error?.name||'Error'});
  return false;
 }
}
async function recordAdminCreditLot(db,uid,action,requestId,amount){
 const now=Math.floor(Date.now()/1000);
 if(action==='grant_credit'){
  await db.prepare(`INSERT INTO supporter_credit_lots
   (id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at)
   VALUES(?,?,'admin',?,?,?,NULL,'active',?,?) ON CONFLICT(source_type,source_id) DO NOTHING`)
   .bind(`admin:${requestId}`,uid,requestId,amount,amount,now,now).run();
  return;
 }
 if(!['remove_credit','confiscate_credit','disciplinary_cancel','ban_account'].includes(action))return;
 const lots=await db.prepare(`SELECT id,remaining_amount FROM supporter_credit_lots
  WHERE discord_user_id=? AND source_type IN ('admin','purchase') AND status='active' AND remaining_amount>0
  ORDER BY CASE source_type WHEN 'admin' THEN 0 ELSE 1 END,expires_at,id`).bind(uid).all();
 let removing=amount;
 for(const lot of lots.results||[]){
  if(removing<=0)break;
  const current=Math.max(0,Number(lot.remaining_amount)||0),used=Math.min(current,removing),remaining=current-used;
  const result=await db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=?,status=?,updated_at=?
   WHERE id=? AND remaining_amount=? AND status='active'`).bind(remaining,remaining?'active':'revoked',now,lot.id,current).run();
  if(result.meta?.changes)removing-=used;
 }
}

export async function changeSupporterAccountStatus(db,uid,admin,input){
 const action=clean(input.action),requestId=clean(input.requestId),reason=clean(input.reason);
 if(!['ban_account','unban_account'].includes(action))throw Object.assign(new Error('アカウント操作を確認してください。'),{status:400});
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)throw Object.assign(new Error('操作理由を5〜500文字で入力してください。'),{status:400});
 const current=await db.prepare('SELECT account_status,status_request_id FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 if(!current)throw Object.assign(new Error('対象の有料プラン登録者が見つかりません。'),{status:404});
 const next=action==='ban_account'?'suspended':'active',previous=next==='suspended'?'active':'suspended';
 if(current.status_request_id===requestId)return{message:next==='suspended'?'アカウントはBAN済みです。':'アカウントのBANは解除済みです。',accountStatus:next,idempotent:true};
 if((current.account_status||'active')===next)throw Object.assign(new Error(next==='suspended'?'このアカウントは既にBANされています。':'このアカウントはBANされていません。'),{status:409});
 const now=new Date().toISOString();
 const result=await db.prepare(`UPDATE supporter_accounts SET account_status=?,status_reason=?,status_updated_at=?,status_updated_by=?,status_request_id=?,updated_at=?
  WHERE discord_user_id=? AND COALESCE(account_status,'active')=?`).bind(next,reason,now,admin.email,requestId,now,uid,previous).run();
 if(!result.meta?.changes)throw Object.assign(new Error('別の管理操作で状態が変更されました。最新情報を読み込んでください。'),{status:409});
 return{message:next==='suspended'?'アカウントをBANしました。':'アカウントのBANを解除しました。再利用にはプランへの申込みが必要です。',accountStatus:next,idempotent:false};
}

function disciplinaryResultMessage(action,canceled,credits){
 if(action==='ban_account')return`契約${canceled}件を即時解除し、${credits.toLocaleString('ja-JP')}クレジットを没収してアカウントをBANしました。`;
 if(action==='unban_account')return'アカウントのBANを解除しました。再利用にはプランへの申込みが必要です。';
 return`契約${canceled}件を即時解除し、${credits.toLocaleString('ja-JP')}クレジットを没収しました。再度のお支払いで申込みできます。`;
}

async function sendDisciplinaryEmail(env,db,account,input,result){
 let emailStatus='skipped',lastError=null;
 try{
  const sent=await sendSupporterDisciplinaryNotification(env,db,input.action,{requestId:clean(input.requestId),uid:account.discord_user_id,email:account.billing_email,reason:clean(input.reason),canceledSubscriptions:Number(result.canceledSubscriptions)||0,confiscatedCredits:Number(result.confiscatedCredits)||0});
  emailStatus=sent?'sent':'skipped';
 }catch(error){emailStatus='failed';lastError=clean(error?.code||error?.name||'unknown').slice(0,80);console.error('Supporter disciplinary email failed',{requestId:clean(input.requestId),errorName:error?.name||'Error'});}
 await db.prepare(`UPDATE supporter_disciplinary_actions SET email_status=?,last_error=?,updated_at=? WHERE request_id=?`).bind(emailStatus,lastError,Math.floor(Date.now()/1000),clean(input.requestId)).run();
 return emailStatus;
}

const COMPENSATION_ACTIVE_STATUSES = new Set(['active','trialing','past_due','unpaid','paused']);

function compensationCampaignView(row){
 return {
  id:clean(row.id),targetType:clean(row.target_type),targetValue:clean(row.target_value),amount:Number(row.amount)||0,
  reason:clean(row.reason),expiresAt:Number(row.expires_at)||null,status:clean(row.status),
  recipientCount:Number(row.recipient_count)||0,creditedCount:Number(row.credited_count)||0,failedCount:Number(row.failed_count)||0,
  createdBy:clean(row.created_by),createdAt:Number(row.created_at)||null,completedAt:Number(row.completed_at)||null,
 };
}

async function compensationTargets(env,db,targetType,targetValue){
 const rows=await db.prepare(`SELECT a.discord_user_id,a.billing_email,b.customer_id
  FROM supporter_accounts a LEFT JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
  WHERE COALESCE(a.account_status,'active')<>'suspended' AND (b.customer_id IS NOT NULL OR COALESCE(a.billing_email,'')<>'')
  ORDER BY a.discord_user_id`).all();
 let targets=rows.results||[];
 if(targetType==='user')targets=targets.filter(row=>row.discord_user_id===targetValue);
 if(targetType==='plan'){
  const grouped=await subscriptionSummariesByCustomer(env,targets.map(row=>row.customer_id).filter(Boolean));
  targets=targets.filter(row=>(grouped.get(row.customer_id)||[]).some(subscription=>subscription.planId===targetValue&&subscription.recognizedPlan!==false&&COMPENSATION_ACTIVE_STATUSES.has(subscription.status)));
 }
 return targets;
}

async function createCompensationCampaign(env,db,admin,input){
 if(!billingReady(env))throw Object.assign(new Error('決済設定が完了していません。'),{status:503});
 const campaignId=clean(input.requestId),targetType=clean(input.targetType),targetValue=clean(input.targetValue),amount=Number(input.amount),reason=clean(input.reason),expiresAt=Number(input.expiresAt);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId))throw Object.assign(new Error('配布リクエストを確認できません。再読み込みしてください。'),{status:400});
 const existing=await db.prepare('SELECT * FROM supporter_credit_campaigns WHERE id=?').bind(campaignId).first();
 if(existing){
  if(clean(existing.target_type)!==targetType||(targetType!=='all'&&clean(existing.target_value||'')!==targetValue)||Number(existing.amount)!==amount)
   throw Object.assign(new Error('この配布リクエストは別の内容で作成済みです。画面を再読み込みしてください。'),{status:409});
  return compensationCampaignView(existing);
 }
 if(!['all','user','plan'].includes(targetType))throw Object.assign(new Error('配布対象を確認してください。'),{status:400});
 if(targetType==='user'&&!/^\d{17,20}$/.test(targetValue))throw Object.assign(new Error('対象ユーザーのDiscord IDを確認してください。'),{status:400});
 if(targetType==='plan'&&!['supporter','plus','pro'].includes(targetValue))throw Object.assign(new Error('対象プランを確認してください。'),{status:400});
 if(!Number.isInteger(amount)||amount<1||amount>1_000_000)throw Object.assign(new Error('1人あたりのクレジット数を1〜1,000,000で指定してください。'),{status:400});
 if(reason.length<5||reason.length>500)throw Object.assign(new Error('ユーザーに表示する理由を5〜500文字で入力してください。'),{status:400});
 const now=Math.floor(Date.now()/1000);
 if(!Number.isInteger(expiresAt)||expiresAt<now+3600||expiresAt>now+5*366*86400)throw Object.assign(new Error('有効期限は1時間後から5年以内で指定してください。'),{status:400});
 const targets=await compensationTargets(env,db,targetType,targetValue);
 if(!targets.length)throw Object.assign(new Error('条件に一致する配布対象者がいません。'),{status:409});
 const statements=[db.prepare(`INSERT INTO supporter_credit_campaigns
  (id,target_type,target_value,amount,reason,expires_at,status,recipient_count,created_by,created_at)
  VALUES(?,?,?,?,?,?,'pending',?,?,?)`).bind(campaignId,targetType,targetType==='all'?null:targetValue,amount,reason,expiresAt,targets.length,admin.email,now)];
 for(const target of targets){
  const requestId=crypto.randomUUID(),lotId=`compensation:${campaignId}:${target.discord_user_id}`;
  statements.push(db.prepare(`INSERT INTO supporter_credit_campaign_recipients
   (campaign_id,discord_user_id,request_id,lot_id,status) VALUES(?,?,?,?,'pending')`).bind(campaignId,target.discord_user_id,requestId,lotId));
 }
 await db.batch(statements);
 await writeSupporterAudit(db,admin.email,'create_credit_campaign',campaignId,{targetType,targetValue:targetType==='all'?null:targetValue,amount,reason,expiresAt,recipientCount:targets.length});
 return compensationCampaignView(await db.prepare('SELECT * FROM supporter_credit_campaigns WHERE id=?').bind(campaignId).first());
}

export async function processCompensationCampaign(env,db,admin,campaignId,limit=10){
 const campaign=await db.prepare('SELECT * FROM supporter_credit_campaigns WHERE id=?').bind(campaignId).first();
 if(!campaign)throw Object.assign(new Error('補償クレジット配布が見つかりません。'),{status:404});
 if(['completed','partial','failed'].includes(campaign.status))return compensationCampaignView(campaign);
 await db.prepare(`UPDATE supporter_credit_campaigns SET status='processing' WHERE id=? AND status='pending'`).bind(campaignId).run();
 const pending=await db.prepare(`SELECT r.discord_user_id,r.request_id,r.lot_id,r.attempts,a.billing_email,b.customer_id
  FROM supporter_credit_campaign_recipients r
  JOIN supporter_accounts a ON a.discord_user_id=r.discord_user_id
  LEFT JOIN supporter_billing b ON b.discord_user_id=r.discord_user_id
  WHERE r.campaign_id=? AND r.status='pending' ORDER BY r.discord_user_id LIMIT ?`).bind(campaignId,limit).all();
 for(const recipient of pending.results||[]){
  const attempt=Number(recipient.attempts)||0;
  const claimed=await db.prepare(`UPDATE supporter_credit_campaign_recipients SET attempts=attempts+1,error_message=NULL
   WHERE campaign_id=? AND discord_user_id=? AND status='pending' AND attempts=?`).bind(campaignId,recipient.discord_user_id,attempt).run();
  if(!claimed.meta?.changes)continue;
  try{
   let customerId=clean(recipient.customer_id);
   if(!customerId){
    if(!recipient.billing_email)throw Object.assign(new Error('申込みメールアドレスが登録されていません。'),{status:409});
    const customer=await createBillingCustomer(env,recipient.discord_user_id,recipient.billing_email,`dpi-compensation-customer-${recipient.discord_user_id}`);
    await db.prepare(`INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)
     ON CONFLICT(discord_user_id) DO UPDATE SET customer_id=COALESCE(supporter_billing.customer_id,excluded.customer_id)`).bind(recipient.discord_user_id,customer.id).run();
    customerId=(await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(recipient.discord_user_id).first())?.customer_id;
   }
   // The grant is claimed in D1 before Stripe is called, so a resumed batch
   // never credits the same recipient twice after Stripe's 24h idempotency window.
   const amount=Number(campaign.amount),now=Math.floor(Date.now()/1000);
   const record=(transactionId,balanceAfter)=>[
    db.prepare(`INSERT INTO supporter_credit_events
     (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(recipient.request_id,recipient.discord_user_id,amount,balanceAfter,transactionId,campaign.reason,admin.email,new Date(now*1000).toISOString()),
    db.prepare(`INSERT INTO supporter_credit_lots
     (id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at)
     VALUES(?,?,'admin',?,?,?,?, 'active',?,?) ON CONFLICT(source_type,source_id) DO NOTHING`).bind(recipient.lot_id,recipient.discord_user_id,recipient.lot_id,amount,amount,Number(campaign.expires_at),now,now),
    db.prepare(`UPDATE supporter_credit_campaign_recipients SET status='credited',stripe_transaction_id=?,balance_after=?,credited_at=?,error_message=NULL
     WHERE campaign_id=? AND discord_user_id=? AND status='pending'`).bind(transactionId,balanceAfter,now,campaignId,recipient.discord_user_id),
   ];
   const grant=await grantCreditOnce(env,db,{
    grantKey:recipient.lot_id,kind:'compensation',uid:recipient.discord_user_id,customer:customerId,amount,
    params:{amount:String(-amount),currency:'jpy',description:`DPI-Bot credit grant: ${campaign.reason}`.slice(0,500),
     'metadata[dpi_user]':recipient.discord_user_id,'metadata[dpi_credit_action]':'grant_credit','metadata[dpi_admin_reason]':campaign.reason},
    idempotencyKey:`dpi-admin-grant_credit-${recipient.request_id}`,
    record:(transaction,balanceAfter)=>record(transaction.id,balanceAfter),
   });
   // Recording is idempotent; repeat it only to finish a recipient whose grant was already recorded.
   if(grant.alreadyRecorded)await db.batch(record(grant.transactionId,grant.balanceAfter));
  }catch(error){
   const finalAttempt=attempt+1>=3;
   await db.prepare(`UPDATE supporter_credit_campaign_recipients SET status=?,error_message=?
    WHERE campaign_id=? AND discord_user_id=? AND status='pending'`).bind(finalAttempt?'failed':'pending',clean(error?.message||'付与処理に失敗しました。').slice(0,500),campaignId,recipient.discord_user_id).run();
  }
 }
 const counts=await db.prepare(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN status='credited' THEN 1 ELSE 0 END) AS credited,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
  FROM supporter_credit_campaign_recipients WHERE campaign_id=?`).bind(campaignId).first();
 const remaining=Number(counts?.pending)||0,credited=Number(counts?.credited)||0,failed=Number(counts?.failed)||0;
 const status=remaining?'processing':failed?(credited?'partial':'failed'):'completed',completedAt=remaining?null:Math.floor(Date.now()/1000);
 await db.prepare(`UPDATE supporter_credit_campaigns SET status=?,recipient_count=?,credited_count=?,failed_count=?,completed_at=? WHERE id=?`).bind(status,Number(counts?.total)||0,credited,failed,completedAt,campaignId).run();
 if(!remaining)await writeSupporterAudit(db,admin.email,'complete_credit_campaign',campaignId,{status,creditedCount:credited,failedCount:failed});
 return compensationCampaignView(await db.prepare('SELECT * FROM supporter_credit_campaigns WHERE id=?').bind(campaignId).first());
}
export const SUPPORTER_REGIONS = Object.freeze([
 ['all', '全国'],
 ['hokkaido', '北海道地方'],
 ['tohoku', '東北地方'],
 ['kanto-koshin', '関東甲信地方'],
 ['hokuriku', '北陸地方'],
 ['tokai', '東海地方'],
 ['kinki', '近畿地方'],
 ['chugoku', '中国地方'],
 ['shikoku', '四国地方'],
 ['kyushu-north', '九州北部地方（山口県を含む）'],
 ['kyushu-south-amami', '九州南部・奄美地方'],
 ['okinawa', '沖縄地方'],
]);
export const WEATHER_LEVELS = Object.freeze([
 ['all', 'すべての警戒レベル'],
 ['1', 'レベル1 早期注意情報以上'],
 ['2', 'レベル2 注意報以上'],
 ['3', 'レベル3 警報以上'],
 ['4', 'レベル4 危険警報以上'],
 ['5', 'レベル5 特別警報'],
]);
export const WARNING_LEVELS = Object.freeze([
 ['all', '注意報以上'],
 ['advisory', '注意報'],
 ['warning', '警報以上'],
 ['special', '特別警報のみ'],
]);
export const EARTHQUAKE_DETAILS = Object.freeze([
 ['all', 'すべての地震情報'],
 ['intensity-flash', '震度速報'],
 ['hypocenter', '震源に関する情報'],
 ['hypocenter-intensity', '震源・震度に関する情報'],
 ['long-period', '長周期地震動に関する観測情報'],
 ['distant-earthquake', '遠地地震に関する情報'],
 ['hypocenter-update', '顕著な地震の震源要素更新のお知らせ'],
]);
export const EEW_DETAILS = Object.freeze([
 ['all', 'すべての緊急地震速報'],
 ['forecast', '緊急地震速報（地震動予報）'],
 ['warning', '緊急地震速報（警報）'],
]);
export const EEW_WARNING_AREA_MODES = Object.freeze([
 ['all', '警報地方を問わない'],
 ['target-only', '対象警報地方のみ'],
]);
export const WEATHER_DETAILS = Object.freeze([
 ['all', 'すべての気象情報'],
 ['heavy-rain-level', '大雨に関する警戒レベル情報'],
 ['landslide-level', '土砂災害に関する警戒レベル情報'],
 ['flood-level', '洪水警報・洪水注意報'],
 ['storm-surge-level', '高潮に関する警戒レベル情報'],
 ['storm-blizzard-warning', '暴風・暴風雪に関する警報・注意報'],
 ['wave-warning', '波浪に関する警報・注意報'],
 ['heavy-snow-warning', '大雪に関する警報・注意報'],
 ['other-advisory', 'その他の気象注意報'],
 ['tornado', '竜巻注意情報'],
 ['record-short-rain', '記録的短時間大雨情報'],
 ['designated-river', '指定河川洪水予報'],
 ['heatstroke', '熱中症警戒アラート'],
 ['early-weather', '早期天候情報'],
 ['general-weather', '全般気象情報'],
 ['typhoon', '台風情報'],
 ['weather-disaster', '気象防災速報'],
 ['linear-rainband', '線状降水帯に関する情報'],
 ['significant-snow', '顕著な大雪情報'],
 ['weather-commentary', '気象解説情報'],
 ['tide-commentary', '気象解説情報（潮位）'],
]);
export const RAIN_RADAR_CONDITIONS = Object.freeze([
 ['all', '定時更新'],
 ['rain-detected', '対象地方で降雨を検出'],
 ['rainfall-threshold', '1時間降水量が閾値以上'],
]);
export const RAIN_RADAR_INTERVALS = Object.freeze([
 ['1', '1時間ごと'],
 ['2', '2時間ごと'],
 ['3', '3時間ごと'],
 ['6', '6時間ごと'],
 ['12', '12時間ごと'],
 ['24', '24時間ごと'],
]);
export const CHANGE_DIRECTIONS = Object.freeze([
 ['all', '変化を問わない'],
 ['increase', '上昇時'],
 ['decrease', '下降時'],
 ['both', '上昇・下降時'],
]);
export const THRESHOLD_MODES = Object.freeze([
 ['all', 'すべて'],
 ['increase', '上昇時のみ'],
 ['threshold', '閾値以上'],
]);
const INTENSITIES = new Set(['1','2','3','4','5-','5+','6-','6+','7']);
const REGION_IDS = new Set(SUPPORTER_REGIONS.map(([id]) => id));
const WEATHER_LEVEL_IDS = new Set(WEATHER_LEVELS.map(([id]) => id));
const WARNING_LEVEL_IDS = new Set(WARNING_LEVELS.map(([id]) => id));
const THRESHOLD_MODE_IDS = new Set(THRESHOLD_MODES.map(([id]) => id));
const EEW_WARNING_AREA_MODE_IDS = new Set(EEW_WARNING_AREA_MODES.map(([id]) => id));
const RAIN_RADAR_CONDITION_IDS = new Set(RAIN_RADAR_CONDITIONS.map(([id]) => id));
const RAIN_RADAR_INTERVAL_IDS = new Set(RAIN_RADAR_INTERVALS.map(([id]) => id));
const DETAILS = {
 earthquake: new Set(EARTHQUAKE_DETAILS.map(([id]) => id)),
 eew: new Set(EEW_DETAILS.map(([id]) => id)),
 weather: new Set(WEATHER_DETAILS.map(([id]) => id)),
 'rain-radar': new Set(['all']),
};
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','flood-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);
const SUPPORTER_TYPE_LABELS = Object.freeze({earthquake:'地震情報',eew:'緊急地震速報',weather:'気象情報','rain-radar':'雨雲レーダー（簡略版）',...Object.fromEntries(IMAGE_RULE_TYPE_OPTIONS)});
const INTENSITY_LABELS = Object.freeze({'1':'震度1','2':'震度2','3':'震度3','4':'震度4','5-':'震度5弱','5+':'震度5強','6-':'震度6弱','6+':'震度6強','7':'震度7'});

function optionLabel(options, value, fallback = '未設定') {
 return options.find(([id])=>id===value)?.[1] || (clean(value) || fallback);
}

function adminConditionLabel(condition, type) {
 const kind=clean(condition?.kind);const value=condition?.value;
 if(kind==='region')return `対象地方：${optionLabel(SUPPORTER_REGIONS,clean(value))}`;
 if(kind==='detail')return `詳細種別：${optionLabel(type==='earthquake'?EARTHQUAKE_DETAILS:type==='eew'?EEW_DETAILS:WEATHER_DETAILS,clean(value))}`;
 if(kind==='intensity')return `震度：${INTENSITY_LABELS[clean(value)]||clean(value)}以上`;
 if(kind==='magnitude')return `マグニチュード：M${Number(value)}以上`;
 if(kind==='weatherLevel')return `警戒レベル：${optionLabel(WEATHER_LEVELS,clean(value))}`;
 if(kind==='warningLevel')return `警報・注意報：${optionLabel(WARNING_LEVELS,clean(value))}`;
 if(kind==='radarCondition')return `雨雲条件：${optionLabel(RAIN_RADAR_CONDITIONS,clean(value))}`;
 if(kind==='rainfallThreshold')return `1時間降水量：${Number(value)}mm/h以上`;
 return `不明な条件：${clean(value)||'未設定'}`;
}

function thresholdLabel(mode, value, kind) {
 if(mode==='increase')return '上昇時のみ';
 if(mode!=='threshold')return 'すべて';
 if(kind==='intensity')return `${INTENSITY_LABELS[clean(value)]||clean(value)}以上`;
 return `M${Number(value)}以上`;
}

function imageRuleAdminDetails(rule, type) {
 if(type==='hires-radar'){
  const threshold=clean(rule?.radarCondition)==='rainfall-threshold';
  return [
   {label:'線状降水帯の表示',value:rule?.linearRainband===true?'有効':'無効'},
   {label:'配信条件',value:optionLabel(HIRES_RADAR_CONDITIONS,clean(rule?.radarCondition)||'scheduled')+(threshold?'（Pro）':'')},
   ...(threshold?[{label:'1時間降水量',value:`${Number(rule?.rainfallThresholdMmPerHour)}mm/h以上`}]:[]),
   {label:'送るもの',value:savedRadarContents(rule).map(id=>optionLabel(HIRES_RADAR_CONTENTS,id)).join('・')},
   ...(savedRadarContents(rule).includes('current')?[{label:'配信頻度',value:radarIntervalText(savedRadarMinutes(rule))}]:[]),
   ...(savedRadarContents(rule).includes('forecast')?[{label:'予想の配信頻度（Pro）',value:radarIntervalText(Number(rule?.forecastIntervalMinutes)||60)}]:[]),
  ];
 }
 if(type==='eew-map'){
  const regions=Array.isArray(rule?.regions)?rule.regions.map(clean).filter(Boolean):[];
  return [{label:'配信する条件',value:regions.length?`選んだ地方が対象のとき：${regions.map(id=>optionLabel(SUPPORTER_REGIONS,id)).join('、')}（Plus以上）`:'全国：警報が発表されたら配信'}];
 }
 if(type==='warning-table'||type==='warning-timeseries'){
  const tables=Array.isArray(rule?.tables)?rule.tables.map(id=>optionLabel(WARNING_TABLE_KINDS,clean(id))).join('、'):'';
  const regions=Array.isArray(rule?.regions)?rule.regions.map(id=>optionLabel(SUPPORTER_REGIONS,clean(id))).join('、'):'';
  return [
   ...(type==='warning-table'?[{label:'送る表',value:tables||'未設定'}]:[]),
   ...(regions?[{label:'対象地方',value:regions}]:[]),
   {label:'配信のタイミング',value:optionLabel(WARNING_TABLE_DELIVER_ON,clean(rule?.deliverOn)||'changed')},
   {label:'発表のない区域',value:rule?.showAllAreas===true?'載せる':'載せない'},
  ];
 }
 if(type==='tsunami-map')return [
  {label:'送るもの',value:savedTsunamiOutputs(rule).map(id=>optionLabel(TSUNAMI_MAP_OUTPUTS,id)).join('・')},
  {label:'発表地域拡大版',value:rule?.enlargedArea===true?'有効（Pro）':'無効'},
 ];
 if(type==='earthquake-map'){
  const kinds=Array.isArray(rule?.products)?rule.products.map(id=>optionLabel(EARTHQUAKE_MAP_PRODUCTS,clean(id))).join('、'):'';
  const regional=rule?.regionMinIntensity&&typeof rule.regionMinIntensity==='object'&&!Array.isArray(rule.regionMinIntensity)?Object.entries(rule.regionMinIntensity):[];
  return [
   {label:'送る情報の種類',value:kinds||'すべて（震度速報・震源・各地の震度・長周期地震動）'},
   {label:'震度のしきい値（全国）',value:clean(rule?.minIntensity)?`${optionLabel(EARTHQUAKE_MAP_INTENSITIES,clean(rule.minIntensity))}（Pro）`:'指定なし'},
   {label:'長周期地震動階級のしきい値',value:clean(rule?.minLgInt)?`長周期地震動階級${clean(rule.minLgInt)}以上（Pro）`:'指定なし'},
   {label:'地方別の震度しきい値',value:regional.length?regional.map(([region,value])=>`${optionLabel(SUPPORTER_REGIONS,region)}：${optionLabel(EARTHQUAKE_MAP_INTENSITIES,clean(value))}`).join('、')+'（Pro）':'指定なし'},
   {label:'地図の中心にする市区町村',value:clean(rule?.centerMunicipality)?`${clean(rule.centerMunicipality)}（Pro）`:'指定なし（自動）'},
  ];
 }
 const products=Array.isArray(rule?.products)?rule.products.map(id=>optionLabel(WEATHER_MAP_PRODUCTS,clean(id))).join('、'):'';
 const details=[
  {label:'対象の警報・注意報',value:products||'未設定'},
  {label:'配信基準',value:optionLabel(WEATHER_MAP_SEVERITIES,clean(rule?.minSeverity)||'warning')},
 ];
 if(clean(rule?.prefecture)&&clean(rule.prefecture)!=='all')details.push({label:'都道府県（Pro）',value:PREFECTURES.find(row=>row.code===clean(rule.prefecture))?.name||clean(rule.prefecture)});
 if(Array.isArray(rule?.municipalities)&&rule.municipalities.length)details.push({label:'市区町村（気象庁コード・Pro）',value:rule.municipalities.map(clean).join('、')});
 details.push({label:'市区町村の詳細',value:rule?.municipalityDetail===true?'有効（Pro）':'無効'});
 return details;
}

export function supporterAdminDetails(row, channelsByGuild = {}) {
 let settings={};let guilds=[];
 try{settings=JSON.parse(row.settings_json||'{}');}catch{/* Keep an empty rule set for malformed legacy data. */}
 try{const parsed=JSON.parse(row.guilds_json||'[]');guilds=Array.isArray(parsed)?parsed:[];}catch{/* Guild names remain unavailable. */}
 const rules=Array.isArray(settings.rules)?settings.rules:[];
 return {
  discordUserId:row.discord_user_id,
  discordName:row.discord_name||'',
  accountStatus:row.account_status||'active',
  statusReason:row.status_reason||'',
  statusUpdatedAt:row.status_updated_at||null,
  statusUpdatedBy:row.status_updated_by||'',
  rules:rules.map((rule,index)=>{
   const type=clean(rule?.type);const guildId=clean(rule?.guildId);
   const requested=Array.isArray(rule?.channelIds)?rule.channelIds.map(clean).filter(Boolean):[];
   const channelIds=[...new Set(requested.length?requested:[clean(rule?.channelId)].filter(Boolean))];
   const channels=Array.isArray(channelsByGuild[guildId])?channelsByGuild[guildId]:[];
   const details=[
    {label:'情報種別',value:SUPPORTER_TYPE_LABELS[type]||type||'未設定'},
   ];
   if(isImageRuleType(type)){
    if(!['earthquake-map','eew-map','warning-table','warning-timeseries'].includes(type))details.push({label:'対象地方',value:optionLabel(SUPPORTER_REGIONS,clean(rule?.region)||'all')});
    details.push(...imageRuleAdminDetails(rule,type));
   }else details.push(
    {label:'詳細種別',value:type==='rain-radar'?'雨雲レーダー（簡略版）':optionLabel(type==='earthquake'?EARTHQUAKE_DETAILS:type==='eew'?EEW_DETAILS:WEATHER_DETAILS,clean(rule?.detail)||'all')},
    {label:'対象地方',value:optionLabel(SUPPORTER_REGIONS,clean(rule?.region)||'all')},
    {label:'条件の組み合わせ',value:clean(rule?.conditionLogic)==='or'?'いずれかを満たす（OR）':'すべて満たす（AND）'},
    ...(type==='eew'?[{label:'最終報を送信',value:rule?.sendFinalReport===false?'震度が変化した場合のみ':'送信する（初期値）'}]:[]),
   );
   if(!isImageRuleType(type)){
   if(clean(rule?.prefecture)&&clean(rule.prefecture)!=='all')details.push({label:'都道府県',value:PREFECTURES.find(row=>row.code===clean(rule.prefecture))?.name||clean(rule.prefecture)});
   if(clean(rule?.district)&&clean(rule.district)!=='all')details.push({label:'北海道内の地方区分',value:clean(rule.district)});
   if(clean(rule?.municipality)&&clean(rule.municipality)!=='all')details.push({label:'市区町村（気象庁コード）',value:clean(rule.municipality)});
   if(rule?.strictMunicipality===true)details.push({label:'指定市区町村のみ表示',value:'有効（Pro）'});
   if(type==='rain-radar'){
    details.push({label:'配信条件',value:optionLabel(RAIN_RADAR_CONDITIONS,clean(rule?.radarCondition)||'all')});
    if(clean(rule?.radarCondition)==='rainfall-threshold')details.push({label:'1時間降水量',value:`${Number(rule?.rainfallThresholdMmPerHour)}mm/h以上`});
    details.push({label:'配信頻度',value:optionLabel(RAIN_RADAR_INTERVALS,String(rule?.deliveryIntervalHours||1))});
   }else if(type==='weather'){
    if(clean(rule?.weatherLevel))details.push({label:'警戒レベル',value:optionLabel(WEATHER_LEVELS,clean(rule.weatherLevel))});
    if(clean(rule?.warningLevel))details.push({label:'警報・注意報',value:optionLabel(WARNING_LEVELS,clean(rule.warningLevel))});
   }else{
    details.push({label:'震度条件',value:thresholdLabel(clean(rule?.intensityMode)||'all',rule?.intensity,'intensity')});
    details.push({label:'マグニチュード条件',value:thresholdLabel(clean(rule?.magnitudeMode)||'all',rule?.magnitudeMin,'magnitude')});
    if(type==='eew'&&clean(rule?.detail)==='warning')details.push({label:'警報地方条件',value:optionLabel(EEW_WARNING_AREA_MODES,clean(rule?.eewWarningAreaMode)||'all')});
   }
   }
   const additional=Array.isArray(rule?.conditions)?rule.conditions:[];
   additional.forEach((condition,conditionIndex)=>details.push({label:`追加条件 ${conditionIndex+1}`,value:adminConditionLabel(condition,type)}));
   return {
    name:clean(rule?.name)||`通知ルール ${index+1}`,
    guildId,
    guildName:guilds.find(guild=>String(guild?.id)===guildId)?.name||'',
    channels:channelIds.map(id=>({id,name:channels.find(channel=>String(channel?.id)===id)?.name||''})),
    details,
   };
  }),
 };
}

function optionalMagnitude(value) {
 if (value === '' || value === undefined || value === null) return null;
 const number = Number(value);
 if (!Number.isFinite(number) || number < 0 || number > 10) throw Object.assign(new Error('マグニチュードは0から10の範囲で指定してください。'),{status:400});
 return Math.round(number * 10) / 10;
}

function optionalRainfallThreshold(value) {
 if (value === '' || value === undefined || value === null) return null;
 const number = Number(value);
 if (!Number.isFinite(number) || number < 0.1 || number > 20) throw Object.assign(new Error('現在の雨雲レーダーで判定できる閾値は0.1から20mm/hです。'),{status:400});
 return Math.round(number * 10) / 10;
}

function thresholdMode(rule, key, legacyKey, thresholdValue) {
 const requested = clean(rule?.[key]);
 if (THRESHOLD_MODE_IDS.has(requested)) return requested;
 if (clean(rule?.[legacyKey]) === 'increase') return 'increase';
 return thresholdValue !== '' && thresholdValue !== undefined && thresholdValue !== null ? 'threshold' : 'all';
}

function normalizeAdditionalConditions(input,type,complexConditions){
 const requested=Array.isArray(input)?input:[];
 if(requested.length>8)throw Object.assign(new Error('追加条件は1ルールにつき8件までです。'),{status:400});
 if(requested.length&&!complexConditions)throw Object.assign(new Error('複数条件はProプランで利用できます。'),{status:400});
 const normalized=requested.map(condition=>{
  const kind=clean(condition?.kind);const raw=condition?.value;const value=clean(raw);
  if(kind==='region'&&REGION_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='detail'&&type!=='rain-radar'&&DETAILS[type].has(value))return{kind,operator:'equals',value};
  if(kind==='intensity'&&['earthquake','eew'].includes(type)&&INTENSITIES.has(value))return{kind,operator:'at_least',value};
  if(kind==='magnitude'&&['earthquake','eew'].includes(type)){const magnitude=optionalMagnitude(raw);if(magnitude!==null)return{kind,operator:'at_least',value:magnitude};}
  if(kind==='weatherLevel'&&type==='weather'&&WEATHER_LEVEL_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='warningLevel'&&type==='weather'&&WARNING_LEVEL_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='radarCondition'&&type==='rain-radar'&&RAIN_RADAR_CONDITION_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='rainfallThreshold'&&type==='rain-radar'&&complexConditions){const rainfall=optionalRainfallThreshold(raw);if(rainfall!==null)return{kind,operator:'at_least',value:rainfall};}
  throw Object.assign(new Error('追加条件の種類または値を確認してください。'),{status:400});
 });
 const unique=[];const seen=new Set();
 for(const condition of normalized){const key=`${condition.kind}:${condition.value}`;if(!seen.has(key)){seen.add(key);unique.push(condition);}}
 return unique;
}

// While the image flag is off, an image rule that is identical to an already stored one is kept
// as stored (so customers can still save their other rules); new or edited image rules are refused.
function storedImageRuleMatch(rule, storedImageRules) {
 for (const stored of storedImageRules || []) {
  const keys = Object.keys(stored);
  if (keys.every(key => JSON.stringify(rule?.[key] ?? null) === JSON.stringify(stored[key] ?? null))) return stored;
 }
 return null;
}

export function normalizeSupporterRules(input, guilds, limits = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}, catalogue = null, {imageRules = false, imageRulesV2 = false, storedImageRules = []} = {}) {
 const ruleLimit=Math.max(1,Number(limits.rules)||5);
 if (!Array.isArray(input) || input.length > ruleLimit) throw Object.assign(new Error(`通知ルールは${ruleLimit}件までです。`),{status:400});
 const rules = input.map(rule => {
  const name = clean(rule?.name);
  const guildId = clean(rule?.guildId);
  const requestedChannelIds=Array.isArray(rule?.channelIds)?rule.channelIds.map(clean).filter(Boolean):[];
  const channelIds=[...new Set(requestedChannelIds.length?requestedChannelIds:[clean(rule?.channelId)])];
  const channelId=channelIds[0]||'';
  // 配信用スナップショット（AWS・Bot）は1ルール20チャンネルまで。超えると全員分の更新が拒否されるため保存時に止める。
  if(channelIds.length>20)throw Object.assign(new Error('1つのルールの配信先は20チャンネルまでです。ルールを分けてください。'),{status:400});
  const type = clean(rule?.type);
  if (isImageRuleType(type)) {
   // Image rules are gated by SUPPORTER_IMAGE_RULES_ENABLED (default off); eew-map and
   // warning-table / warning-timeseries also by SUPPORTER_IMAGE_RULES_V2_ENABLED (default off).
   if (!imageRules || (isImageRuleV2Type(type) && !imageRulesV2)) {
    const kept = storedImageRuleMatch(rule, storedImageRules);
    if (kept && guilds.some(g=>g.id===kept.guildId)) return kept;
    throw Object.assign(new Error('画像配信ルールは現在準備中のため、新規作成・変更はできません。'),{status:400});
   }
   if (!name || name.length > 80 || !guilds.some(g=>g.id===guildId) || !channelIds.length || channelIds.some(id=>!/^\d{17,20}$/.test(id)))
    throw Object.assign(new Error('入力内容とサーバー管理権限を確認してください。'),{status:400});
   if(channelIds.length>1&&!limits.multiDestination)throw Object.assign(new Error('1つのルールから複数チャンネルへの配信はPROプランで利用できます。'),{status:400});
   // Conditions and OR logic do not apply to image rules.
   return {name,guildId,channelId,channelIds,type,conditionLogic:'and',conditions:[],...normalizeImageRuleFields(rule,type,limits,catalogue)};
  }
  const region = clean(rule?.region) || 'all';
  const conditionLogic=clean(rule?.conditionLogic)||'and';
  const geographic=normalizeGeographicRule(rule,region,limits,catalogue);
  if(type==='rain-radar'&&geographic.prefecture!=='all')
   throw Object.assign(new Error('現在の雨雲レーダー画像は地方単位です。都道府県・市区町村単位の正確な降雨判定には対応していません。'),{status:400});
  if(type==='eew'&&(geographic.district!=='all'||geographic.municipality!=='all'))
   throw Object.assign(new Error('緊急地震速報には市区町村単位の確定した警報対象コードが含まれないため、地方・都道府県単位で設定してください。'),{status:400});
  if (!name || name.length > 80 || !guilds.some(g=>g.id===guildId) || !channelIds.length || channelIds.some(id=>!/^\d{17,20}$/.test(id))
      || !['earthquake','eew','weather','rain-radar'].includes(type) || !REGION_IDS.has(region)) {
   throw Object.assign(new Error('入力内容とサーバー管理権限を確認してください。'),{status:400});
  }
  if(!['and','or'].includes(conditionLogic))throw Object.assign(new Error('条件の組み合わせ方法を確認してください。'),{status:400});
  if(conditionLogic==='or'&&!limits.complexConditions)throw Object.assign(new Error('OR条件はPROプランで利用できます。'),{status:400});
  if(channelIds.length>1&&!limits.multiDestination)throw Object.assign(new Error('1つのルールから複数チャンネルへの配信はPROプランで利用できます。'),{status:400});
  const requestedDetail = clean(rule?.detail) || 'all';
  const detail = type === 'eew' && requestedDetail === 'intensity-change' ? 'forecast' : requestedDetail;
  if (!DETAILS[type].has(detail)) throw Object.assign(new Error('情報の詳細種別を確認してください。'),{status:400});
  const conditions=normalizeAdditionalConditions(rule?.conditions,type,limits.complexConditions===true);
  if (type === 'rain-radar') {
   const radarCondition=clean(rule?.radarCondition)||'all';
   const deliveryIntervalHours=clean(rule?.deliveryIntervalHours)||'1';
   if(!RAIN_RADAR_CONDITION_IDS.has(radarCondition))throw Object.assign(new Error('雨雲レーダーの配信条件を確認してください。'),{status:400});
   if(!RAIN_RADAR_INTERVAL_IDS.has(deliveryIntervalHours))throw Object.assign(new Error('雨雲レーダーの配信頻度を確認してください。'),{status:400});
   if(radarCondition==='rainfall-threshold'&&limits.rainfallThreshold!==true)throw Object.assign(new Error('1時間降水量の閾値指定はPlus以上のプランで利用できます。'),{status:400});
   const rainfallThresholdMmPerHour=radarCondition==='rainfall-threshold'?optionalRainfallThreshold(rule?.rainfallThresholdMmPerHour):null;
   if(radarCondition==='rainfall-threshold'&&rainfallThresholdMmPerHour===null)throw Object.assign(new Error('1時間降水量の閾値を入力してください。'),{status:400});
   return {name,guildId,channelId,channelIds,type,detail:'all',region,...geographic,conditionLogic,conditions,intensityMode:'',intensity:'',magnitudeMode:'',magnitudeMin:null,weatherLevel:'',warningLevel:'',eewWarningAreaMode:'',radarCondition,rainfallThresholdMmPerHour,deliveryIntervalHours:Number(deliveryIntervalHours)};
  }
  if (type === 'weather') {
   const weatherLevel = WEATHER_ALERT_DETAILS.has(detail) ? (clean(rule?.weatherLevel) || 'all') : '';
   const warningLevel = WEATHER_WARNING_DETAILS.has(detail) ? (clean(rule?.warningLevel) || 'all') : '';
   if (weatherLevel && !WEATHER_LEVEL_IDS.has(weatherLevel)) throw Object.assign(new Error('気象情報の警戒レベルを確認してください。'),{status:400});
   if (warningLevel && !WARNING_LEVEL_IDS.has(warningLevel)) throw Object.assign(new Error('警報・注意報の条件を確認してください。'),{status:400});
   return {name,guildId,channelId,channelIds,type,detail,region,...geographic,conditionLogic,conditions,intensityMode:'',intensity:'',magnitudeMode:'',magnitudeMin:null,weatherLevel,warningLevel,eewWarningAreaMode:'',radarCondition:'',rainfallThresholdMmPerHour:null,deliveryIntervalHours:null};
  }
  const intensityMode = thresholdMode(rule,'intensityMode','intensityChange',rule?.intensity);
  const magnitudeMode = thresholdMode(rule,'magnitudeMode','magnitudeChange',rule?.magnitudeMin);
  const intensity = intensityMode === 'threshold' ? clean(rule?.intensity) : '';
  const magnitudeMin = magnitudeMode === 'threshold' ? optionalMagnitude(rule?.magnitudeMin) : null;
  if (intensityMode === 'threshold' && !INTENSITIES.has(intensity)) throw Object.assign(new Error('閾値以上で通知する震度を確認してください。'),{status:400});
  if (magnitudeMode === 'threshold' && magnitudeMin === null) throw Object.assign(new Error('閾値以上で通知するマグニチュードを入力してください。'),{status:400});
  const eewWarningAreaMode = type === 'eew' && detail === 'warning' ? (clean(rule?.eewWarningAreaMode) || 'all') : '';
  if (eewWarningAreaMode && !EEW_WARNING_AREA_MODE_IDS.has(eewWarningAreaMode)) throw Object.assign(new Error('緊急地震速報（警報）の対象地方条件を確認してください。'),{status:400});
  return {name,guildId,channelId,channelIds,type,detail,region,...geographic,conditionLogic,conditions,intensityMode,intensity,magnitudeMode,magnitudeMin,weatherLevel:'',warningLevel:'',eewWarningAreaMode,sendFinalReport:type==='eew'?rule?.sendFinalReport!==false:true,radarCondition:'',rainfallThresholdMmPerHour:null,deliveryIntervalHours:null};
 });
 const serverCount = new Set(rules.map(rule => rule.guildId)).size;
 const channelCount = new Set(rules.flatMap(rule => rule.channelIds.map(channelId=>`${rule.guildId}:${channelId}`))).size;
 const serverLimit = Math.max(1,Number(limits.servers)||1);
 const channelLimit = Math.max(1,Number(limits.channels)||2);
 if (serverCount > serverLimit) throw Object.assign(new Error(`契約上限は${serverLimit}サーバーです。サーバー追加オプションを契約するか、同じサーバーを選択してください。`),{status:400});
 if (channelCount > channelLimit) throw Object.assign(new Error(`契約上限は${channelLimit}チャンネルです。チャンネル追加オプションを契約するか、通知先を減らしてください。`),{status:400});
 return rules;
}

export function supporterOptions(env) {
 const base={regions:SUPPORTER_REGIONS,prefectures:PREFECTURES,weatherLevels:WEATHER_LEVELS,warningLevels:WARNING_LEVELS,earthquakeDetails:EARTHQUAKE_DETAILS,eewDetails:EEW_DETAILS,eewWarningAreaModes:EEW_WARNING_AREA_MODES,weatherDetails:WEATHER_DETAILS,thresholdModes:THRESHOLD_MODES,rainRadarConditions:RAIN_RADAR_CONDITIONS,rainRadarIntervals:RAIN_RADAR_INTERVALS};
 // Image rule types are only offered once SUPPORTER_IMAGE_RULES_ENABLED === "1".
 return imageRulesEnabled(env)?{...base,imageRulesEnabled:true,...imageRuleOptions(imageRulesV2Enabled(env))}:{...base,imageRulesEnabled:false};
}

async function supporterLimits(env, db, uid) {
 const fallback = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,rainfallThreshold:false};
 if (!billingReady(env)) throw Object.assign(new Error('決済設定を確認できないため、通知設定を保存できません。'),{status:503});
 const account=await db.prepare('SELECT account_status,status_reason,status_updated_at FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 assertSupporterAccountActive(account);
 const row = await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if (!row?.customer_id) throw Object.assign(new Error('通知設定は有料プランの契約後に利用できます。'),{status:409});
 try {
  const suspension = await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE customer_id=? AND status='suspended' ORDER BY CASE WHEN invoice_id LIKE 'hold:dispute:%' THEN 0 ELSE 1 END LIMIT 1`).bind(row.customer_id).first();
  if (String(suspension?.invoice_id||'').startsWith('hold:dispute:')) throw Object.assign(new Error('お支払いへの異議申立てを確認中のため、有料プランの通知設定は利用停止中です。お問い合わせください。'),{status:409});
  if (suspension) throw Object.assign(new Error('お支払いを確認できなかったため、有料プランの通知設定は利用停止中です。未払いの請求書をすべてお支払いください。'),{status:409});
  await reconcilePaidCheckoutSubscription(env,row.customer_id,uid,db);
  const custom=await getCustomPlan(db,uid);
  const summaries=enrichCustomSubscriptions(await customerSubscriptionSummaries(env,row.customer_id),custom);
  const active = summaries.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
  if (!active.length) throw Object.assign(new Error('通知設定は有効な契約を確認してから利用できます。'),{status:409});
  // Plan features (rainfallThreshold, imageDelivery, ...) come from one shared table.
  return {...active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),fallback),...planFeatures(active),...geographicEntitlements(active)};
 } catch(error) { if(error?.status===409)throw error;throw Object.assign(new Error('契約上限を確認できませんでした。時間をおいて再試行してください。'),{status:503}); }
}

async function assertRuleChannels(rules, env) {
 const byGuild = new Map();
 for (const rule of rules) {
  if (!byGuild.has(rule.guildId)) byGuild.set(rule.guildId, await fetchGuildChannels(rule.guildId, env));
  if (rule.channelIds.some(channelId=>!byGuild.get(rule.guildId).some(channel => String(channel.id) === channelId))) {
   throw Object.assign(new Error('選択したチャンネルを確認できません。再読み込みして選び直してください。'),{status:400});
  }
 }
}

export function supporterPublicEnabled(env) {
 return clean(env.SUPPORTER_PUBLIC_ENABLED).toLowerCase() === 'true';
}
// テスト公開：リンクを知っている人は誰でも画面と API を使える（検索避けは維持、配信には使わない）。
export function supporterPreviewOpen(env) {
 return clean(env.SUPPORTER_PREVIEW_OPEN).toLowerCase() === 'true';
}
// 準備中（メンテナンス中）：ログインと閲覧はできるが、申込み・支払い・契約変更・通知設定の保存は受け付けない。
// Stripe の Webhook は対象外。
export const SUPPORTER_INTAKE_PAUSED_MESSAGE = '現在準備中（メンテナンス中）のため、お申込み・お支払い・契約変更・通知設定の保存は受け付けていません。再開までお待ちください。';
export function supporterIntakePaused(env) {
 return clean(env.SUPPORTER_INTAKE_PAUSED).toLowerCase() === 'true';
}
// 申込み・チャージの連続作成を抑える（Cloudflare の Rate Limiting。1分10回）。設定が無い・確認できないときは通す。
export async function assertSupporterRate(env, key) {
 const limiter = env.SUPPORTER_RATE_LIMITER;
 if (typeof limiter?.limit !== 'function') return;
 let allowed = true;
 try { allowed = (await limiter.limit({key})).success !== false; }
 catch (error) { console.error('Supporter rate limiter is unavailable', {errorName: error?.name || 'Error'}); }
 if (!allowed) throw Object.assign(new Error('短時間に操作が続いたため受け付けられません。1分ほど待ってからお試しください。'), {status: 429});
}
function supporterPlansResponse(env) {
 return {mode:billingMode(env), billingEnabled:billingReady(env), intakePaused:supporterIntakePaused(env), previewOpen:supporterPreviewOpen(env)&&!supporterPublicEnabled(env), deliveryEnabled:supporterPublicEnabled(env)&&billingReady(env), customRequests:{enabled:customRequestsEnabled(env)}, plans:publicPlans(), addons:{channel:{yen:200,channels:3},server:{yen:200,servers:2},rule:{yen:200,rules:3},prorated:false},billingDay:26};
}
export function supporterTestUserAllowed(env, discordUserId) {
 if (supporterPublicEnabled(env) || supporterPreviewOpen(env)) return true;
 const allowed = new Set(clean(env.SUPPORTER_TEST_USER_IDS)
  .split(',')
  .map(value => value.trim())
  .filter(value => /^\d{17,20}$/.test(value)));
 return allowed.has(String(discordUserId || ''));
}

async function supporterSite(request, env, db) {
 const method = request.method.toUpperCase();
 if (!['GET', 'HEAD'].includes(method)) return notFound();
 let reviewSetCookie = null;
 // Comparison assets and the contract dashboard share the same access gate.
 // Never bypass authentication for plans.html or its associated stylesheet.
 if (!supporterPublicEnabled(env) && !supporterPreviewOpen(env)) {
  let allowed = false;
  try {
   const session = await requireSession(request, {...env, REUSE_DB: db});
   allowed = supporterTestUserAllowed(env, session.discord_user_id);
  } catch { /* Hide both missing sessions and configuration details. */ }
  if (!allowed) {
   try {
    await authenticateNewsletterAdmin(request, env);
    allowed = true;
   } catch { /* Return the same 404 for every unauthorized visitor. */ }
  }
  // 決済サービスの審査用：ユーザー名・パスワードが設定されているときだけ入力を求める。
  if (!allowed && reviewAccessConfigured(env)) {
   if (await reviewCookieValid(request, env)) allowed = true;
   else if (await basicCredentialsValid(request, env)) { allowed = true; reviewSetCookie = await reviewCookie(env); }
   else return reviewChallenge();
  }
  if (!allowed) return notFound();
 }
 const asset = await env.ASSETS.fetch(request);
 const headers = new Headers(asset.headers);
 headers.set('Cache-Control', 'private, no-store');
 if (reviewSetCookie) headers.append('Set-Cookie', reviewSetCookie);
 if (!supporterPublicEnabled(env)) headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
 return new Response(asset.body, {status: asset.status, statusText: asset.statusText, headers});
}

export async function handleSupporterRequest(request, env, ctx) {
 const path = new URL(request.url).pathname;
 const isSupporterSite = path === '/site/supporter' || path.startsWith('/site/supporter/');
 const isSupporterAdmin = path === '/site/supporter-admin' || path.startsWith('/site/supporter-admin/');
 if (!path.startsWith('/api/supporter/') && !isSupporterAdmin && !isSupporterSite) return null;
 try {
  const db = env.REUSE_DB || env.NEWSLETTER_DB;
  if (isSupporterSite) return await supporterSite(request, env, db);
  if (isSupporterAdmin) {
   const admin = await authenticateNewsletterAdmin(request, env);
   if (path === '/site/supporter-admin') {
    const redirect = new URL(request.url);redirect.pathname='/site/supporter-admin/';
    return new Response(null,{status:308,headers:{Location:redirect.toString(),'Cache-Control':'no-store'}});
   }
   if(path==='/site/supporter-admin/api/custom-requests'||path.startsWith('/site/supporter-admin/api/custom-requests/')){
    if(request.method!=='GET')assertAdminOrigin(request);
    return await handleSupporterCustomRequestAdminApi(request,db);
   }
   if(path==='/site/supporter-admin/api/credit-campaigns'){
    if(request.method!=='POST')return response({message:'Method not allowed'},405);
    assertAdminOrigin(request);
    const input=await readJson(request);
    if(clean(input.confirmText)!=='配布')return response({message:'確認欄に「配布」と入力してください。'},400);
    const campaign=await createCompensationCampaign(env,db,admin,input);
    return response({success:true,message:`${campaign.recipientCount}人への補償クレジット配布を作成しました。`,campaign},201);
   }
   const campaignProcessMatch=path.match(/^\/site\/supporter-admin\/api\/credit-campaigns\/([0-9a-f-]{36})\/process$/i);
   if(campaignProcessMatch){
    if(request.method!=='POST')return response({message:'Method not allowed'},405);
    assertAdminOrigin(request);
    const campaign=await processCompensationCampaign(env,db,admin,campaignProcessMatch[1]);
    return response({success:true,message:campaign.status==='completed'?'補償クレジットの配布が完了しました。':campaign.status==='partial'?'一部の対象者へ配布できませんでした。':campaign.status==='failed'?'補償クレジットを配布できませんでした。':'補償クレジットを配布中です。',campaign});
   }
   if (path === '/site/supporter-admin/api/custom-plan') {
    if(request.method!=='POST')return response({message:'Method not allowed'},405);
    assertAdminOrigin(request);
    const input=await readJson(request);
    const uid=clean(input.discordUserId),reason=clean(input.reason),requestId=clean(input.requestId);
    if(!/^\d{17,20}$/.test(uid)||input.confirmDiscordUserId!==uid)return response({message:'対象Discord IDを再入力してください。'},400);
    if(reason.length<5||reason.length>500)return response({message:'変更理由を5〜500文字で入力してください。'},400);
    if(!/^[0-9a-f-]{36}$/i.test(requestId))return response({message:'要求IDが不正です。'},400);
    const account=await db.prepare(`SELECT a.discord_user_id,a.billing_email,a.account_status,b.customer_id
     FROM supporter_accounts a LEFT JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id WHERE a.discord_user_id=?`).bind(uid).first();
    if(!account)return response({message:'対象ユーザーは有料プランに未登録です。'},404);
    // BAN 後の後片付け（カスタムプランの停止・変更取消）はできるようにする。
    if(!['cancel','cancel-change'].includes(clean(input.action)))assertSupporterAccountActive(account);
    let current=await getCustomPlan(db,uid);
    if(['preview','save'].includes(input.action)){
     const next=normalizeCustomPlan(input);
     const active=current?.status==='active';
     if(active){
      // Recover a paid Checkout before allowing a second change.
      if(account.customer_id)await recoverCustomPriceChanges(env,db,uid);
      current=await getCustomPlan(db,uid);
      const pending=await currentCustomChange(db,uid);
      if(pending){
       return response({message:'既存の料金変更が未完了です。決済または取消後にもう一度お試しください。',
        customPlan:customPublic(current),pendingChange:customChangePublic(pending)},409);
      }
      if(!account.customer_id)return response({message:'Stripe契約者が登録されていません。'},409);
      const stripeSubscription=await verifiedCustomSubscription(env,account.customer_id,uid,current);
      const stripeItem=stripeSubscription.items.data[0];
      if(Number(stripeItem.price.unit_amount)!==Number(current.confirmed_yen)
        ||Number(stripeSubscription.metadata?.dpi_custom_revision)!==Number(current.revision))
       return response({message:'Stripeの契約料金がDBと一致しないため変更を停止しました。'},409);
      const quote=customChangeQuote(current,input);
      if(quote.immediateDueYen>0&&quote.immediateDueYen<50)return response({
       message:'追加決済が50円未満です。Stripeの最低決済金額を満たさないため、料金を調整してください。',quote},409);
      if(input.action==='preview')return response({success:true,quote,customPlan:customPublic(current)});
      if(Number(input.expectedRevision)!==Number(current.revision))
       return response({message:'別の管理者によって料金または権限が更新されました。最新情報を読み直してください。'},409);
      let staged;
      try{
       staged=await stageCustomChange(db,uid,account.customer_id,current,input,admin.email,reason,requestId);
      }catch(error){
       if(String(error?.message||'').includes('UNIQUE'))return response({message:'すでに変更処理中の契約があります。決済結果を確認してください。'},409);
       throw error;
      }
      let session=null,result=null;
      if(quote.immediateDueYen>0){
       session=await createCustomDifferenceCheckout(env,account.customer_id,uid,current,staged);
       const updated=await db.prepare(`UPDATE supporter_custom_plan_changes SET checkout_session_id=?,checkout_expires_at=?,updated_at=?
        WHERE request_id=? AND status='pending' AND checkout_session_id IS NULL`)
        .bind(session.id,session.expiresAt,new Date().toISOString(),requestId).run();
       if(!updated.meta?.changes){
        await expireCustomCheckout(env,session.id,`dpi-custom-change-stale-${requestId}`);
        return response({message:'別の操作で料金変更が開始されました。新しい決済リンクを無効化しました。'},409);
       }
      }else{
       result=await settleCustomPriceChange(env,db,uid,requestId);
      }
      const fresh=await getCustomPlan(db,uid);
      const change=await currentCustomChange(db,uid);
      await writeSupporterAudit(db,admin.email,'custom_price_change',uid,{
       requestId,reason,oldMonthlyYen:quote.oldMonthlyYen,newMonthlyYen:quote.newMonthlyYen,
       differenceYen:quote.differenceYen,immediateDueYen:quote.immediateDueYen,
       paid:result?.applied===true,checkoutId:session?.id||null,
      });
      if(result?.applied){
       const snapshotTask=refreshSupporterAccessSafely(env,db,'custom_price_changed',uid);
       if(ctx?.waitUntil)ctx.waitUntil(snapshotTask);else await snapshotTask;
      }
      return response({success:true,customPlan:customPublic(fresh),pendingChange:customChangePublic(change),
       quote,url:session?.url||null,
       message:session?'当月分の差額のみを請求する専用URLを発行しました。決済確認後に月額と利用権限を更新します。':
        '契約内容を更新しました。当月の追加請求・返金はなく、次回以降は新しい月額を適用します。'});
     }
     if(input.action==='preview')return response({success:true,quote:null,customPlan:customPublic(current)});
     if(!active&&account.customer_id){
      const subs=await customerSubscriptionSummaries(env,account.customer_id);
      if(subs.some(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status)&&item.customId!==current?.id))
       return response({message:'既存の通常契約があります。二重請求防止のため、契約を管理者が終了した後でカスタムプランを提供してください。'},409);
     }
     if(current?.stripe_checkout_id&&current.status==='offered')await expireCustomCheckout(env,current.stripe_checkout_id,`dpi-custom-expire-${current.id}-${current.revision}`);
     const now=new Date().toISOString();
     const values=[next.name,next.channels,next.servers,next.rules,Number(next.complexConditions),Number(next.municipalityBranching),Number(next.contentExtraction),Number(next.multiDestination),Number(next.secondaryReuse),next.estimatedYen,next.monthlyYen,reason,admin.email,now,JSON.stringify(next.features)];
     if(current){
      const updated=await db.prepare(`UPDATE supporter_custom_plans SET name=?,channel_limit=?,server_limit=?,rule_limit=?,
       complex_conditions=?,municipality_branching=?,content_extraction=?,multi_destination=?,secondary_reuse=?,
       estimated_yen=?,confirmed_yen=?,reason=?,updated_by=?,updated_at=?,features_json=?,
       revision=CASE WHEN status='active' THEN revision ELSE revision+1 END,
       stripe_checkout_id=CASE WHEN status='active' THEN stripe_checkout_id ELSE NULL END,
       checkout_expires_at=CASE WHEN status='active' THEN checkout_expires_at ELSE NULL END,
       status=CASE WHEN status='active' THEN 'active' ELSE 'offered' END
       WHERE discord_user_id=? AND revision=?`).bind(...values,uid,current.revision).run();
      if(!updated.meta?.changes)return response({message:'別の管理者によって更新されました。画面を再読み込みしてください。'},409);
     }else{
      await db.prepare(`INSERT INTO supporter_custom_plans
       (discord_user_id,id,name,channel_limit,server_limit,rule_limit,complex_conditions,municipality_branching,content_extraction,
        multi_destination,secondary_reuse,estimated_yen,confirmed_yen,reason,updated_by,created_at,updated_at,features_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
       .bind(uid,crypto.randomUUID(),next.name,next.channels,next.servers,next.rules,
        Number(next.complexConditions),Number(next.municipalityBranching),Number(next.contentExtraction),
        Number(next.multiDestination),Number(next.secondaryReuse),next.estimatedYen,next.monthlyYen,reason,admin.email,now,now,JSON.stringify(next.features)).run();
     }
     current=await getCustomPlan(db,uid);
    }else if(input.action==='cancel-change'){
     if(!current||current.status!=='active')return response({message:'契約中のカスタムプランがありません。'},409);
     const pending=await currentCustomChange(db,uid);
     if(!pending)return response({message:'取り消せる差額決済はありません。'},409);
     if(pending.status==='paid')return response({message:'差額の入金が確認されています。変更の適用・返金は管理者の確認が必要です。'},409);
     if(pending.checkout_session_id)
      await expireCustomCheckout(env,pending.checkout_session_id,`dpi-custom-change-cancel-${pending.request_id}`);
     await db.prepare(`UPDATE supporter_custom_plan_changes SET status='canceled',updated_at=?
      WHERE request_id=? AND status='pending'`).bind(new Date().toISOString(),pending.request_id).run();
     await writeSupporterAudit(db,admin.email,'custom_change_canceled',uid,{requestId:pending.request_id,reason});
     return response({success:true,message:'未決済の料金変更を取り消しました。既存の契約は継続しています。'});
    }else if(input.action==='checkout'){
     if(!current||current.status!=='offered')return response({message:'まず提供するカスタムプランを保存してください。'},409);
     if(!billingReady(env))return response({message:'Stripeテスト決済が利用できません。'},503);
     if(!account.billing_email)return response({message:'ユーザーのメールアドレスが未登録です。'},409);
     if(!account.customer_id){
      const customer=await createBillingCustomer(env,uid,account.billing_email,`dpi-custom-customer-${uid}`);
      await db.prepare(`INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)
       ON CONFLICT(discord_user_id) DO UPDATE SET customer_id=COALESCE(customer_id,excluded.customer_id)`).bind(uid,customer.id).run();
      account.customer_id=(await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first()).customer_id;
     }
     const other=await customerSubscriptionSummaries(env,account.customer_id);
     if(other.some(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status)))
      return response({message:'既に有効な契約があります。二重請求防止のため新しい決済リンクは発行しません。'},409);
     if(current.stripe_checkout_id)await expireCustomCheckout(env,current.stripe_checkout_id,`dpi-custom-expire-${current.id}-${current.revision}`);
     const session=await createCustomCheckout(env,account.customer_id,uid,current,requestId);
     const changed=await db.prepare(`UPDATE supporter_custom_plans SET stripe_checkout_id=?,checkout_expires_at=?,updated_at=?
      WHERE discord_user_id=? AND revision=? AND status='offered'`)
      .bind(session.id,session.expiresAt,new Date().toISOString(),uid,current.revision).run();
     if(!changed.meta?.changes){await expireCustomCheckout(env,session.id,`dpi-custom-stale-${session.id}`);return response({message:'プラン内容が更新されたため支払いリンクを無効化しました。再読み込みしてください。'},409);}
     current=await getCustomPlan(db,uid);
     await writeSupporterAudit(db,admin.email,'custom_checkout',uid,{reason,requestId,revision:current.revision,price:current.confirmed_yen,expiresAt:session.expiresAt});
     return response({success:true,message:'このDiscord ID専用の月額支払いURL（24時間有効）を作成しました。',url:session.url,expiresAt:session.expiresAt,customPlan:customPublic(current)});
    }else if(input.action==='cancel'){
     const pending=await currentCustomChange(db,uid);
     if(pending){
      if(pending.status==='paid')return response({message:'入金済み変更の処理が残っています。先に精算してください。'},409);
      if(pending.checkout_session_id)await expireCustomCheckout(env,pending.checkout_session_id,`dpi-custom-change-stop-${pending.request_id}`);
      await db.prepare(`UPDATE supporter_custom_plan_changes SET status='canceled',updated_at=? WHERE request_id=? AND status='pending'`).bind(new Date().toISOString(),pending.request_id).run();
     }
     if(!current||current.status==='canceled')return response({message:'停止するカスタムプランはありません。'},409);
     if(current.stripe_checkout_id)await expireCustomCheckout(env,current.stripe_checkout_id,`dpi-custom-stop-checkout-${current.id}`);
     if(current.stripe_subscription_id)await cancelCustomSubscription(env,current.stripe_subscription_id,`dpi-custom-stop-sub-${current.id}`);
     await db.prepare(`UPDATE supporter_custom_plans SET status='canceled',updated_at=?,updated_by=?,reason=?,stripe_checkout_id=NULL,checkout_expires_at=NULL
      WHERE discord_user_id=? AND id=?`).bind(new Date().toISOString(),admin.email,reason,uid,current.id).run();
     current=await getCustomPlan(db,uid);
    }else return response({message:'カスタムプラン操作を確認してください。'},400);
    await writeSupporterAudit(db,admin.email,`custom_${input.action}`,uid,{reason,requestId,revision:current.revision,status:current.status,estimated:current.estimated_yen,confirmed:current.confirmed_yen});
    const task=refreshSupporterAccessSafely(env,db,'custom_plan_changed',uid);
    if(ctx?.waitUntil)ctx.waitUntil(task);else await task;
    return response({success:true,customPlan:customPublic(current),message:input.action==='cancel'?'カスタムプランを停止しました。':'カスタムプランを保存しました。'});
   }
   if (path === '/site/supporter-admin/api/action') {
    if (request.method !== 'POST') return response({message:'Method not allowed'},405);
    assertAdminOrigin(request);
    const input = await readJson(request);
    const uid = clean(input.discordUserId);
    if (!/^\d{17,20}$/.test(uid) || input.confirmDiscordUserId !== uid) return response({message:'対象Discord IDの確認入力が一致しません。'},400);
    const account = await db.prepare(`SELECT a.discord_user_id, a.billing_email, a.account_status, a.status_reason, a.status_updated_at, a.status_updated_by, a.status_request_id, b.customer_id
     FROM supporter_accounts a LEFT JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
     WHERE a.discord_user_id=?`).bind(uid).first();
    if (!account) return response({message:'対象の有料プラン登録者が見つかりません。'},404);
    if(account.account_status==='suspended'&&['grant_credit','create_payment_link','change_subscription'].includes(input.action))return response({message:'BAN中のアカウントには実行できません。先にBANを解除してください。'},409);
    if(input.action==='change_subscription'&&customLocked(await getCustomPlan(db,uid)))return response({message:'カスタムプランを提供中です。変更にはカスタムプラン設定をご利用ください。'},409);
    if (['disciplinary_cancel','ban_account','unban_account'].includes(input.action)) {
     const requestId=clean(input.requestId),reason=clean(input.reason),action=clean(input.action),now=Math.floor(Date.now()/1000);
     if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)return response({message:'操作理由を5〜500文字で入力してください。'},400);
     if(action==='ban_account'&&account.account_status==='suspended'&&account.status_request_id!==requestId)return response({message:'このアカウントは既にBANされています。'},409);
     if(action==='unban_account'&&account.account_status!=='suspended'&&account.status_request_id!==requestId)return response({message:'このアカウントはBANされていません。'},409);
     await db.prepare(`INSERT INTO supporter_disciplinary_actions
      (request_id,discord_user_id,action,reason,status,account_status_after,email_status,actor,created_at,updated_at)
      VALUES(?,?,?,?,? ,?,'pending',?,?,?) ON CONFLICT(request_id) DO NOTHING`)
      .bind(requestId,uid,action,reason,'processing',action==='ban_account'?'suspended':'active',admin.email,now,now).run();
     const operation=await db.prepare('SELECT * FROM supporter_disciplinary_actions WHERE request_id=?').bind(requestId).first();
     if(!operation||operation.discord_user_id!==uid||operation.action!==action)return response({message:'同じ処分IDが別の操作で使用されています。画面を開き直してください。'},409);
     const savedResult={canceledSubscriptions:Number(operation.canceled_subscriptions)||0,confiscatedCredits:Number(operation.confiscated_credits)||0};
     if(operation.status==='completed'){
      let emailStatus=operation.email_status;
      if(emailStatus==='failed')emailStatus=await sendDisciplinaryEmail(env,db,account,{...input,reason:operation.reason},savedResult);
      return response({success:true,message:disciplinaryResultMessage(action,savedResult.canceledSubscriptions,savedResult.confiscatedCredits),...savedResult,accountStatus:operation.account_status_after,emailStatus,auditRecorded:true,creditRecorded:true,idempotent:true});
     }
     let result={canceledSubscriptions:0,confiscatedCredits:0,creditEvent:null},creditRecorded=true,accountStatus=account.account_status||'active';
     try{
      if(action==='unban_account'){
       const statusResult=await changeSupporterAccountStatus(db,uid,admin,input);accountStatus=statusResult.accountStatus;
      }else{
       await expireSupporterPendingCheckouts(env,db,uid,requestId);
       result=await adminDisciplinaryBillingAction(env,account.customer_id,uid,input);
       if(result.creditEvent){
        try{
         await db.prepare(`INSERT INTO supporter_credit_events
          (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(`discipline:${requestId}`,uid,result.creditEvent.delta,result.creditEvent.balanceAfter,result.creditEvent.stripeTransactionId,reason,admin.email,new Date().toISOString()).run();
         await recordAdminCreditLot(db,uid,action,requestId,Math.abs(Number(result.creditEvent.delta)||0));
        }catch(error){creditRecorded=false;console.error('Paid plan disciplinary credit write failed',{requestId,errorName:error?.name||'Error'});}
       }
       if(action==='ban_account'){const statusResult=await changeSupporterAccountStatus(db,uid,admin,input);accountStatus=statusResult.accountStatus;}
      }
      const canceled=Number(result.canceledSubscriptions)||0,confiscated=Number(result.confiscatedCredits)||0,completedAt=Math.floor(Date.now()/1000);
      await db.prepare(`UPDATE supporter_disciplinary_actions SET status='completed',canceled_subscriptions=?,confiscated_credits=?,account_status_after=?,last_error=NULL,completed_at=?,updated_at=? WHERE request_id=?`)
       .bind(canceled,confiscated,accountStatus,completedAt,completedAt,requestId).run();
      const auditRecorded=await writeSupporterAudit(db,admin.email,action,uid,{reason,requestId,canceledSubscriptions:canceled,confiscatedCredits:confiscated,accountStatus,refund:false});
      const emailStatus=await sendDisciplinaryEmail(env,db,account,input,{canceledSubscriptions:canceled,confiscatedCredits:confiscated});
      const snapshotTask=refreshSupporterAccessSafely(env,db,'disciplinary_action',uid);
      if(ctx?.waitUntil)ctx.waitUntil(snapshotTask);else await snapshotTask;
      return response({success:true,message:disciplinaryResultMessage(action,canceled,confiscated),canceledSubscriptions:canceled,confiscatedCredits:confiscated,accountStatus,emailStatus,auditRecorded,creditRecorded,idempotent:false});
     }catch(error){
      await db.prepare(`UPDATE supporter_disciplinary_actions SET status='failed',last_error=?,updated_at=? WHERE request_id=? AND status<>'completed'`).bind(clean(error?.message||error?.name||'unknown').slice(0,500),Math.floor(Date.now()/1000),requestId).run();
      throw error;
     }
    }
    if (input.action === 'release_dispute_hold') {
     const reason = clean(input.reason);
     if (reason.length < 5 || reason.length > 500) return response({message:'操作理由を5〜500文字で入力してください。'},400);
     const released = account.customer_id ? await releaseDisputeHolds(env,db,account.customer_id) : 0;
     const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason,requestId:clean(input.requestId),released});
     if (released) { const task=refreshSupporterAccessSafely(env,db,'dispute_released',uid); if(ctx?.waitUntil)ctx.waitUntil(task);else await task; }
     return response({success:true,message:released?'支払異議による利用停止を解除しました。':'支払異議による利用停止はありませんでした。',auditRecorded});
    }
    if (input.action === 'reset_checkout_state') {
     const reason = clean(input.reason);
     if (reason.length < 5 || reason.length > 500) return response({message:'操作理由を5〜500文字で入力してください。'},400);
     const result = await recoverCheckoutState(env,db,uid);
     const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason,requestId:clean(input.requestId),changed:result.changed});
     return response({success:true,message:result.message,auditRecorded,creditRecorded:true});
    }
    if (!account.customer_id && ['grant_credit','create_payment_link'].includes(input.action)) {
     if (!account.billing_email) return response({message:'先にユーザーの申込メールアドレスを登録してください。'},409);
     const customer = await createBillingCustomer(env,uid,account.billing_email,`dpi-admin-customer-${uid}`);
     await db.prepare(`INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)
      ON CONFLICT(discord_user_id) DO UPDATE SET customer_id=COALESCE(supporter_billing.customer_id,excluded.customer_id)`).bind(uid,customer.id).run();
     account.customer_id = (await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first()).customer_id;
    }
    const result = await adminBillingAction(env,account.customer_id,uid,input);
    let creditRecorded = true;
    let creditDuplicate = false;
    if (result.creditEvent) {
     try {
       const recorded=await db.prepare(`INSERT INTO supporter_credit_events
       (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(clean(input.requestId),uid,result.creditEvent.delta,result.creditEvent.balanceAfter,result.creditEvent.stripeTransactionId,clean(input.reason),admin.email,new Date().toISOString()).run();
       creditDuplicate=!Number(recorded.meta?.changes||0);
       if(!creditDuplicate)await recordAdminCreditLot(db,uid,input.action,clean(input.requestId),Math.abs(Number(result.creditEvent.delta)||0));
     } catch (error) { console.error('Paid plan credit event write failed',{errorName:error?.name||'Error'}); creditRecorded = false; }
    }
    const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason:clean(input.reason),amount:Number(input.amount)||null,plan:clean(input.plan)||null,channelPacks:Number.isInteger(Number(input.channelPacks??input.packs))?Number(input.channelPacks??input.packs):null,serverPacks:Number.isInteger(Number(input.serverPacks))?Number(input.serverPacks):null,rulePacks:Number.isInteger(Number(input.rulePacks))?Number(input.rulePacks):null,requestId:clean(input.requestId),resultMessage:result.message});
    return response({success:true,...result,auditRecorded,creditRecorded,creditDuplicate});
   }
   if (request.method !== 'GET') return response({message:'Method not allowed'},405);
   if (path === '/site/supporter-admin/api/payments') {
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
    const limit = Number.isInteger(parsedLimit) ? Math.min(500,Math.max(1,parsedLimit)) : 200;
    return response(await supporterAdminPayments(db,env,limit));
   }
   if (path === '/site/supporter-admin/api/accounts') {
    const [rows,billingRows] = await Promise.all([db.prepare(`SELECT a.discord_user_id, a.billing_email, a.registered_at, a.updated_at,
     a.revision, a.settings_json, a.account_status, a.status_reason, a.status_updated_at, a.status_updated_by, b.customer_id,
     COALESCE(NULLIF(a.discord_name,''),
      (SELECT s.discord_username FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      (SELECT r.discord_username FROM reuse_applications r WHERE r.discord_user_id=a.discord_user_id ORDER BY r.updated_at DESC LIMIT 1),
      ''
     ) AS discord_name
     FROM supporter_accounts a
     LEFT JOIN supporter_billing b ON b.discord_user_id = a.discord_user_id
     ORDER BY a.updated_at DESC LIMIT 100`).all(),db.prepare(`SELECT discord_user_id,customer_id FROM supporter_billing WHERE customer_id IS NOT NULL`).all()]);
    const stripeEnabled = billingReady(env);
    let grouped = new Map();
    let creditBalances = new Map();
    let billingError = '';
    if (stripeEnabled) {
     const subscriptionCustomers=(rows.results||[]).map(row=>row.customer_id);
     const creditCustomers=(billingRows.results||[]).map(row=>row.customer_id);
     const [subscriptionResult,creditResult] = await Promise.allSettled([subscriptionSummariesByCustomer(env,subscriptionCustomers),creditsByCustomer(env,creditCustomers)]);
     if (subscriptionResult.status === 'fulfilled') grouped = subscriptionResult.value;
     else billingError = 'Stripeから契約情報を取得できませんでした。';
     if (creditResult.status === 'fulfilled') creditBalances = creditResult.value;
     else billingError = `${billingError}${billingError ? ' ' : ''}クレジット残高を取得できませんでした。`;
    }
    const [customRows,pendingRows]=await Promise.all([
     db.prepare('SELECT * FROM supporter_custom_plans').all(),
     db.prepare(`SELECT * FROM supporter_custom_plan_changes WHERE status IN ('pending','paid')`).all(),
    ]);
    const customByUid=new Map((customRows.results||[]).map(row=>[row.discord_user_id,row]));
    const pendingByUid=new Map((pendingRows.results||[]).map(row=>[row.discord_user_id,row]));
    const accounts = (rows.results||[]).map(row=>{const custom=customByUid.get(row.discord_user_id);return supporterAdminAccount(row,enrichCustomSubscriptions(grouped.get(row.customer_id)||[],custom),row.customer_id?billingError:'',creditBalances.get(row.customer_id)||0,custom,pendingByUid.get(row.discord_user_id));});
    let creditSummary=null,creditSummaryError='';
    try{creditSummary=await supporterCreditMetrics(db,billingRows.results||[],creditBalances,stripeEnabled&&!billingError.includes('クレジット残高'));}
    catch(error){console.error('Paid plan credit summary failed',{errorName:error?.name||'Error'});creditSummaryError='クレジット集計を取得できませんでした。';}
    let creditCampaigns=[];
    try{const result=await db.prepare('SELECT * FROM supporter_credit_campaigns ORDER BY created_at DESC LIMIT 20').all();creditCampaigns=(result.results||[]).map(compensationCampaignView);}
    catch(error){console.error('Paid plan credit campaigns failed',{errorName:error?.name||'Error'});}
    let paymentAlerts=[];
    try{const result=await db.prepare(`SELECT event_id,kind,outcome,discord_user_id,amount,created_at FROM supporter_payment_alerts WHERE kind<>'disciplinary_refund' ORDER BY created_at DESC LIMIT 30`).all();
     paymentAlerts=(result.results||[]).map(row=>({id:clean(row.event_id),kind:clean(row.kind),outcome:clean(row.outcome),discordUserId:clean(row.discord_user_id),amount:Number(row.amount)||0,createdAt:Number(row.created_at)||null}));}
    catch(error){console.error('Paid plan payment alerts failed',{errorName:error?.name||'Error'});}
    return response({billingMode:billingMode(env),paymentAlerts,billingEnabled:stripeEnabled,accounts,creditSummary,creditSummaryError,creditCampaigns});
   }
   const detailMatch=path.match(/^\/site\/supporter-admin\/api\/accounts\/(\d{17,20})$/);
   if(detailMatch){
    const uid=detailMatch[1];
    const row=await db.prepare(`SELECT a.discord_user_id, a.settings_json, a.account_status, a.status_reason, a.status_updated_at, a.status_updated_by,
     COALESCE(NULLIF(a.discord_name,''),
      (SELECT s.discord_username FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      (SELECT r.discord_username FROM reuse_applications r WHERE r.discord_user_id=a.discord_user_id ORDER BY r.updated_at DESC LIMIT 1),
      ''
     ) AS discord_name,
     COALESCE(
      (SELECT s.guilds_json FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      '[]'
     ) AS guilds_json
     FROM supporter_accounts a WHERE a.discord_user_id=?`).bind(uid).first();
    if(!row)return response({message:'対象の有料プラン登録者が見つかりません。'},404);
    let settings={};try{settings=JSON.parse(row.settings_json||'{}');}catch{/* Return an empty detail set for malformed legacy data. */}
    const guildIds=[...new Set((Array.isArray(settings.rules)?settings.rules:[]).map(rule=>clean(rule?.guildId)).filter(id=>/^\d{17,20}$/.test(id)))];
    const channelResults=await Promise.all(guildIds.map(async guildId=>{
     try{return{guildId,channels:await fetchGuildChannels(guildId,env),failed:false};}
     catch{return{guildId,channels:[],failed:true};}
    }));
    const channelsByGuild=Object.fromEntries(channelResults.map(result=>[result.guildId,result.channels]));
    return response({account:supporterAdminDetails(row,channelsByGuild),customPlan:customPublic(await getCustomPlan(db,uid)),channelLookupFailedGuildIds:channelResults.filter(result=>result.failed).map(result=>result.guildId)});
   }
   // 利用者側（非公開の間は 404）と同じ機能の定義を、管理者の認証を通るこの場所から読む。
   const shared = path === '/site/supporter-admin/plan-features.js' ? new Request(new URL('/site/supporter/plan-features.js', request.url), {headers: {Accept: 'text/javascript'}}) : request;
   const asset = await env.ASSETS.fetch(shared);
   const headers = new Headers(asset.headers);
   headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
   if ((headers.get('content-type')||'').includes('text/html')) headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
   return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
  }
  if (path === '/api/supporter/plans' && request.method === 'GET' && (supporterPublicEnabled(env) || supporterPreviewOpen(env))) {
   return response(supporterPlansResponse(env));
  }
  let session;
  try { session = await requireSession(request, {...env,REUSE_DB:db}); }
  catch (error) { if (!supporterPublicEnabled(env) && !supporterPreviewOpen(env)) return notFound(); throw error; }
  const uid = session.discord_user_id;
  if (!supporterTestUserAllowed(env, uid) && !(await reviewCookieValid(request, env))) return notFound();
  if (path === '/api/supporter/plans' && request.method === 'GET') {
   return response(supporterPlansResponse(env));
  }
  if (path === '/api/supporter/options' && request.method === 'GET') {
   return response(supporterOptions(env));
  }
  if (path === '/api/supporter/areas' && request.method === 'GET') {
   const areas=await loadSupporterAreaCatalogue();
   return response({municipalities:areas.municipalities,districts:areas.districts,source:areas.source});
  }
  if(path==='/api/supporter/custom-requests'||path.startsWith('/api/supporter/custom-requests/')){
   if(request.method!=='GET'){assertSameOrigin(request);assertCsrf(request,session);}
   return await handleSupporterCustomRequestApi(request,env,db,uid,{rateLimit:()=>assertSupporterRate(env,`custom-request:${uid}`)});
  }
  // 受付停止中でも、契約者の支払い方法の変更と解約（portal）は止めない。
  const pausedPortal = supporterIntakePaused(env) && path === '/api/supporter/billing/portal';
  if (request.method !== 'GET' && supporterIntakePaused(env) && !pausedPortal) return response({message:SUPPORTER_INTAKE_PAUSED_MESSAGE,intakePaused:true},503);
  if (request.method !== 'GET') { assertSameOrigin(request); assertCsrf(request,session); }
  if (/^\/api\/supporter\/billing\/(checkout|topup|preview-update|update|pay-unpaid|portal|status)$/.test(path)) {
   const expected=path.endsWith('/status')?'GET':'POST';
   if(request.method!==expected)return response({message:'Method not allowed'},405);
   const input=request.method==='POST'?await readJson(request):{};
   if(pausedPortal)input.existingOnly=true;
   if(path.endsWith('/checkout')||path.endsWith('/topup')||path.endsWith('/pay-unpaid'))await assertSupporterRate(env,`billing:${uid}`);
   if(path.endsWith('/checkout')||path.endsWith('/topup')){
    const currentAccount=await db.prepare('SELECT account_status,status_reason,status_updated_at FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
    if(currentAccount)assertSupporterAccountActive(currentAccount);
    const email=normalizeBillingEmail(input.email);
    const consentVersion=supporterConsentVersion(input,env);
    const discordName=clean(session.discord_username).slice(0,100);
    const now=new Date().toISOString();
    await db.prepare(`INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,legal_consent_version,legal_consent_at,registered_at,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(discord_user_id) DO UPDATE SET discord_name=excluded.discord_name,billing_email=excluded.billing_email,legal_consent_version=excluded.legal_consent_version,legal_consent_at=excluded.legal_consent_at,updated_at=excluded.updated_at`).bind(uid,discordName,email,consentVersion,now,now,now).run();
    input.email=email;
    input.legalConsentVersion=consentVersion;
   }
   return await billingAction(request,env,db,uid,input);
  }
  if (path === '/api/supporter/account' && request.method === 'GET') {
   const discordName=clean(session.discord_username).slice(0,100);
   if(discordName)await db.prepare('UPDATE supporter_accounts SET discord_name=? WHERE discord_user_id=? AND COALESCE(discord_name,\'\')<>?').bind(discordName,uid,discordName).run();
   const account = await db.prepare('SELECT * FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
   return response({account,customPlan:customPublic(await getCustomPlan(db,uid)),mode:billingMode(env),deliveryEnabled:supporterPublicEnabled(env)&&billingReady(env),billingEnabled:billingReady(env),intakePaused:supporterIntakePaused(env)});
  }
  if (path === '/api/supporter/account' && request.method === 'POST') {
   const input = await readJson(request);
   const email = normalizeBillingEmail(input.email);
   const discordName=clean(session.discord_username).slice(0,100);
   const now = new Date().toISOString();
   await db.prepare(`INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(discord_user_id) DO UPDATE SET discord_name=excluded.discord_name,billing_email=excluded.billing_email,updated_at=excluded.updated_at`).bind(uid,discordName,email,now,now).run();
   return response({success:true});
  }
  if (path === '/api/supporter/settings' && request.method === 'PUT') {
   // ルール追加パックやカスタムプラン（最大500ルール）では 32KB を超えるため、設定保存だけ上限を広げる。
   const input = await readJson(request, 1024 * 1024);
   if (!Number.isInteger(input.revision)) return response({message:'更新情報が正しくありません。再読み込みしてください。'},400);
   const guilds = JSON.parse(session.guilds_json);
   const limits = await supporterLimits(env,db,uid);
   const needsAreaCatalogue=Array.isArray(input.rules)&&input.rules.some(rule=>rule?.municipality&&rule.municipality!=='all'||rule?.district&&rule.district!=='all'||Array.isArray(rule?.municipalities)&&rule.municipalities.length>0);
   const catalogue=needsAreaCatalogue?await loadSupporterAreaCatalogue():{prefectures:PREFECTURES,municipalities:[],districts:[]};
   // earthquake-map centre municipalities are checked against the static list shipped with the site.
   const needsEarthquakeList=Array.isArray(input.rules)&&input.rules.some(rule=>clean(rule?.type)==='earthquake-map'&&clean(rule?.centerMunicipality)&&clean(rule.centerMunicipality)!=='all');
   if(needsEarthquakeList&&imageRulesEnabled(env))catalogue.earthquakeMunicipalities=await loadEarthquakeMunicipalities(env,request.url);
   const imageRules = imageRulesEnabled(env);
   const imageRulesV2 = imageRules && imageRulesV2Enabled(env);
   let storedImageRules = [];
   if (!imageRules || !imageRulesV2) {
    const stored = await db.prepare('SELECT settings_json FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
    try { storedImageRules = (JSON.parse(stored?.settings_json || '{}').rules || []).filter(rule => isImageRuleType(rule?.type)); } catch { storedImageRules = []; }
   }
   const rules = normalizeSupporterRules(input.rules, guilds, limits, catalogue, {imageRules, imageRulesV2, storedImageRules});
   await assertRuleChannels(rules, env);
   const result = await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(JSON.stringify({rules}),new Date().toISOString(),uid,input.revision).run();
   if (!result.meta.changes) return response({message:'未登録、または別画面で更新されています。再読み込みしてください。'},409);
   const snapshotTask=refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,'settings_saved');
   if(ctx?.waitUntil)ctx.waitUntil(snapshotTask);else await snapshotTask;
   return response({success:true,revision:input.revision+1});
  }
  return response({message:'この操作は利用できません。'},404);
 } catch(error) { return response({message:error.publicMessage || (error.status && error.status<500 ? error.message : '現在利用できません。')},error.status || 503); }
}
