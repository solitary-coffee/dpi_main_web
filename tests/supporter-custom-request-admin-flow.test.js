import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {customPlanEstimate,stripeCheckoutUrl} from '../site/supporter-admin/custom-plan-api.js';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('最終確認書は画面と分離したA4縦の印刷専用書類である',async()=>{
 const [html,css,script]=await Promise.all([read('../site/supporter-admin/custom-requests.html'),read('../site/supporter-admin/custom-requests.css'),read('../site/supporter-admin/custom-requests.js')]);
 for(const id of ['final-document','document-request-id','document-received-at','document-answered-at','document-printed-at','document-name','document-email','document-discord-id','document-budget','document-quantities','document-amount','document-estimator','document-feature-body','document-request-note','document-admin-memo'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/上記の内容で契約します/);
 assert.match(html,/最終確認書をPDFで保存（印刷）/);
 assert.match(css,/@page\{size:A4 portrait;margin:15mm\}/);
 assert.match(css,/body>\.page-container[^}]*display:none!important/);
 assert.match(css,/\.final-document\{display:block!important/);
 assert.match(css,/\.document-feature-table thead\{display:table-header-group\}/);
 assert.match(css,/\.document-feature-table tr\{break-inside:avoid;page-break-inside:avoid\}/);
 assert.match(script,/def\.plan==='custom'\?'準備中'/);
 assert.match(script,/for\(const value of \[def\.label,def\.plan==='custom'\?'準備中'/);
});

test('ご要望詳細に保存と支払いURL作成までの3段階がある',async()=>{
 const [html,script]=await Promise.all([read('../site/supporter-admin/custom-requests.html'),read('../site/supporter-admin/custom-requests.js')]);
 for(const id of ['contract-workflow','contract-form','contract-uid','contract-confirm','contract-servers','contract-channels','contract-rules','contract-price','contract-feature-list','contract-save','contract-checkout','contract-save-result','contract-checkout-result'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/id="contract-checkout" type="button" disabled/);
 assert.match(script,/\/site\/supporter-admin\/api\/custom-requests\/\$\{encodeURIComponent\(id\)\}\/features/);
 assert.match(script,/api\('\/site\/supporter-admin\/api\/accounts'\)/);
 assert.match(script,/sendCustomPlan\(payload\)/);
 assert.match(script,/contractSaved=true/);
 assert.match(script,/navigator\.clipboard\.writeText\(url\)/);
});

test('保存時のアカウント作成はご要望の送り主と入力IDが同じ場合だけ呼ぶ',async()=>{
 const script=await read('../site/supporter-admin/custom-requests.js');
 assert.match(script,/if\(payload\.discordUserId===current\.discordUserId\)\{[\s\S]*?\/ensure-account`,'POST',\{\}\);/);
 assert.match(script,/有料プランに未登録だったため、ご要望のメールアドレスでアカウントを作成しました。/);
});

test('回答後の契約欄表示条件と未申込みの注意を備える',async()=>{
 const [html,script]=await Promise.all([read('../site/supporter-admin/custom-requests.html'),read('../site/supporter-admin/custom-requests.js')]);
 assert.match(html,/id="contract-warning"[^>]*hidden>利用者はまだこの回答に申し込んでいません。利用者と合意済みの場合だけ進めてください。/);
 // 終了したご要望でも契約手続きへ進める（取り下げは除く）
 assert.match(script,/const showContract=Boolean\(item\.answer\)&&item\.status!=='withdrawn';/);
 assert.match(script,/このご要望は終了しています。/);
 assert.match(script,/\$\('contract-warning'\)\.hidden=!showContract\|\|item\.status==='accepted'/);
 assert.match(script,/if\(showContract\)loadContractWorkflow\(item\)/);
});

test('支払いURLの新規作成メール送信と既存URL送信の操作がある',async()=>{
 const [html,script]=await Promise.all([read('../site/supporter-admin/custom-requests.html'),read('../site/supporter-admin/custom-requests.js')]);
 for(const id of ['contract-checkout-email','contract-email-existing','contract-email-result'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/支払いURLを作成してメールで送る/);assert.match(html,/この支払いURLをメールで送る/);
 assert.match(script,/window\.confirm\(`次の宛先に支払いURLを送信しますか？/);
 assert.match(script,/\/payment-link-email`,'POST',\{url\}/);
 assert.match(script,/paymentLinkBusy/);
});

test('支払いURLはcheckout.stripe.comのHTTPSだけを許可する',()=>{
 assert.equal(stripeCheckoutUrl('https://checkout.stripe.com/c/pay/test'),'https://checkout.stripe.com/c/pay/test');
 for(const value of ['http://checkout.stripe.com/c/pay/test','https://checkout.stripe.com.example.com/c/pay/test','https://example.com/checkout','not-a-url'])assert.throws(()=>stripeCheckoutUrl(value),/Stripeの支払いURL/);
});

test('共通の参考料金計算は既存規則を維持する',()=>{
 assert.equal(customPlanEstimate({features:[],channels:2,servers:1,rules:5,secondaryReuse:false}),300);
 assert.equal(customPlanEstimate({features:['municipalityScope'],channels:10,servers:3,rules:15,secondaryReuse:true}),1000);
});
