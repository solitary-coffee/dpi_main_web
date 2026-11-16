// Admin-issued per-user contract; real delivery rights require a matching,
// paid and currently active Stripe subscription, never the D1 offer alone.
export const CUSTOM_LOCKED_STATUSES=new Set(['offered','active']);
const ACTIVE=new Set(['active','trialing']); // past_due/unpaid never grant new custom access
const message=(text,status=400)=>{throw Object.assign(new Error(text),{status});};
const bool=value=>value===true||value===1;
export function estimateCustomMonthly(input){
 const channels=Number(input.channels),servers=Number(input.servers),rules=Number(input.rules);
 if(![channels,servers,rules].every(v=>Number.isInteger(v)&&v>=1))return 0;
 const complexity=bool(input.complexConditions),city=bool(input.municipalityBranching),extract=bool(input.contentExtraction);
 const base=complexity||extract?1280:city||channels>2||servers>1||rules>5?800:300;
 const defaults=base===1280?[20,5,30]:base===800?[10,3,15]:[2,1,5];
 const beyond=Math.ceil(Math.max(0,channels-defaults[0])/3)*200
  +Math.max(0,servers-defaults[1])*200+Math.ceil(Math.max(0,rules-defaults[2])/5)*100;
 return base+beyond+(bool(input.secondaryReuse)?200:0);
}
export function normalizeCustomPlan(input){
 const number=(name,max)=>{const value=Number(input[name]);if(!Number.isInteger(value)||value<1||value>max)message(`${name}の上限値を確認してください。`);return value;};
 const result={
  name:String(input.name||'カスタムプラン').trim(),
  channels:number('channels',200),servers:number('servers',50),rules:number('rules',500),
  complexConditions:input.complexConditions===true,
  municipalityBranching:input.municipalityBranching===true,
  contentExtraction:input.contentExtraction===true,
  multiDestination:input.multiDestination===true,
  secondaryReuse:input.secondaryReuse===true,
  monthlyYen:number('monthlyYen',1000000),
 };
 if(result.monthlyYen<100)message('確定料金は月額100円以上で指定してください。');
 if(!result.name||result.name.length>80)message('カスタムプラン名は1〜80文字にしてください。');
 if(result.contentExtraction&&!result.municipalityBranching)message('配信抽出には市区町村分岐を有効にしてください。');
 result.estimatedYen=estimateCustomMonthly(result);
 return result;
}
export const customLocked=row=>CUSTOM_LOCKED_STATUSES.has(row?.status);
export async function getCustomPlan(db,uid){
 if(!uid)return null;
 return await db.prepare('SELECT * FROM supporter_custom_plans WHERE discord_user_id=?').bind(uid).first();
}
export function customPublic(row){
 if(!row)return null;
 return {
  id:row.id,name:row.name,status:row.status,revision:Number(row.revision),
  channels:Number(row.channel_limit),servers:Number(row.server_limit),rules:Number(row.rule_limit),
  complexConditions:bool(row.complex_conditions),municipalityBranching:bool(row.municipality_branching),
  contentExtraction:bool(row.content_extraction),multiDestination:bool(row.multi_destination),
  secondaryReuse:bool(row.secondary_reuse),estimatedYen:Number(row.estimated_yen),
  monthlyYen:Number(row.confirmed_yen),updatedAt:row.updated_at,activatedAt:row.activated_at,
  // A managed monthly contract does not expose a user-controlled price or update action.
  locked:customLocked(row),
 };
}
export function customSubscriptionMatches(row,summary){
 return row?.status==='active'&&summary?.customId===row.id&&Number(summary.customRevision)===Number(row.revision)
  &&summary?.subscriptionId===row.stripe_subscription_id&&ACTIVE.has(summary.status)
  &&Number(summary.amount)===Number(row.confirmed_yen)&&summary.currency==='jpy';
}
export function enrichCustomSubscriptions(summaries,row){
 if(!row||row.status!=='active')return summaries;
 return summaries.map(item=>customSubscriptionMatches(row,item)?{
  ...item,planId:'custom',plan:row.name||'カスタムプラン',recognizedPlan:true,
  channels:Number(row.channel_limit),servers:Number(row.server_limit),rules:Number(row.rule_limit),
  complexConditions:bool(row.complex_conditions),multiDestination:bool(row.multi_destination),
  prefecture:bool(row.municipality_branching),municipality:bool(row.municipality_branching),
  strictMunicipality:bool(row.content_extraction),
  municipalityBranching:bool(row.municipality_branching),
  contentExtraction:bool(row.content_extraction),secondaryReuse:bool(row.secondary_reuse),
  managedCustom:true
 }:item);
}
export async function syncCustomWithStripe(db,uid,customer,summaries){
 const row=await getCustomPlan(db,uid);
 if(!row||!customer||!['offered','active'].includes(row.status))return row;
 const match=summaries.find(item=>item.customId===row.id&&Number(item.customRevision)===Number(row.revision)
  &&ACTIVE.has(item.status)&&Number(item.amount)===Number(row.confirmed_yen)
  &&item.currency==='jpy'&&item.subscriptionId);
 if(row.status==='offered'&&match){
  // Only the Stripe API response is authoritative. The user must have paid.
  await db.prepare(`UPDATE supporter_custom_plans SET status='active',stripe_subscription_id=?,
   activated_at=?,updated_at=? WHERE discord_user_id=? AND id=? AND revision=? AND status='offered'`)
   .bind(match.subscriptionId,new Date().toISOString(),new Date().toISOString(),uid,row.id,row.revision).run();
  return getCustomPlan(db,uid);
 }
 if(row.status==='active'&&!summaries.some(item=>customSubscriptionMatches(row,item))){
  // A canceled or changed Stripe subscription must not leave a privileged route.
  await db.prepare(`UPDATE supporter_custom_plans SET status='canceled',updated_at=?
   WHERE discord_user_id=? AND status='active' AND stripe_subscription_id=?`)
   .bind(new Date().toISOString(),uid,row.stripe_subscription_id).run();
  return getCustomPlan(db,uid);
 }
 return row;
}
export async function enrichCustomGroup(db,rows,grouped){
 const active=(await db.prepare("SELECT * FROM supporter_custom_plans WHERE status='active'").all()).results||[];
 const byUid=new Map(active.map(row=>[row.discord_user_id,row]));
 for(const account of rows){
  const row=byUid.get(account.discord_user_id);
  if(!row)continue;
  grouped.set(account.customer_id,enrichCustomSubscriptions(grouped.get(account.customer_id)||[],row));
 }
 return grouped;
}
