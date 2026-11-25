import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { supporterAdminPayments } from '../worker/supporter-admin-payments.js';
import { handleSupporterRequest } from '../worker/supporter.js';

async function database(t) {
 let DatabaseSync;
 try { ({DatabaseSync} = await import('node:sqlite')); } catch { t.skip('node:sqlite is not available'); return null; }
 const raw = new DatabaseSync(':memory:');
 const dir = new URL('../migrations/',import.meta.url);
 for (const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort()) raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement = (sql,values=[]) => ({bind(...input){return statement(sql,input);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 return {raw,db:{prepare:sql=>statement(sql)}};
}

const UID='123456789012345678', env={SUPPORTER_BILLING_MODE:'test',SUPPORTER_ROLE_MEMBER:'role_member',SUPPORTER_ROLE_BASIC:'role_basic'};

test('payments API data includes every section, ordering, labels, limit, and no secrets',async t=>{
 const store=await database(t);if(!store)return;
 const {raw,db}=store;
 raw.prepare(`INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at) VALUES(?,?,?,?,?)`).run(UID,'利用者','secret@example.jp','x','x');
 raw.prepare(`INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)`).run(UID,'cus_secret');
 raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run('in_secret','cus_secret',300,'jpy','retry_scheduled',1,2,3,4);
 raw.prepare(`INSERT INTO supporter_payment_alerts(event_id,kind,outcome,discord_user_id,amount,created_at) VALUES(?,?,?,?,?,?)`).run('evt_secret','refunded','ok',UID,300,20);
 raw.prepare(`INSERT INTO supporter_billing_notifications(invoice_id,kind,status,attempts,last_error,sent_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run('in_secret','payment_failed','failed',2,'card',null,30);
 raw.prepare(`INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,checkout_session_id,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('request-1',UID,'cus_secret','cs_secret',500,'pending',40,40);
 raw.prepare(`INSERT INTO supporter_discord_roles(discord_user_id,role_id,status,updated_at,attempts) VALUES(?,?,?,?,?)`).run(UID,'role_basic','granted',50,1);
 const addNotice=(id,channel,kind,at)=>raw.prepare(`INSERT INTO supporter_ops_notices(id,channel,kind,payload_json,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(id,channel,kind,JSON.stringify({title:id,description:'a\nb'}),'pending',1,at,at);
 addNotice('run-old','billing','renewal_start',60);addNotice('run-new','billing','retry_result',70);addNotice('notice','membership','join',80);
 const result=await supporterAdminPayments(db,env,1);
 assert.equal(result.mode,'test');assert.equal(typeof result.generatedAt,'number');
 assert.deepEqual(result.runs.map(x=>x.id),['run-new']);assert.deepEqual(result.runs[0].lines,['a','b']);assert.deepEqual(result.notices.map(x=>x.id),['notice']);
 assert.equal(result.failures[0].type,'invoice');assert.equal(result.failures[0].statusLabel,'再請求待ち');assert.equal(result.failures[0].name,'利用者');
 assert.equal(result.alerts[0].kindLabel,'返金');assert.equal(result.mails[0].discordUserId,UID);assert.equal(result.topups[0].statusLabel,'処理待ち');assert.equal(result.roles[0].roleLabel,'Basicプラン');
 assert.deepEqual(result.summary,{failuresOpen:1,suspended:0,mailsFailed:1,noticesPending:3,alerts30d:0,topupsPending:1});
 const json=JSON.stringify(result);for(const secret of ['secret@example.jp','cus_secret','cs_secret'])assert.ok(!json.includes(secret));
});

test('hold and dispute prefixes are classified',async t=>{
 const store=await database(t);if(!store)return;
 for(const [id,updated] of [['hold:sub',1],['hold:dispute:dp',2]]) store.raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,amount_due,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(id,'cus',0,'suspended',1,1,1,updated);
 const result=await supporterAdminPayments(store.db,env,20);
 assert.deepEqual(result.failures.map(x=>x.type),['dispute','hold']);
});

test('one table failure yields an empty section and errors while returning other data',async t=>{
 const store=await database(t);if(!store)return;
 const db={prepare(sql){if(sql.includes('FROM supporter_payment_alerts'))throw new Error('missing');return store.db.prepare(sql);}};
 const result=await supporterAdminPayments(db,env,20);
 assert.deepEqual(result.alerts,[]);assert.ok(result.errors.includes('alerts'));assert.deepEqual(result.topups,[]);
});

test('payments route rejects unauthenticated requests exactly like accounts and rejects non-GET after auth gate',async()=>{
 const base={ACCESS_AUD:'',ACCESS_TEAM_DOMAIN:'',ADMIN_EMAILS:''};
 const payments=await handleSupporterRequest(new Request('https://example.test/site/supporter-admin/api/payments'),base);
 const accounts=await handleSupporterRequest(new Request('https://example.test/site/supporter-admin/api/accounts'),base);
 assert.equal(payments.status,accounts.status);assert.deepEqual(await payments.json(),await accounts.json());
 const post=await handleSupporterRequest(new Request('https://example.test/site/supporter-admin/api/payments',{method:'POST'}),base);
 assert.equal(post.status,accounts.status);
});
