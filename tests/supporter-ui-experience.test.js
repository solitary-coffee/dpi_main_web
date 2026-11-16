import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicPlans} from '../worker/supporter-billing.js';
import {geographicEntitlements,geographicRuleAllowed} from '../worker/supporter-geo.js';

const read=async name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const active=planId=>({status:'active',recognizedPlan:true,planId});

test('only Pro and explicitly enabled custom plans may select municipalities',()=>{
 const plus=geographicEntitlements([active('plus')]);
 assert.equal(plus.prefecture,true);
 assert.equal(plus.municipality,false);
 const pro=geographicEntitlements([active('pro')]);
 assert.equal(pro.prefecture,true);
 assert.equal(pro.municipality,true);
 assert.equal(pro.strictMunicipality,true);
 const customDisabled=geographicEntitlements([{...active('custom'),municipalityBranching:false}]);
 const customEnabled=geographicEntitlements([{...active('custom'),municipalityBranching:true,contentExtraction:false}]);
 assert.equal(customDisabled.municipality,false);
 assert.equal(customEnabled.municipality,true);
 assert.equal(customEnabled.strictMunicipality,false);
 const localRule={prefecture:'01',municipality:'0110000',strictMunicipality:false};
 assert.equal(geographicRuleAllowed(localRule,plus),false);
 assert.equal(geographicRuleAllowed(localRule,pro),true);
 assert.equal(geographicRuleAllowed(localRule,customEnabled),true);
 assert.equal(geographicRuleAllowed({...localRule,strictMunicipality:true},customEnabled),false);
});

test('the user page shows an active plan banner, plan framing and the comparison link',async()=>{
 const [html,js,css]=await Promise.all([read('site/supporter/index.html'),read('site/supporter/app.js'),read('site/supporter/style.css')]);
 for(const id of ['supporter','plus','pro','custom'])assert.match(html,new RegExp('data-plan="'+id+'"'));
 assert.match(html,/id="current-plan-banner"/);
 assert.match(html,/href="\/site\/supporter\/plans\.html"/);
 assert.match(js,/function highlightCurrentPlans/);
 assert.match(js,/highlightCurrentPlans\(subscriptions,customPlan\)/);
 assert.match(js,/is-current-plan/);
 assert.match(js,/municipality:!!custom\?\.municipalityBranching\|\|geographicPlans\.has\('pro'\)/);
 assert.match(js,/市区町村指定を解除する/);
 assert.match(js,/より広い範囲が対象になります/);
 assert.match(css,/\.plans article\.is-current-plan/);
});

test('the admin screen retains frequent operations and expands custom settings on demand',async()=>{
 const [html,js,css]=await Promise.all([read('site/supporter-admin/index.html'),read('site/supporter-admin/app.js'),read('site/supporter-admin/style.css')]);
 assert.match(html,/id="account-search"/);
 assert.match(html,/id="compensation-form"/);
 assert.match(html,/id="refresh-btn"/);
 assert.match(html,/id="custom-open"/);
 assert.match(html,/id="custom-settings-details"/);
 assert.match(html,/href="stats\.html"/);
 assert.ok(html.indexOf('id="accounts-title"')<html.indexOf('id="compensation-title"'));
 assert.ok(html.indexOf('id="compensation-title"')<html.indexOf('id="custom-title"'));
 for(const id of ['custom-complex','custom-city','custom-extract','custom-multi'])assert.match(html,new RegExp('id="'+id+'" type="checkbox" role="switch"'));
 assert.match(html,/id="custom-reuse" type="checkbox"/);
 assert.match(js,/openCustomForAccount/);
 assert.match(js,/syncCustomToggles/);
 assert.match(js,/customRequestId=''/);
 assert.match(css,/\.custom-toggle input\[type="checkbox"\]:checked/);
});

test('comparison page is readable unauthenticated, contracts are still protected',async()=>{
 const [html,js]=await Promise.all([read('site/supporter/plans.html'),read('worker/supporter.js')]);
 for(const plan of publicPlans()){
  assert.match(html,new RegExp(plan.yen.toLocaleString('ja-JP')+'円'));
  assert.ok(html.includes('?plan='+plan.id+'#billing'));
 }
 assert.match(html,/市区町村単位の指定/);
 assert.match(html,/雨雲レーダーの地方別設定/);
 assert.match(html,/カスタムを相談する/);
 assert.match(html,/別途.*二次利用申請/s);
 assert.match(js,/pathname==='\/site\/supporter\/plans\.html'/);
 assert.match(js,/pathname==='\/site\/supporter\/plans\.css'/);
 assert.match(js,/!publicComparison && !supporterPublicEnabled\(env\)/);
});

test('threshold options remain dropdowns, ON/OFF switches use checkboxes',async()=>{
 const js=await read('site/supporter/app.js');
 assert.match(js,/field\(intensityRow, rule, 'intensityMode', '震度の通知条件', options\.thresholdModes\)/);
 assert.match(js,/if\(rule.intensityMode==='threshold'\)/);
 assert.match(js,/field\(magnitudeRow, rule, 'magnitudeMode', 'マグニチュードの通知条件', options\.thresholdModes\)/);
 assert.match(js,/finalCheck\.type='checkbox';finalCheck\.role='switch'/);
});
