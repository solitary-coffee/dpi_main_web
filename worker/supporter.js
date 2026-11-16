import { requireSession, assertCsrf, assertSameOrigin, readJson, fetchGuildChannels } from './reuse.js';
import { authenticateNewsletterAdmin } from './access.js';
import { adminBillingAction, adminDisciplinaryBillingAction, billingAction, billingReady, createBillingCustomer, creditsByCustomer, customerSubscriptionSummaries, expireSupporterPendingCheckouts, publicPlans, reconcilePaidCheckoutSubscription, sendSupporterDisciplinaryNotification, subscriptionSummariesByCustomer } from './supporter-billing.js';
import { refreshSupporterSnapshotSafely } from './supporter-snapshot.js';
import { PREFECTURES, loadSupporterAreaCatalogue, geographicEntitlements, normalizeGeographicRule } from './supporter-geo.js';

const response = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
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
export function supporterAdminAccount(row, subscriptions = [], billingError = '', credits = 0) {
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
 if(stripeAvailable){
  for(const [uid,userLots] of grouped){
   let tracked=userLots.reduce((sum,lot)=>sum+Math.max(0,Number(lot.remaining_amount)||0),0);
   let consumed=Math.max(0,tracked-(balancesByUser.get(uid)||0));
   for(const lot of userLots){
    if(consumed<=0)break;
    const current=Math.max(0,Number(lot.remaining_amount)||0),used=Math.min(current,consumed),remaining=current-used;
    const result=await db.prepare(`UPDATE supporter_credit_lots SET remaining_amount=?,status=?,updated_at=?
     WHERE id=? AND remaining_amount=? AND status='active'`).bind(remaining,remaining?'active':'consumed',now,lot.id,current).run();
    if(result.meta?.changes)consumed-=used;
   }
  }
 }
 const [active,topups,expired]=await Promise.all([
  db.prepare(`SELECT COALESCE(SUM(remaining_amount),0) AS balance,COUNT(DISTINCT discord_user_id) AS users,
   MIN(expires_at) AS next_expiry,COALESCE(SUM(CASE WHEN expires_at<=? THEN remaining_amount ELSE 0 END),0) AS expiring_30d
   FROM supporter_credit_lots WHERE source_type='purchase' AND status='active' AND remaining_amount>0`).bind(now+30*86400).first(),
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
  WHERE b.customer_id IS NOT NULL OR COALESCE(a.billing_email,'')<>''
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
 if(existing)return compensationCampaignView(existing);
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

async function processCompensationCampaign(env,db,admin,campaignId,limit=10){
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
   const result=await adminBillingAction(env,customerId,recipient.discord_user_id,{action:'grant_credit',amount:Number(campaign.amount),reason:campaign.reason,requestId:recipient.request_id});
   const credit=result.creditEvent,now=Math.floor(Date.now()/1000);
   await db.batch([
    db.prepare(`INSERT INTO supporter_credit_events
     (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(recipient.request_id,recipient.discord_user_id,credit.delta,credit.balanceAfter,credit.stripeTransactionId,campaign.reason,admin.email,new Date(now*1000).toISOString()),
    db.prepare(`INSERT INTO supporter_credit_lots
     (id,discord_user_id,source_type,source_id,original_amount,remaining_amount,expires_at,status,created_at,updated_at)
     VALUES(?,?,'admin',?,?,?,?, 'active',?,?) ON CONFLICT(source_type,source_id) DO NOTHING`).bind(recipient.lot_id,recipient.discord_user_id,recipient.lot_id,Number(campaign.amount),Number(campaign.amount),Number(campaign.expires_at),now,now),
    db.prepare(`UPDATE supporter_credit_campaign_recipients SET status='credited',stripe_transaction_id=?,balance_after=?,credited_at=?,error_message=NULL
     WHERE campaign_id=? AND discord_user_id=? AND status='pending'`).bind(credit.stripeTransactionId,credit.balanceAfter,now,campaignId,recipient.discord_user_id),
   ]);
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
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);
const SUPPORTER_TYPE_LABELS = Object.freeze({earthquake:'地震情報',eew:'緊急地震速報',weather:'気象情報','rain-radar':'雨雲レーダー'});
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
    {label:'詳細種別',value:type==='rain-radar'?'雨雲レーダー':optionLabel(type==='earthquake'?EARTHQUAKE_DETAILS:type==='eew'?EEW_DETAILS:WEATHER_DETAILS,clean(rule?.detail)||'all')},
    {label:'対象地方',value:optionLabel(SUPPORTER_REGIONS,clean(rule?.region)||'all')},
    {label:'都道府県',value:PREFECTURES.find(row=>row.code===clean(rule?.prefecture))?.name||'全域'},
    {label:'北海道内の地方',value:clean(rule?.district)==='all'||!rule?.district?'全域':clean(rule?.district)},
    {label:'市区町村（気象庁コード）',value:clean(rule?.municipality)==='all'||!rule?.municipality?'全域':clean(rule?.municipality)},
    {label:'指定市区町村のみ表示',value:rule?.strictMunicipality===true?'有効（Pro）':'通常表示'},
    {label:'条件の組み合わせ',value:clean(rule?.conditionLogic)==='or'?'いずれかを満たす（OR）':'すべて満たす（AND）'},
   ];
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
  if(kind==='rainfallThreshold'&&type==='rain-radar'){const rainfall=optionalRainfallThreshold(raw);if(rainfall!==null)return{kind,operator:'at_least',value:rainfall};}
  throw Object.assign(new Error('追加条件の種類または値を確認してください。'),{status:400});
 });
 const unique=[];const seen=new Set();
 for(const condition of normalized){const key=`${condition.kind}:${condition.value}`;if(!seen.has(key)){seen.add(key);unique.push(condition);}}
 return unique;
}

export function normalizeSupporterRules(input, guilds, limits = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}, catalogue = null) {
 const ruleLimit=Math.max(1,Number(limits.rules)||5);
 if (!Array.isArray(input) || input.length > ruleLimit) throw Object.assign(new Error(`通知ルールは${ruleLimit}件までです。`),{status:400});
 const rules = input.map(rule => {
  const name = clean(rule?.name);
  const guildId = clean(rule?.guildId);
  const requestedChannelIds=Array.isArray(rule?.channelIds)?rule.channelIds.map(clean).filter(Boolean):[];
  const channelIds=[...new Set(requestedChannelIds.length?requestedChannelIds:[clean(rule?.channelId)])];
  const channelId=channelIds[0]||'';
  const type = clean(rule?.type);
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
  return {name,guildId,channelId,channelIds,type,detail,region,...geographic,conditionLogic,conditions,intensityMode,intensity,magnitudeMode,magnitudeMin,weatherLevel:'',warningLevel:'',eewWarningAreaMode,radarCondition:'',rainfallThresholdMmPerHour:null,deliveryIntervalHours:null};
 });
 const serverCount = new Set(rules.map(rule => rule.guildId)).size;
 const channelCount = new Set(rules.flatMap(rule => rule.channelIds.map(channelId=>`${rule.guildId}:${channelId}`))).size;
 const serverLimit = Math.max(1,Number(limits.servers)||1);
 const channelLimit = Math.max(1,Number(limits.channels)||2);
 if (serverCount > serverLimit) throw Object.assign(new Error(`契約上限は${serverLimit}サーバーです。サーバー追加オプションを契約するか、同じサーバーを選択してください。`),{status:400});
 if (channelCount > channelLimit) throw Object.assign(new Error(`契約上限は${channelLimit}チャンネルです。チャンネル追加オプションを契約するか、通知先を減らしてください。`),{status:400});
 return rules;
}

async function supporterLimits(env, db, uid) {
 const fallback = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
 if (!billingReady(env)) throw Object.assign(new Error('決済設定を確認できないため、通知設定を保存できません。'),{status:503});
 const account=await db.prepare('SELECT account_status,status_reason,status_updated_at FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 assertSupporterAccountActive(account);
 const row = await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if (!row?.customer_id) throw Object.assign(new Error('通知設定は有料プランの契約後に利用できます。'),{status:409});
 try {
  const suspension = await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE customer_id=? AND status='suspended' LIMIT 1`).bind(row.customer_id).first();
  if (suspension) throw Object.assign(new Error('月末再決済を確認できなかったため、有料プランの通知設定は利用停止中です。契約管理画面からお支払いを完了してください。'),{status:409});
  await reconcilePaidCheckoutSubscription(env,row.customer_id,uid);
  const active = (await customerSubscriptionSummaries(env,row.customer_id)).filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
  if (!active.length) throw Object.assign(new Error('通知設定は有効な契約を確認してから利用できます。'),{status:409});
  return {...active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),fallback),...geographicEntitlements(active)};
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
export function supporterTestUserAllowed(env, discordUserId) {
 if (supporterPublicEnabled(env)) return true;
 const allowed = new Set(clean(env.SUPPORTER_TEST_USER_IDS)
  .split(',')
  .map(value => value.trim())
  .filter(value => /^\d{17,20}$/.test(value)));
 return allowed.has(String(discordUserId || ''));
}

async function supporterSite(request, env, db) {
 const method = request.method.toUpperCase();
 if (!['GET', 'HEAD'].includes(method)) return notFound();
 if (!supporterPublicEnabled(env)) {
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
  if (!allowed) return notFound();
 }
 const asset = await env.ASSETS.fetch(request);
 const headers = new Headers(asset.headers);
 headers.set('Cache-Control', 'private, no-store');
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
      const snapshotTask=refreshSupporterSnapshotSafely(env,db,subscriptionSummariesByCustomer,'disciplinary_action');
      if(ctx?.waitUntil)ctx.waitUntil(snapshotTask);else await snapshotTask;
      return response({success:true,message:disciplinaryResultMessage(action,canceled,confiscated),canceledSubscriptions:canceled,confiscatedCredits:confiscated,accountStatus,emailStatus,auditRecorded,creditRecorded,idempotent:false});
     }catch(error){
      await db.prepare(`UPDATE supporter_disciplinary_actions SET status='failed',last_error=?,updated_at=? WHERE request_id=? AND status<>'completed'`).bind(clean(error?.message||error?.name||'unknown').slice(0,500),Math.floor(Date.now()/1000),requestId).run();
      throw error;
     }
    }
    if (input.action === 'reset_checkout_state') {
     if (env.SUPPORTER_BILLING_MODE !== 'test') return response({message:'この操作はStripeテスト環境でのみ利用できます。'},403);
     const reason = clean(input.reason);
     if (reason.length < 5 || reason.length > 500) return response({message:'操作理由を5〜500文字で入力してください。'},400);
     const result = await db.prepare(`UPDATE supporter_billing
      SET checkout_key=NULL, checkout_id=NULL, checkout_params=NULL
      WHERE discord_user_id=?
       AND (checkout_key IS NOT NULL OR checkout_id IS NOT NULL OR checkout_params IS NOT NULL)`).bind(uid).run();
     const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason,requestId:clean(input.requestId),changed:Number(result.meta?.changes||0)});
     return response({success:true,message:result.meta?.changes?'決済途中データをDBから削除しました。Stripe Customerと契約情報は保持されています。':'削除対象の決済途中データはありませんでした。',auditRecorded,creditRecorded:true});
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
    if (result.creditEvent) {
     try {
      await db.prepare(`INSERT INTO supporter_credit_events
       (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
       VALUES(?,?,?,?,?,?,?,?)`).bind(clean(input.requestId),uid,result.creditEvent.delta,result.creditEvent.balanceAfter,result.creditEvent.stripeTransactionId,clean(input.reason),admin.email,new Date().toISOString()).run();
      await recordAdminCreditLot(db,uid,input.action,clean(input.requestId),Math.abs(Number(result.creditEvent.delta)||0));
     } catch (error) { console.error('Paid plan credit event write failed',{errorName:error?.name||'Error'}); creditRecorded = false; }
    }
    const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason:clean(input.reason),amount:Number(input.amount)||null,plan:clean(input.plan)||null,channelPacks:Number.isInteger(Number(input.channelPacks??input.packs))?Number(input.channelPacks??input.packs):null,serverPacks:Number.isInteger(Number(input.serverPacks))?Number(input.serverPacks):null,requestId:clean(input.requestId),resultMessage:result.message});
    return response({success:true,...result,auditRecorded,creditRecorded});
   }
   if (request.method !== 'GET') return response({message:'Method not allowed'},405);
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
    const accounts = (rows.results||[]).map(row=>supporterAdminAccount(row,grouped.get(row.customer_id)||[],row.customer_id?billingError:'',creditBalances.get(row.customer_id)||0));
    let creditSummary=null,creditSummaryError='';
    try{creditSummary=await supporterCreditMetrics(db,billingRows.results||[],creditBalances,stripeEnabled&&!billingError.includes('クレジット残高'));}
    catch(error){console.error('Paid plan credit summary failed',{errorName:error?.name||'Error'});creditSummaryError='クレジット集計を取得できませんでした。';}
    let creditCampaigns=[];
    try{const result=await db.prepare('SELECT * FROM supporter_credit_campaigns ORDER BY created_at DESC LIMIT 20').all();creditCampaigns=(result.results||[]).map(compensationCampaignView);}
    catch(error){console.error('Paid plan credit campaigns failed',{errorName:error?.name||'Error'});}
    return response({billingEnabled:stripeEnabled,accounts,creditSummary,creditSummaryError,creditCampaigns});
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
    return response({account:supporterAdminDetails(row,channelsByGuild),channelLookupFailedGuildIds:channelResults.filter(result=>result.failed).map(result=>result.guildId)});
   }
   const asset = await env.ASSETS.fetch(request);
   const headers = new Headers(asset.headers);
   headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
   if ((headers.get('content-type')||'').includes('text/html')) headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
   return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
  }
  if (path === '/api/supporter/plans' && request.method === 'GET' && supporterPublicEnabled(env)) {
   return response({billingEnabled:false, deliveryEnabled:false, plans:publicPlans(), addons:{channel:{yen:200,channels:3},server:{yen:200,servers:1},prorated:false},billingDay:26});
  }
  let session;
  try { session = await requireSession(request, {...env,REUSE_DB:db}); }
  catch (error) { if (!supporterPublicEnabled(env)) return notFound(); throw error; }
  const uid = session.discord_user_id;
  if (!supporterTestUserAllowed(env, uid)) return notFound();
  if (path === '/api/supporter/plans' && request.method === 'GET') {
   return response({billingEnabled:false, deliveryEnabled:false, plans:publicPlans(), addons:{channel:{yen:200,channels:3},server:{yen:200,servers:1},prorated:false},billingDay:26});
  }
  if (path === '/api/supporter/options' && request.method === 'GET') {
   return response({regions:SUPPORTER_REGIONS,prefectures:PREFECTURES,weatherLevels:WEATHER_LEVELS,warningLevels:WARNING_LEVELS,earthquakeDetails:EARTHQUAKE_DETAILS,eewDetails:EEW_DETAILS,eewWarningAreaModes:EEW_WARNING_AREA_MODES,weatherDetails:WEATHER_DETAILS,thresholdModes:THRESHOLD_MODES,rainRadarConditions:RAIN_RADAR_CONDITIONS,rainRadarIntervals:RAIN_RADAR_INTERVALS});
  }
  if (path === '/api/supporter/areas' && request.method === 'GET') {
   const areas=await loadSupporterAreaCatalogue();
   return response({municipalities:areas.municipalities,districts:areas.districts,source:areas.source});
  }
  if (request.method !== 'GET') { assertSameOrigin(request); assertCsrf(request,session); }
  if (/^\/api\/supporter\/billing\/(checkout|topup|preview-update|update|portal|status)$/.test(path)) {
   const expected=path.endsWith('/status')?'GET':'POST';
   if(request.method!==expected)return response({message:'Method not allowed'},405);
   const input=request.method==='POST'?await readJson(request):{};
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
   return response({account,deliveryEnabled:false,billingEnabled:billingReady(env)});
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
   const input = await readJson(request);
   if (!Number.isInteger(input.revision)) return response({message:'更新情報が正しくありません。再読み込みしてください。'},400);
   const guilds = JSON.parse(session.guilds_json);
   const limits = await supporterLimits(env,db,uid);
   const needsAreaCatalogue=Array.isArray(input.rules)&&input.rules.some(rule=>rule?.municipality&&rule.municipality!=='all'||rule?.district&&rule.district!=='all');
   const catalogue=needsAreaCatalogue?await loadSupporterAreaCatalogue():{prefectures:PREFECTURES,municipalities:[],districts:[]};
   const rules = normalizeSupporterRules(input.rules, guilds, limits, catalogue);
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
