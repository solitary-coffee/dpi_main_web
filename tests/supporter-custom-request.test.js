import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {
 CUSTOM_PLANNED_ITEMS,normalizeCustomRequest,normalizeCustomAnswer,
 createCustomRequest,listCustomRequestsForUser,updateCustomRequest,decideCustomRequest,
 answerCustomRequest,setCustomRequestStatus,customRequestFeatures,handleSupporterCustomRequestAdminApi,
} from '../worker/supporter-custom-request.js';
import {handleSupporterRequest} from '../worker/supporter.js';

const UID='123456789012345678',OTHER='223456789012345678';
const ID='11111111-1111-4111-8111-111111111111';
const requestInput=()=>({
 email:'User@Example.com',contact:'Discord DM',budget:'月額3,000円程度',servers:2,channels:5,rules:10,
 wants:{eewMap:'yes',estimatedIntensity:'maybe'},wantNotes:{estimatedIntensity:'準備中でも相談したい'},
 request:'複数サーバーへ配信したいです。',
});
const answerInput=()=>({
 estimator:'運営',amount:'月額3,000円',memo:'対応できます。',servers:2,channels:5,rules:10,
 marks:{eewMap:'yes',estimatedIntensity:'partial'},notes:{estimatedIntensity:'提供時期は要相談'},
});

async function database(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`CREATE TABLE supporter_accounts(discord_user_id TEXT PRIMARY KEY,discord_name TEXT,billing_email TEXT,registered_at TEXT,updated_at TEXT,account_status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE admin_audit_events(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT,details_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);`);
 raw.exec(await readFile(new URL('../migrations/0037_supporter_custom_requests.sql',import.meta.url),'utf8'));
 const statement=(sql,values=[])=>({
  bind(...input){return statement(sql,input);},
  async first(){return raw.prepare(sql).get(...values)??null;},
  async all(){return{results:raw.prepare(sql).all(...values)};},
  async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};},
 });
 return {raw,db:{prepare:sql=>statement(sql)}};
}
const rejectsStatus=async(action,status)=>{
 await assert.rejects(action,error=>{assert.equal(error.status,status);return true;});
};

test('連絡用のメールアドレスは必須で、形を確かめて小文字にそろえる',()=>{
 assert.equal(normalizeCustomRequest(requestInput()).email,'user@example.com');
 for(const email of [undefined,'','user','user@','@example.com','a b@example.com','user@example','<x>@example.com',`${'a'.repeat(250)}@example.com`]){
  assert.throws(()=>normalizeCustomRequest({...requestInput(),email}),error=>error.status===400,String(email));
 }
});

test('要望と回答は機能キー、値、文字数、依存関係を共通検証する',()=>{
 const normalized=normalizeCustomRequest(requestInput());
 assert.equal(normalized.wants.estimatedIntensity,'maybe');
 assert.ok(CUSTOM_PLANNED_ITEMS.some(item=>item.name==='amedas'&&item.label));
 assert.throws(()=>normalizeCustomRequest({...requestInput(),servers:101}),/servers/);
 assert.throws(()=>normalizeCustomRequest({...requestInput(),wants:{unknown:'yes'}}),/不明な機能/);
 assert.throws(()=>normalizeCustomRequest({...requestInput(),wants:{eewMap:'later'}}),/値が正しく/);
 assert.throws(()=>normalizeCustomRequest({...requestInput(),extra:true}),/不明な項目/);
 assert.throws(()=>normalizeCustomAnswer({...answerInput(),marks:{eewMapRegion:'yes'}}),/依存機能/);
 assert.equal(normalizeCustomAnswer({...answerInput(),marks:{eewMap:'partial',eewMapRegion:'yes'}}).marks.eewMapRegion,'yes');
});

test('提出、編集、見積、回答、申込みをrevision付きで遷移する',async()=>{
 const {db}=await database();
 let row=await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 assert.equal(row.status,'submitted');assert.equal(row.revision,0);
 row=await updateCustomRequest(db,UID,ID,{...requestInput(),budget:'応相談'},0,{now:100010});
 assert.equal(row.revision,1);
 row=await setCustomRequestStatus(db,ID,'estimating',1,{now:100020});
 assert.equal(row.status,'estimating');
 row=await answerCustomRequest(db,ID,answerInput(),2,{now:100030});
 assert.equal(row.status,'answered');assert.equal(row.answered_at,100030);
 row=await decideCustomRequest(db,UID,ID,'accept',3,{now:100040});
 assert.equal(row.status,'accepted');assert.equal(row.decided_at,100040);
 assert.deepEqual(customRequestFeatures(row),{
  features:['eewMap'],yes:['eewMap'],partial:[],servers:2,channels:5,rules:10,
 });
});

test('同じ利用者の確認中は重複受付せず、24時間に3件までに制限する',async()=>{
 const {db}=await database();
 for(let index=0;index<3;index+=1){
  const id=`00000000-0000-4000-8000-00000000000${index}`;
  const row=await createCustomRequest(db,UID,requestInput(),{id,now:100000+index});
  await rejectsStatus(()=>createCustomRequest(db,UID,requestInput(),{id:`10000000-0000-4000-8000-00000000000${index}`,now:100000+index}),409);
  await decideCustomRequest(db,UID,id,'withdraw',row.revision,{now:100010+index});
 }
 await rejectsStatus(()=>createCustomRequest(db,UID,requestInput(),{id:'22222222-2222-4222-8222-222222222222',now:100100}),409);
});

test('他人の要望は一覧に出ず、参照扱いの更新も404になる',async()=>{
 const {db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 assert.equal((await listCustomRequestsForUser(db,OTHER)).length,0);
 await rejectsStatus(()=>updateCustomRequest(db,OTHER,ID,requestInput(),0,{now:100010}),404);
 await rejectsStatus(()=>decideCustomRequest(db,OTHER,ID,'withdraw',0,{now:100010}),404);
});

test('古いrevisionによる利用者・管理者の更新は409になる',async()=>{
 const {db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 await updateCustomRequest(db,UID,ID,requestInput(),0,{now:100010});
 await rejectsStatus(()=>updateCustomRequest(db,UID,ID,requestInput(),0,{now:100020}),409);
 await rejectsStatus(()=>setCustomRequestStatus(db,ID,'estimating',0,{now:100020}),409);
});

test('回答のyesとpartialから公開済み機能だけを契約入力へ変換する',async()=>{
 const {raw,db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 const answer={...answerInput(),marks:{eewMap:'partial',eewMapRegion:'yes',estimatedIntensity:'yes'}};
 await answerCustomRequest(db,ID,answer,0,{now:100010});
 const row=await decideCustomRequest(db,UID,ID,'accept',1,{now:100020});
 assert.deepEqual(customRequestFeatures(row),{
  features:['eewMap','eewMapRegion'],yes:['eewMapRegion'],partial:['eewMap'],servers:2,channels:5,rules:10,
 });
 assert.equal(raw.prepare('SELECT revision FROM supporter_custom_requests WHERE id=?').get(ID).revision,2);
});

test('回答済みなら申込み前でも契約機能を取得でき、回答がなければ400になる',async()=>{
 const {db}=await database();
 let row=await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 assert.throws(()=>customRequestFeatures(row),error=>error.status===400);
 row=await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 assert.equal(row.status,'answered');
 assert.deepEqual(customRequestFeatures(row),{features:['eewMap'],yes:['eewMap'],partial:[],servers:2,channels:5,rules:10});
});

test('ensure-accountはご要望の送り主をメール付きで作成し監査ログを残す',async()=>{
 const {raw,db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 const endpoint=`https://example.test/site/supporter-admin/api/custom-requests/${ID}/ensure-account`;
 const response=await handleSupporterCustomRequestAdminApi(new Request(endpoint,{method:'POST'}),db,{}, {email:'admin@example.com'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{created:true});
 const account=raw.prepare('SELECT * FROM supporter_accounts WHERE discord_user_id=?').get(UID);
 assert.equal(account.discord_name,'');assert.equal(account.billing_email,'user@example.com');assert.equal(account.account_status,'active');
 assert.match(account.registered_at,/^\d{4}-\d{2}-\d{2}T/);assert.equal(account.updated_at,account.registered_at);
 assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM supporter_accounts WHERE discord_user_id=?').get(OTHER).count,0);
 const audit=raw.prepare('SELECT * FROM admin_audit_events').get();
 assert.equal(audit.actor,'admin@example.com');assert.equal(audit.action,'supporter.custom_request_account_created');assert.equal(audit.entity_id,UID);
 assert.deepEqual(JSON.parse(audit.details_json),{requestId:ID});
});

test('ensure-accountは既存アカウントを変更せずcreated:falseを返す',async()=>{
 const {raw,db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at,account_status) VALUES(?,?,?,?,?,?)').run(UID,'既存名','old@example.jp','old-created','old-updated','suspended');
 const response=await handleSupporterCustomRequestAdminApi(new Request(`https://example.test/site/supporter-admin/api/custom-requests/${ID}/ensure-account`,{method:'POST'}),db,{}, {email:'admin@example.com'});
 assert.deepEqual(await response.json(),{created:false});
 const account=raw.prepare('SELECT * FROM supporter_accounts WHERE discord_user_id=?').get(UID);
 assert.equal(account.discord_name,'既存名');assert.equal(account.billing_email,'old@example.jp');assert.equal(account.account_status,'suspended');
 assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM admin_audit_events').get().count,0);
});

test('ensure-accountは回答なしと不正メールを400、取り下げ済みを409にする',async()=>{
 const run=async mutate=>{
  const {raw,db}=await database();await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});await mutate(raw,db);
  return handleSupporterCustomRequestAdminApi(new Request(`https://example.test/site/supporter-admin/api/custom-requests/${ID}/ensure-account`,{method:'POST'}),db,{}, {email:'admin@example.com'});
 };
 await rejectsStatus(run(async()=>{}),400);
 await rejectsStatus(run(async(raw,db)=>{await answerCustomRequest(db,ID,answerInput(),0,{now:100010});raw.prepare('UPDATE supporter_custom_requests SET request_json=?').run(JSON.stringify({...requestInput(),email:'invalid'}));}),400);
 await rejectsStatus(run(async(raw,db)=>{await answerCustomRequest(db,ID,answerInput(),0,{now:100010});raw.prepare("UPDATE supporter_custom_requests SET status='withdrawn'").run();}),409);
});

test('支払いURLメールはご要望の宛先へ件名とURLを含めて送る',async()=>{
 const {db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 const messages=[],env={NOTICE_FROM_EMAIL:'notice@dpi-bot.com',NOTICE_REPLY_TO_EMAIL:'support@dpi-bot.com',NOTICE_EMAIL:{async send(message){messages.push(message);}}};
 const url='https://checkout.stripe.com/c/pay/test_custom_request';
 const response=await handleSupporterCustomRequestAdminApi(new Request(`https://example.test/site/supporter-admin/api/custom-requests/${ID}/payment-link-email`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),db,env);
 assert.equal(response.status,200);
 const result=await response.json();
 assert.equal(result.sent,true);assert.equal(result.to,'user@example.com');assert.equal(typeof result.sentAt,'number');
 assert.equal(messages.length,1);assert.equal(messages[0].to,'user@example.com');
 assert.equal(messages[0].subject,'【DPI-Bot】カスタムプランのお支払いのご案内');
 assert.match(messages[0].text,/ご要望番号: 11111111-1111-4111-8111-111111111111/);assert.match(messages[0].text,new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(messages[0].text,/https:\/\/dpi-bot\.com\/terms\/terms\.html/);assert.match(messages[0].text,/https:\/\/dpi-bot\.com\/terms\/Specified\.html/);
 assert.match(messages[0].html,/checkout\.stripe\.com/);assert.equal(messages[0].replyTo,'support@dpi-bot.com');
});

test('支払いURLメールはStripe以外を400、メール機能未設定を503にする',async()=>{
 const {db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 const endpoint=`https://example.test/site/supporter-admin/api/custom-requests/${ID}/payment-link-email`;
 const call=(url,env)=>handleSupporterCustomRequestAdminApi(new Request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),db,env);
 let sends=0;const env={NOTICE_FROM_EMAIL:'notice@dpi-bot.com',NOTICE_EMAIL:{async send(){sends+=1;}}};
 await assert.rejects(()=>call('https://example.com/pay',env),error=>error.status===400);
 assert.equal(sends,0);
 await assert.rejects(()=>call('https://checkout.stripe.com/c/pay/test',{}),error=>error.status===503&&/メール送信機能/.test(error.message));
});

test('機能が無効な間は認証済み利用者の書き込みを403にする',async()=>{
 const session={discord_user_id:UID,discord_username:'tester',csrf_token:'csrf',guilds_json:'[]'};
 const statement=sql=>({
  bind(){return this;},
  async first(){
   if(sql.includes('channel_mappings FROM reuse_applications'))return {};
   if(sql.includes('SELECT * FROM reuse_sessions'))return session;
   return null;
  },
 });
 const env={REUSE_DB:{prepare:statement},SUPPORTER_PUBLIC_ENABLED:'true',SUPPORTER_CUSTOM_REQUESTS_ENABLED:'false'};
 const response=await handleSupporterRequest(new Request('https://example.test/api/supporter/custom-requests',{
  method:'POST',headers:{Cookie:'dpi_reuse_session=token',Origin:'https://example.test','x-reuse-csrf':'csrf','content-type':'application/json'},
  body:JSON.stringify({request:requestInput()}),
 }),env);
 assert.equal(response.status,403);
 assert.equal((await response.json()).message,'カスタムプランのご要望受付は現在無効です。');
});

test('申込み後は理由を添えて異議を申し出られ、運営は見積もりからやり直せる',async()=>{
 const {db}=await database();
 let row=await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 row=await answerCustomRequest(db,ID,answerInput(),0,{now:100010});
 await rejectsStatus(decideCustomRequest(db,UID,ID,'object',1,{now:100015,message:'金額が違う'}),409);
 row=await decideCustomRequest(db,UID,ID,'accept',1,{now:100020});
 await rejectsStatus(decideCustomRequest(db,UID,ID,'object',2,{now:100030,message:'  '}),400);
 row=await decideCustomRequest(db,UID,ID,'object',2,{now:100030,message:'金額が回答と違います'});
 assert.equal(row.status,'objected');assert.equal(row.decision_message,'金額が回答と違います');
 assert.equal((await listCustomRequestsForUser(db,UID))[0].decisionMessage,'金額が回答と違います');
 await rejectsStatus(decideCustomRequest(db,OTHER,ID,'object',3,{message:'他人'}),404);
 row=await setCustomRequestStatus(db,ID,'estimating',3,{now:100040});
 assert.equal(row.status,'estimating');
 row=await answerCustomRequest(db,ID,answerInput(),4,{now:100050});
 assert.equal(row.status,'answered');
});

test('利用者の取得は、運営が用意した契約（提示中・有効）と支払いへの案内を返す',async()=>{
 const {raw,db}=await database();
 for(const name of ['0025_supporter_custom_plans.sql','0032_supporter_custom_plan_features.sql'])raw.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
 raw.prepare("INSERT INTO supporter_accounts(discord_user_id,discord_name) VALUES(?,?)").run(UID,'利用者');
 const get=async()=>{const {handleSupporterCustomRequestApi}=await import('../worker/supporter-custom-request.js');return await (await handleSupporterCustomRequestApi(new Request('https://dpi-bot.com/api/supporter/custom-requests'),{SUPPORTER_CUSTOM_REQUESTS_ENABLED:'true'},db,UID)).json();};
 let data=await get();
 assert.equal(data.contract,null);assert.equal(data.paymentUrl,'');
 raw.prepare(`INSERT INTO supporter_custom_plans(discord_user_id,id,status,channel_limit,server_limit,rule_limit,estimated_yen,confirmed_yen,reason,updated_by,created_at,updated_at,features_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(UID,'custom-1','offered',10,3,15,1500,1500,'ご要望から','運営','2026-11-26','2026-11-26','["eewMap","weatherMap"]');
 data=await get();
 assert.equal(data.contract.status,'offered');assert.equal(data.contract.monthlyYen,1500);assert.equal(data.paymentUrl,'/site/supporter/#billing');
 raw.prepare("UPDATE supporter_custom_plans SET status='active'").run();
 data=await get();
 assert.equal(data.contract.status,'active');assert.equal(data.paymentUrl,'');
 raw.prepare("UPDATE supporter_custom_plans SET status='canceled'").run();
 assert.equal((await get()).contract,null);
});

test('管理画面の一覧と詳細は、準備中の機能の日本語名も返す',async()=>{
 const {handleSupporterCustomRequestAdminApi}=await import('../worker/supporter-custom-request.js');
 const {db}=await database();
 await createCustomRequest(db,UID,requestInput(),{id:ID,now:100000});
 const base='https://example.test/site/supporter-admin/api/custom-requests';
 for(const url of [base,`${base}/${ID}`]){
  const data=await (await handleSupporterCustomRequestAdminApi(new Request(url),db)).json();
  assert.deepEqual(data.plannedItems,CUSTOM_PLANNED_ITEMS);
  for(const item of data.plannedItems)assert.match(item.label,/[ぁ-んァ-ヶ一-龠]/,`${item.name} に日本語名がない`);
 }
});
