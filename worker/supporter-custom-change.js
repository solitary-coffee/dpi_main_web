// Admin-managed custom plan price migration. No proration: exact current-month
// difference is collected via one-off Checkout; the recurring monthly price
// is changed only when that Checkout is confirmed paid by Stripe.
import {getCustomPlan,normalizeCustomPlan} from './supporter-custom.js';
export const CUSTOM_CHANGE_PENDING=new Set(['pending','paid']);
const die=(text,status=409)=>{throw Object.assign(new Error(text),{status});};
export function customChangeQuote(row,next){
 const plan=normalizeCustomPlan(next);
 const oldAmount=Number(row?.confirmed_yen);
 if(row?.status!=='active'||!Number.isInteger(oldAmount)||oldAmount<100)die('有効なカスタム契約を選択してください。');
 const delta=plan.monthlyYen-oldAmount;
 return {
  oldMonthlyYen:oldAmount,newMonthlyYen:plan.monthlyYen,
  differenceYen:delta,immediateDueYen:Math.max(0,delta),
  nextMonthlyYen:plan.monthlyYen,
  noImmediateRefund:delta<0,
  timing:delta>0?'after_payment':'immediate',
  billingDay:26,prorated:false,
  description:delta>0?'当月分の増額差額を決済確認後に適用。翌月以降は新月額で請求します。':
   delta<0?'当月の差額返金は行わず、次回以降は新月額で請求します。':
   '追加請求なし。利用条件を更新します。',
 };
}
export async function currentCustomChange(db,uid){
 return await db.prepare(`SELECT * FROM supporter_custom_plan_changes
   WHERE discord_user_id=? AND status IN ('pending','paid')
   ORDER BY created_at DESC LIMIT 1`).bind(uid).first();
}
export async function getCustomChange(db,requestId){
 return await db.prepare('SELECT * FROM supporter_custom_plan_changes WHERE request_id=?').bind(requestId).first();
}
export function customChangePublic(row){
 if(!row)return null;
 return {
  requestId:row.request_id,status:row.status,
  oldMonthlyYen:Number(row.old_monthly_yen),
  nextMonthlyYen:Number(row.next_monthly_yen),
  amountDueYen:Number(row.amount_due_yen),
  checkoutExpiresAt:row.checkout_expires_at?Number(row.checkout_expires_at):null,
  updatedAt:row.updated_at,reason:row.reason,
 };
}
export async function stageCustomChange(db,uid,customer,row,plan,actor,reason,requestId){
 const quote=customChangeQuote(row,plan),now=new Date().toISOString();
 const status=quote.immediateDueYen>0?'pending':'paid';
 await db.prepare(`INSERT INTO supporter_custom_plan_changes
  (request_id,discord_user_id,custom_plan_id,stripe_customer_id,stripe_subscription_id,
   old_revision,next_revision,old_monthly_yen,next_monthly_yen,amount_due_yen,
   next_plan_json,status,actor,reason,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(requestId,uid,row.id,customer,row.stripe_subscription_id,
   Number(row.revision),Number(row.revision)+1,quote.oldMonthlyYen,quote.newMonthlyYen,
   quote.immediateDueYen,JSON.stringify(normalizeCustomPlan(plan)),status,actor,reason,now,now).run();
 return getCustomChange(db,requestId);
}
export async function commitCustomChange(db,change){
 const plan=normalizeCustomPlan(JSON.parse(change.next_plan_json)),now=new Date().toISOString();
 const result=await db.prepare(`UPDATE supporter_custom_plans SET
   name=?,channel_limit=?,server_limit=?,rule_limit=?,complex_conditions=?,
   municipality_branching=?,content_extraction=?,multi_destination=?,secondary_reuse=?,
   estimated_yen=?,confirmed_yen=?,reason=?,updated_by=?,updated_at=?,revision=?,features_json=?
   WHERE discord_user_id=? AND id=? AND status='active' AND revision=? AND confirmed_yen=? AND stripe_subscription_id=?`)
   .bind(plan.name,plan.channels,plan.servers,plan.rules,Number(plan.complexConditions),
    Number(plan.municipalityBranching),Number(plan.contentExtraction),Number(plan.multiDestination),
    Number(plan.secondaryReuse),plan.estimatedYen,plan.monthlyYen,change.reason,change.actor,now,
    change.next_revision,JSON.stringify(plan.features),change.discord_user_id,change.custom_plan_id,change.old_revision,
    change.old_monthly_yen,change.stripe_subscription_id).run();
 if(!Number(result.meta?.changes)){
  const current=await getCustomPlan(db,change.discord_user_id);
  if(current?.revision!==change.next_revision||Number(current.confirmed_yen)!==Number(change.next_monthly_yen))
   die('契約データが変更されたため反映を保留しました。運営による再確認が必要です。');
 }
 await db.prepare(`UPDATE supporter_custom_plan_changes SET status='applied',applied_at=?,
  updated_at=?,last_error=NULL WHERE request_id=? AND status='paid'`)
  .bind(now,now,change.request_id).run();
 return getCustomPlan(db,change.discord_user_id);
}
