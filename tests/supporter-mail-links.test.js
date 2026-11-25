import test from 'node:test';
import assert from 'node:assert/strict';
import {mailHtml,sendBillingNotification} from '../worker/supporter-billing.js';
import {queueNotice,retryAdminNotices} from '../worker/supporter-ops-notice.js';

function noticeDb(email='user@example.com'){
 const notices=new Map(),ops=new Map();
 return {notices,ops,prepare(sql){let values=[];return{bind(...input){values=input;return this;},async first(){
  if(sql.includes('billing_email'))return{billing_email:email};
  if(sql.startsWith('SELECT status,attempts'))return notices.get(`${values[0]}:${values[1]}`)||null;
  return null;
 },async all(){
  if(sql.includes("n.kind='admin_notice'"))return{results:[...notices.entries()].filter(([,v])=>v.kind==='admin_notice'&&v.status==='failed').map(([key,v])=>{const id=key.split(':admin_notice')[0].slice(4),op=ops.get(id);return{invoice_id:`ops:${id}`,last_error:v.last_error,updated_at:v.updated_at,id,payload_json:op?.payload_json};})};
  return{results:[]};
 },async run(){
  if(sql.startsWith('INSERT INTO supporter_billing_notifications')){const key=`${values[0]}:${values[1]}`;if(!notices.has(key))notices.set(key,{status:'pending',attempts:0,kind:values[1],updated_at:values[2]});return{meta:{changes:1}};}
  if(sql.includes("SET status='sending'")){const row=notices.get(`${values[1]}:${values[2]}`);if(row&&['pending','failed'].includes(row.status)&&row.attempts<5){row.status='sending';row.attempts+=1;row.updated_at=values[0];return{meta:{changes:1}};}return{meta:{changes:0}};}
  if(sql.includes("SET status='sent'")){const row=notices.get(`${values[2]}:${values[3]}`);if(row)row.status='sent';return{meta:{changes:1}};}
  if(sql.includes("SET status='failed'")){const row=notices.get(`${values[2]}:${values[3]}`);if(row){row.status='failed';row.last_error=values[0];row.updated_at=values[1];}return{meta:{changes:1}};}
  if(sql.startsWith('INSERT INTO supporter_ops_notices')){ops.set(values[0],{id:values[0],payload_json:values[3]});return{meta:{changes:1}};}
  return{meta:{changes:1}};
 }};}};
}
const env=send=>({SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_test_x',NOTICE_EMAIL:{send},NOTICE_FROM_EMAIL:'notice@dpi-bot.com',NOTICE_REPLY_TO_EMAIL:'reply@dpi-bot.com'});

test('有料プランメールは共通署名、通知番号、JST日時と許可したStripeリンクだけを載せる',async()=>{
 let mail;const db=noticeDb(),original=globalThis.fetch;
 globalThis.fetch=async url=>{const path=new URL(url).pathname;return Response.json(path.includes('/invoices/')?{hosted_invoice_url:'https://invoice.stripe.com/i/full',invoice_pdf:'https://files.stripe.com/invoice.pdf',payments:{data:[{payment:{payment_intent:'pi_ok'}}]}}:{latest_charge:{receipt_url:'https://pay.stripe.com/receipts/full'}});};
 try{await sendBillingNotification(env(async value=>{mail=value;}),db,'payment_succeeded',{id:'in_ok',customer:'cus_x',amount_paid:300,currency:'jpy',hosted_invoice_url:'http://invoice.stripe.com/bad',invoice_pdf:'https://evil.example/x'});}finally{globalThis.fetch=original;}
 for(const text of ['DPI-Bot 有料プランをご利用いただき、ありがとうございます。','公式サイト: https://dpi-bot.com/','契約・支払い方法の管理: https://dpi-bot.com/site/supporter/','お問い合わせ: https://dpi-bot.com/site/supp/index.html','メール: reply@dpi-bot.com','公式サポートサーバー: https://discord.gg/qFuZcGUb4K','利用規約: https://dpi-bot.com/terms/terms.html','特定商取引法に基づく表記: https://dpi-bot.com/terms/Specified.html','プライバシーポリシー: https://dpi-bot.com/terms/policy.html','配信停止の設定にかかわらず','お心当たりがない場合','通知番号: in_ok','送信日時（日本時間）','請求書（画面）: https://invoice.stripe.com/i/full','請求書（PDF）: https://files.stripe.com/invoice.pdf','領収書: https://pay.stripe.com/receipts/full'])assert.match(mail.text,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.doesNotMatch(mail.text,/http:\/\/invoice|evil\.example/);
});

test('Checkout領収書、クレジット案内、取得失敗時の管理画面案内を送信継続する',async()=>{
 const original=globalThis.fetch;
 try{
  let mail;globalThis.fetch=async()=>Response.json({payment_intent:{latest_charge:{receipt_url:'https://pay.stripe.com/receipts/checkout'}}});
  await sendBillingNotification(env(async value=>{mail=value;}),noticeDb(),'credit_topup_succeeded',{id:'cs_topup',customer:'cus_x',amount_paid:500,currency:'jpy'});assert.match(mail.text,/領収書: https:\/\/pay\.stripe\.com\/receipts\/checkout/);
  await sendBillingNotification(env(async value=>{mail=value;}),noticeDb(),'credit_plan_payment_succeeded',{id:'credit-signup:x',customer:'cus_x',amount_paid:300,currency:'jpy'});assert.match(mail.text,/お支払いの内容は契約・支払い方法の管理から確認できます/);
  globalThis.fetch=async()=>{throw new Error('offline');};await sendBillingNotification(env(async value=>{mail=value;}),noticeDb(),'payment_failed',{id:'in_fail',customer:'cus_x',amount_due:300,currency:'jpy'});assert.match(mail.text,/お支払い・請求書の確認: https:\/\/dpi-bot\.com\/site\/supporter\//);
 }finally{globalThis.fetch=original;}
});

test('管理者メールは異議と不正だけを一度送り、設定不正は送らず失敗を再送する',async()=>{
 const db=noticeDb();let sent=0,fail=true;const adminEnv={SUPPORTER_BILLING_MODE:'test',CONTACT_TO_EMAIL:'admin@example.com',NOTICE_FROM_EMAIL:'notice@dpi-bot.com',NOTICE_EMAIL:{send:async mail=>{sent+=1;assert.equal(mail.to,'admin@example.com');assert.match(mail.subject,/【重要・管理者向け】DPI-Bot 有料プラン：【テスト】/);assert.doesNotMatch(mail.text,/@example|pi_|ch_/);if(fail)throw new Error('mail down');}}};
 await queueNotice(adminEnv,db,{id:'evt1:disputed',channel:'billing',kind:'disputed',title:'支払異議の申立て',lines:['金額: 300円']});assert.equal(sent,1);
 fail=false;assert.equal(await retryAdminNotices(adminEnv,db),1);assert.equal(sent,2);await queueNotice(adminEnv,db,{id:'evt1:disputed',channel:'billing',kind:'disputed',title:'支払異議の申立て',lines:['金額: 300円']});assert.equal(sent,2);
 await queueNotice(adminEnv,db,{id:'evt2:fraud_warning',channel:'billing',kind:'fraud_warning',title:'不正の警告',lines:['状態: warning']});assert.equal(sent,3);
 await queueNotice(adminEnv,db,{id:'evt3:refunded',channel:'billing',kind:'refunded',title:'返金'});assert.equal(sent,3);
 for(const bad of ['', 'a@example.com,b@example.com','not-an-email']){await queueNotice({...adminEnv,CONTACT_TO_EMAIL:bad},noticeDb(),{id:`bad:${bad}`,channel:'billing',kind:'disputed',title:'支払異議の申立て'});}
 assert.equal(sent,3);
});

test('HTML版は文字のクリックで開けるリンクにし、当方とStripe以外のURLや記号は文字のまま出す',async()=>{
 let mail;const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({hosted_invoice_url:'https://invoice.stripe.com/i/a?b=1&c=2',invoice_pdf:'https://pay.stripe.com/invoice/a/pdf?s=ap'});
 try{await sendBillingNotification(env(async value=>{mail=value;}),noticeDb(),'payment_succeeded',{id:'in_html',customer:'cus_x',amount_paid:300,currency:'jpy'});}finally{globalThis.fetch=original;}
 for(const [label,url] of [['公式サイト','https://dpi-bot.com/'],['契約・支払い方法の管理','https://dpi-bot.com/site/supporter/'],['お問い合わせ','https://dpi-bot.com/site/supp/index.html'],['公式サポートサーバー','https://discord.gg/qFuZcGUb4K'],['利用規約','https://dpi-bot.com/terms/terms.html'],['特定商取引法に基づく表記','https://dpi-bot.com/terms/Specified.html'],['プライバシーポリシー','https://dpi-bot.com/terms/policy.html'],['請求書（画面）','https://invoice.stripe.com/i/a?b=1&amp;c=2'],['請求書（PDF）','https://pay.stripe.com/invoice/a/pdf?s=ap']])
  assert.ok(mail.html.includes(`<a href="${url}"`)&&mail.html.includes(`>${label}</a>`),label);
 assert.match(mail.html,/href="mailto:reply@dpi-bot\.com"/);
 assert.doesNotMatch(mail.text+mail.html,/孤独のコーヒー|Disaster prevention/);
 assert.match(mail.text,/公式サイト: https:\/\/dpi-bot\.com\//,'HTMLを表示できない環境向けのテキストにURLが無い');
 const unsafe=mailHtml('理由: https://evil.example/x\n理由: https://dpi-bot.com.evil.example/\n理由: https://user@dpi-bot.com/\n<script>alert(1)</script>\n"x" & y\n理由: javascript:alert(1)');
 assert.doesNotMatch(unsafe,/<a |<script/);assert.match(unsafe,/&lt;script&gt;/);assert.match(unsafe,/&quot;x&quot; &amp; y/);
});
