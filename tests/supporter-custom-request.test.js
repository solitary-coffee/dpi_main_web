import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {
 CUSTOM_PLANNED_ITEMS,normalizeCustomRequest,normalizeCustomAnswer,
 createCustomRequest,listCustomRequestsForUser,updateCustomRequest,decideCustomRequest,
 answerCustomRequest,setCustomRequestStatus,customRequestFeatures,
} from '../worker/supporter-custom-request.js';
import {handleSupporterRequest} from '../worker/supporter.js';

const UID='123456789012345678',OTHER='223456789012345678';
const ID='11111111-1111-4111-8111-111111111111';
const requestInput=()=>({
 contact:'Discord DM',budget:'月額3,000円程度',servers:2,channels:5,rules:10,
 wants:{eewMap:'yes',estimatedIntensity:'maybe'},wantNotes:{estimatedIntensity:'準備中でも相談したい'},
 request:'複数サーバーへ配信したいです。',
});
const answerInput=()=>({
 estimator:'運営',amount:'月額3,000円',memo:'対応できます。',servers:2,channels:5,rules:10,
 marks:{eewMap:'yes',estimatedIntensity:'partial'},notes:{estimatedIntensity:'提供時期は要相談'},
});

async function database(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`CREATE TABLE supporter_accounts(discord_user_id TEXT PRIMARY KEY,discord_name TEXT);`);
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
