import {FEATURE_DEFINITIONS, missingFeatureDependency} from '../site/supporter/plan-features.js';
import {queueNotice} from './supporter-ops-notice.js';
import {readJson} from './reuse.js';
import {customPublic,getCustomPlan} from './supporter-custom.js';

// 準備中の画像配信。公開済み機能と同じキー空間で要望・回答を扱う。
export const CUSTOM_PLANNED_ITEMS = Object.freeze([
 {name:'estimatedIntensity',label:'推計震度分布'},
 {name:'typhoon',label:'台風の進路予想図'},
 {name:'rainDisaster',label:'土砂災害警戒情報・記録的短時間大雨情報の図'},
 {name:'volcano',label:'火山（噴火警報・噴火速報・降灰予報）の図'},
 {name:'rainForecast',label:'今後の雨（15時間先までの予想）'},
 {name:'himawari',label:'気象衛星（ひまわり）'},
 {name:'weatherDistribution',label:'天気分布予報'},
 {name:'amedas',label:'アメダスの分布図'},
].map(item=>Object.freeze(item)));

export const CUSTOM_REQUEST_STATUSES = Object.freeze(['submitted','estimating','answered','accepted','consulting','objected','withdrawn','closed']);
const STATUS_SET = new Set(CUSTOM_REQUEST_STATUSES);
const FEATURE_NAMES = Object.freeze(FEATURE_DEFINITIONS.map(item=>item.name));
const FEATURE_SET = new Set(FEATURE_NAMES);
const ITEM_NAMES = Object.freeze([...FEATURE_NAMES,...CUSTOM_PLANNED_ITEMS.map(item=>item.name)]);
const ITEM_SET = new Set(ITEM_NAMES);
const USER_DECISION_OPEN = new Set(['submitted','estimating','answered']);
const ADMIN_ANSWER_OPEN = new Set(['submitted','estimating']);

export class CustomRequestError extends Error {
 constructor(status,message){super(message);this.status=status;this.publicMessage=message;}
}
const fail=(message,status=400)=>{throw new CustomRequestError(status,message);};
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const chars=value=>[...value].length;
const textField=(input,name,max)=>{
 const value=input[name]===undefined?'':input[name];
 if(typeof value!=='string'||chars(value)>max)fail(`${name}は${max}文字以内で入力してください。`);
 return value.trim();
};
// 連絡用のメールアドレス（必須）。形だけを確かめ、小文字にそろえる
const emailField=input=>{
 const value=input.email;
 if(typeof value!=='string'||chars(value.trim())>254||!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(value.trim()))fail('連絡用のメールアドレスを正しく入力してください。');
 return value.trim().toLowerCase();
};
const countField=(input,name)=>{
 const value=input[name]===undefined?null:input[name];
 if(value===null)return null;
 if(!Number.isInteger(value)||value<0||value>100)fail(`${name}は0〜100の整数またはnullで指定してください。`);
 return value;
};
function exactKeys(input,allowed,label){
 if(!isObject(input))fail(`${label}の形式が正しくありません。`);
 const unknown=Object.keys(input).find(name=>!allowed.includes(name));
 if(unknown)fail(`${label}に不明な項目があります: ${unknown}`);
}
function itemMap(value,name,values,maxLength=0){
 if(value===undefined)return {};
 if(!isObject(value))fail(`${name}の形式が正しくありません。`);
 const result={};
 for(const [key,item] of Object.entries(value)){
  if(!ITEM_SET.has(key))fail(`${name}に不明な機能があります: ${key}`);
  if(maxLength){
   if(typeof item!=='string'||chars(item)>maxLength)fail(`${name}.${key}は${maxLength}文字以内で入力してください。`);
   result[key]=item.trim();
  }else{
   if(!values.includes(item))fail(`${name}.${key}の値が正しくありません。`);
   result[key]=item;
  }
 }
 return result;
}

export function normalizeCustomRequest(input){
 exactKeys(input,['email','contact','budget','servers','channels','rules','wants','wantNotes','request'],'request');
 return {
  email:emailField(input),contact:textField(input,'contact',200),budget:textField(input,'budget',100),
  servers:countField(input,'servers'),channels:countField(input,'channels'),rules:countField(input,'rules'),
  wants:itemMap(input.wants,'wants',['yes','maybe','no']),
  wantNotes:itemMap(input.wantNotes,'wantNotes',[],80),
  request:textField(input,'request',2000),
 };
}

export function normalizeCustomAnswer(input){
 exactKeys(input,['estimator','amount','memo','servers','channels','rules','marks','notes'],'answer');
 const answer={
  estimator:textField(input,'estimator',50),amount:textField(input,'amount',100),memo:textField(input,'memo',2000),
  servers:countField(input,'servers'),channels:countField(input,'channels'),rules:countField(input,'rules'),
  marks:itemMap(input.marks,'marks',['yes','partial','no']),
  notes:itemMap(input.notes,'notes',[],120),
 };
 const enabled=FEATURE_NAMES.filter(name=>answer.marks[name]==='yes'||answer.marks[name]==='partial');
 const missing=missingFeatureDependency(enabled);
 if(missing)fail(`${missing.name}の依存機能が回答に含まれていません。`);
 return answer;
}

export function customRequestsEnabled(env){
 return String(env?.SUPPORTER_CUSTOM_REQUESTS_ENABLED||'').trim().toLowerCase()==='true';
}
const parseJson=value=>{try{return JSON.parse(value||'null');}catch{return null;}};
export function customRequestPublic(row,{admin=false}={}){
 const item={
  id:row.id,status:row.status,request:parseJson(row.request_json),answer:parseJson(row.answer_json),
  createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),answeredAt:row.answered_at===null?null:Number(row.answered_at),
  decidedAt:row.decided_at===null?null:Number(row.decided_at),decisionMessage:row.decision_message||'',revision:Number(row.revision),
 };
 if(admin){item.discordUserId=row.discord_user_id;item.discordName=row.discord_name||'';}
 return item;
}

async function ownRow(db,id,uid){
 return await db.prepare('SELECT * FROM supporter_custom_requests WHERE id=? AND discord_user_id=?').bind(id,uid).first();
}
async function requireOwnRow(db,id,uid){
 const row=await ownRow(db,id,uid);
 if(!row)fail('ご要望が見つかりません。',404);
 return row;
}
async function requireAdminRow(db,id){
 const row=await db.prepare(`SELECT r.*,COALESCE(a.discord_name,'') AS discord_name FROM supporter_custom_requests r LEFT JOIN supporter_accounts a ON a.discord_user_id=r.discord_user_id WHERE r.id=?`).bind(id).first();
 if(!row)fail('ご要望が見つかりません。',404);
 return row;
}
const changed=result=>Number(result?.meta?.changes||0)>0;
const nowSeconds=()=>Math.floor(Date.now()/1000);

export async function listCustomRequestsForUser(db,uid){
 const rows=await db.prepare('SELECT * FROM supporter_custom_requests WHERE discord_user_id=? ORDER BY created_at DESC,id DESC').bind(uid).all();
 return (rows.results||[]).map(row=>customRequestPublic(row));
}

export async function createCustomRequest(db,uid,input,{now=nowSeconds(),id=crypto.randomUUID()}={}){
 const value=normalizeCustomRequest(input);
 const result=await db.prepare(`INSERT INTO supporter_custom_requests
  (id,discord_user_id,status,request_json,answer_json,created_at,updated_at,answered_at,decided_at,revision)
  SELECT ?,?,'submitted',?,NULL,?,?,NULL,NULL,0
  WHERE NOT EXISTS(SELECT 1 FROM supporter_custom_requests WHERE discord_user_id=? AND status IN ('submitted','estimating','answered'))
   AND (SELECT COUNT(*) FROM supporter_custom_requests WHERE discord_user_id=? AND created_at>=?)<3`)
  .bind(id,uid,JSON.stringify(value),now,now,uid,uid,now-86400).run();
 if(!changed(result)){
  const active=await db.prepare("SELECT 1 AS found FROM supporter_custom_requests WHERE discord_user_id=? AND status IN ('submitted','estimating','answered') LIMIT 1").bind(uid).first();
  fail(active?'確認中のご要望があります。':'ご要望の受付は1日3件までです。',409);
 }
 return await requireOwnRow(db,id,uid);
}

export async function updateCustomRequest(db,uid,id,input,revision,{now=nowSeconds()}={}){
 if(!Number.isInteger(revision)||revision<0)fail('revisionが正しくありません。');
 const value=normalizeCustomRequest(input);
 const result=await db.prepare("UPDATE supporter_custom_requests SET request_json=?,updated_at=?,revision=revision+1 WHERE id=? AND discord_user_id=? AND status='submitted' AND revision=?")
  .bind(JSON.stringify(value),now,id,uid,revision).run();
 if(!changed(result)){
  const row=await requireOwnRow(db,id,uid);
  if(Number(row.revision)!==revision)fail('別の操作で更新されています。',409);
  fail('提出済みのご要望だけ編集できます。',409);
 }
 return await requireOwnRow(db,id,uid);
}

export async function decideCustomRequest(db,uid,id,decision,revision,{now=nowSeconds(),message=''}={}){
 if(!['accept','consult','withdraw','object'].includes(decision))fail('decisionが正しくありません。');
 if(!Number.isInteger(revision)||revision<0)fail('revisionが正しくありません。');
 const row=await requireOwnRow(db,id,uid);
 if(Number(row.revision)!==revision)fail('別の操作で更新されています。',409);
 if(decision==='withdraw'&&!USER_DECISION_OPEN.has(row.status))fail('このご要望は取り下げできません。',409);
 // 異議: 申し込んだ後（運営が契約を用意した後を含む）に、理由を添えて申し出る
 if(decision==='object'){
  if(row.status!=='accepted')fail('申込み後のご要望にだけ異議を申し出られます。',409);
  if(!String(message||'').trim())fail('異議の内容をご記入ください。');
 }else if(decision!=='withdraw'&&row.status!=='answered')fail('運営の回答後に決定してください。',409);
 const status={accept:'accepted',consult:'consulting',withdraw:'withdrawn',object:'objected'}[decision];
 const result=await db.prepare('UPDATE supporter_custom_requests SET status=?,decided_at=?,decision_message=?,updated_at=?,revision=revision+1 WHERE id=? AND discord_user_id=? AND status=? AND revision=?')
  .bind(status,now,String(message||'').trim()||null,now,id,uid,row.status,revision).run();
 if(!changed(result))fail('別の操作で更新されています。',409);
 return await requireOwnRow(db,id,uid);
}

export async function answerCustomRequest(db,id,input,revision,{now=nowSeconds()}={}){
 if(!Number.isInteger(revision)||revision<0)fail('revisionが正しくありません。');
 const answer=normalizeCustomAnswer(input);
 const row=await requireAdminRow(db,id);
 if(Number(row.revision)!==revision)fail('別の操作で更新されています。',409);
 if(!ADMIN_ANSWER_OPEN.has(row.status))fail('回答できる状態ではありません。',409);
 const result=await db.prepare("UPDATE supporter_custom_requests SET status='answered',answer_json=?,answered_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status=? AND revision=?")
  .bind(JSON.stringify(answer),now,now,id,row.status,revision).run();
 if(!changed(result))fail('別の操作で更新されています。',409);
 return await requireAdminRow(db,id);
}

export async function setCustomRequestStatus(db,id,status,revision,{now=nowSeconds()}={}){
 if(!['estimating','closed'].includes(status))fail('statusが正しくありません。');
 if(!Number.isInteger(revision)||revision<0)fail('revisionが正しくありません。');
 const row=await requireAdminRow(db,id);
 if(Number(row.revision)!==revision)fail('別の操作で更新されています。',409);
 // 相談・異議を受けたら、見積もりからやり直せる
 if(status==='estimating'&&!['submitted','consulting','objected'].includes(row.status))fail('見積中に変更できる状態ではありません。',409);
 if(status==='closed'&&['withdrawn','closed'].includes(row.status))fail('すでに終了しています。',409);
 const result=await db.prepare('UPDATE supporter_custom_requests SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND status=? AND revision=?')
  .bind(status,now,id,row.status,revision).run();
 if(!changed(result))fail('別の操作で更新されています。',409);
 return await requireAdminRow(db,id);
}

export function customRequestFeatures(row){
 if(row?.status!=='accepted')fail('申込み済みのご要望ではありません。',409);
 const answer=parseJson(row.answer_json);
 const marks=isObject(answer?.marks)?answer.marks:{};
 const yes=FEATURE_NAMES.filter(name=>marks[name]==='yes');
 const partial=FEATURE_NAMES.filter(name=>marks[name]==='partial');
 return {features:[...yes,...partial].sort(),yes,partial,servers:answer?.servers??null,channels:answer?.channels??null,rules:answer?.rules??null};
}

const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function bodyKeys(input,allowed){exactKeys(input,allowed,'入力');return input;}
const requestId=path=>path.match(/^\/api\/supporter\/custom-requests\/([A-Za-z0-9_-]{1,100})(?:\/(decision))?$/);

export async function handleSupporterCustomRequestApi(request,env,db,uid,{rateLimit=async()=>{}}={}){
 const path=new URL(request.url).pathname;
 const base=path==='/api/supporter/custom-requests';
 const match=requestId(path);
 if(!base&&!match)return null;
 const enabled=customRequestsEnabled(env);
 if(request.method==='GET'&&base){
  // 運営が用意したカスタム契約（提示中・有効）。支払いは有料プランの画面の「専用の支払い手続き」から行う
  const plan=await getCustomPlan(db,uid);
  const contract=plan&&['offered','active'].includes(plan.status)?customPublic(plan):null;
  return json({enabled,items:await listCustomRequestsForUser(db,uid),plannedItems:CUSTOM_PLANNED_ITEMS,contract,paymentUrl:contract?.status==='offered'?'/site/supporter/#billing':''});
 }
 if(request.method!=='GET'&&!enabled)fail('カスタムプランのご要望受付は現在無効です。',403);
 if(request.method==='POST'&&base){
  const input=bodyKeys(await readJson(request),['request']);
  await rateLimit();
  const row=await createCustomRequest(db,uid,input.request);
  const wants=Object.values(parseJson(row.request_json)?.wants||{}).filter(value=>value==='yes'||value==='maybe').length;
  await queueNotice(env,db,{id:`custom-request:${row.id}:submitted`,channel:'membership',kind:'custom_request_submitted',title:'新しいご要望',lines:[`利用者 ID: ${uid}`,`希望の件数: ${wants}件`],tone:'info',at:row.created_at});
  return json({item:customRequestPublic(row)},201);
 }
 if(request.method==='PUT'&&match&&!match[2]){
  const input=bodyKeys(await readJson(request),['request','revision']);
  await rateLimit();
  return json({item:customRequestPublic(await updateCustomRequest(db,uid,match[1],input.request,input.revision))});
 }
 if(request.method==='POST'&&match?.[2]==='decision'){
  const input=bodyKeys(await readJson(request),['decision','revision','message']);
  await rateLimit();
  const message=textField(input,'message',500);
  const row=await decideCustomRequest(db,uid,match[1],input.decision,input.revision,{message});
  const label={accept:'申込み',consult:'相談',withdraw:'取り下げ',object:'異議の申し出'}[input.decision];
  await queueNotice(env,db,{id:`custom-request:${row.id}:decision:${row.revision}`,channel:'membership',kind:'custom_request_decision',title:`カスタムプランの${label}`,lines:[`利用者 ID: ${uid}`,message&&`メッセージ: ${message}`],tone:input.decision==='accept'?'good':input.decision==='object'?'warn':'info',at:row.updated_at});
  return json({item:customRequestPublic(row)});
 }
 return json({message:'Method not allowed'},405);
}

const adminMatch=path=>path.match(/^\/site\/supporter-admin\/api\/custom-requests\/([A-Za-z0-9_-]{1,100})(?:\/(answer|status|features))?$/);
export async function handleSupporterCustomRequestAdminApi(request,db){
 const url=new URL(request.url),path=url.pathname;
 const base=path==='/site/supporter-admin/api/custom-requests',match=adminMatch(path);
 if(!base&&!match)return null;
 if(request.method==='GET'&&base){
  const status=url.searchParams.get('status')||'';
  if(status&&!STATUS_SET.has(status))fail('statusが正しくありません。');
  const sql=`SELECT r.*,COALESCE(a.discord_name,'') AS discord_name FROM supporter_custom_requests r LEFT JOIN supporter_accounts a ON a.discord_user_id=r.discord_user_id${status?' WHERE r.status=?':''} ORDER BY r.updated_at DESC,r.id DESC`;
  const rows=status?await db.prepare(sql).bind(status).all():await db.prepare(sql).all();
  return json({items:(rows.results||[]).map(row=>customRequestPublic(row,{admin:true})),plannedItems:CUSTOM_PLANNED_ITEMS});
 }
 if(request.method==='GET'&&match&&!match[2])return json({item:customRequestPublic(await requireAdminRow(db,match[1]),{admin:true}),plannedItems:CUSTOM_PLANNED_ITEMS});
 if(request.method==='GET'&&match?.[2]==='features')return json(customRequestFeatures(await requireAdminRow(db,match[1])));
 if(request.method==='POST'&&match?.[2]==='answer'){
  const input=bodyKeys(await readJson(request),['answer','revision']);
  return json({item:customRequestPublic(await answerCustomRequest(db,match[1],input.answer,input.revision),{admin:true})});
 }
 if(request.method==='POST'&&match?.[2]==='status'){
  const input=bodyKeys(await readJson(request),['status','revision']);
  return json({item:customRequestPublic(await setCustomRequestStatus(db,match[1],input.status,input.revision),{admin:true})});
 }
 return json({message:'Method not allowed'},405);
}
