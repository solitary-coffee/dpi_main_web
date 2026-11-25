import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
 SUPPORTER_REGIONS,WEATHER_LEVELS,WARNING_LEVELS,EARTHQUAKE_DETAILS,EEW_DETAILS,
 EEW_WARNING_AREA_MODES,WEATHER_DETAILS,THRESHOLD_MODES,
 RAIN_RADAR_CONDITIONS,RAIN_RADAR_INTERVALS
} from '../worker/supporter.js';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('current-plan badge is positioned out of text flow and cards retain a shared baseline',async()=>{
 const [css,html,js]=await Promise.all([
  read('site/supporter/style.css'),read('site/supporter/index.html'),read('site/supporter/app.js')
 ]);
 assert.match(css,/\.plan-section \.plans>article\s*\{/);
 assert.match(css,/padding:52px 18px 20px/);
 assert.match(css,/\.plan-section \.plans>article \.current-plan-marker\s*\{\s*position:absolute/);
 assert.match(css,/background:var\(--panel-soft\)/);
 assert.match(html,/data-plan="plus"/);
 assert.match(js,/marker\.textContent='現在利用中'/);
});

test('comparison reuses the existing DPI-Bot sidebar, palette and private dashboard navigation',async()=>{
 const [html,css,theme]=await Promise.all([
  read('site/supporter/plans.html'),read('site/supporter/plans.css'),read('site/reuse/style.css')
 ]);
 assert.match(html,/class="page-container"/);
 assert.match(html,/class="sidebar"/);
 assert.match(html,/class="main-content comparison-main"/);
 assert.match(html,/src="\.\.\/\.\.\/script\.js"/);
 assert.match(html,/href="\/site\/supporter\/\?plan=plus#billing"/);
 assert.match(css,/background:var\(--panel\)/);
 assert.match(css,/border:1px solid var\(--line\)/);
 assert.doesNotMatch(css,/background:#171c25/);
 assert.match(theme,/--bg:#444950/);
});

test('prefecture and Hokkaido shinko-kyoku-equivalent detail share one row',async()=>{
 const html=await read('site/supporter/plans.html');
 assert.match(html,/<th scope="row">都道府県(?:<a[^>]*>※<\/a>)?<\/th>/);
 assert.doesNotMatch(html,/<th scope="row">北海道内の地方区分<\/th>/);
 assert.match(html,/行政上の振興局区分との完全一致を保証するものではありません/);
 // 選択前の案内は、実際の料金・停止・解約・地域の仕様と一致する
 const notes=html.slice(html.indexOf('id="comparison-notes-heading"'),html.indexOf('dpi-public-footer:start'));
 for(const text of ['毎月26日','2か月分','月末に1回再請求','翌月1日0時に配信を停止','停止から1か月で自動的に解約','チャンネル3件・サーバー2件・ルール3件','次回26日から反映し、返金はありません','一覧の下から順に削除','緊急地震速報は都道府県まで','ウェブフックの管理','二次利用申請','/terms/Specified.html'])assert.ok(notes.includes(text),text);
});

test('radar rates and rainfall conditions reflect current selectable Worker values',async()=>{
 const html=await read('site/supporter/plans.html');
 assert.deepEqual(RAIN_RADAR_INTERVALS.map(([id])=>id),['1','2','3','6','12','24']);
 assert.deepEqual(RAIN_RADAR_CONDITIONS.map(([id])=>id),['all','rain-detected','rainfall-threshold']);
 assert.match(html,/1・2・3・6・12・24時間ごと/);
 assert.match(html,/0\.1～20 mm\/h/);
 assert.match(html,/<th scope="row">配信頻度・降雨検知(?:<a[^>]*>※<\/a>)?<\/th>/);
 assert.match(html,/<th scope="row">降水量のしきい値(?:<a[^>]*>※<\/a>)?<\/th><td>—<\/td><td>○<\/td>/);
 assert.match(html,/雨雲レーダー（簡略版）/);
 // 雨雲レーダー（簡略版）は画像配信の表にある
 assert.ok(html.indexOf('>雨雲レーダー（簡略版）<a class="detail-ref"')>html.indexOf('<h3 class="comparison-subtitle">画像配信</h3>'));
 assert.match(html,/<h3 class="comparison-subtitle">テキスト配信<\/h3>/);
});

test('comparison describes the actual selectable earthquake, EEW and weather types',async()=>{
 const html=await read('site/supporter/plans.html');
 for(const id of ['intensity-flash','hypocenter','hypocenter-intensity','long-period','distant-earthquake']){
  assert.ok(EARTHQUAKE_DETAILS.some(([key])=>key===id),id);
 }
 for(const id of ['forecast','warning'])assert.ok(EEW_DETAILS.some(([key])=>key===id),id);
 for(const id of ['tornado','typhoon','designated-river','heatstroke','linear-rainband']){
  assert.ok(WEATHER_DETAILS.some(([key])=>key===id),id);
 }
 for(const label of ['震度速報','長周期地震動','地震動予報','気象情報','台風情報','指定河川洪水予報','雨雲レーダー']){
  assert.ok(html.includes(label),label);
 }
 assert.match(html,/class="comparison-table comparison-table-grouped"/);
 assert.match(html,/カスタムを相談する/);
});

test('comparison detail references resolve and list the Worker choices',async()=>{
 const [html,css,script]=await Promise.all([
  read('site/supporter/plans.html'),read('site/supporter/plans.css'),read('site/supporter/plans-previews.js')
 ]);
 const documentIds=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
 const detailIds=[...html.matchAll(/<details\b[^>]*\sid="([^"]+)"[^>]*>/g)].map(match=>match[1]);
 assert.equal(new Set(detailIds).size,detailIds.length,'details id must be unique');
 const references=[...html.matchAll(/<a class="detail-ref" href="#([^"]+)"/g)].map(match=>match[1]);
 // ※は、選べる内容を見たい所だけ（すべての行には付けない）
 assert.equal(references.length,13);
 assert.deepEqual([...html.matchAll(/<th scope="row">([^<]*)<a class="detail-ref"/g)].map(match=>match[1]),['情報の種類の選択','情報の種類の選択']);
 assert.equal((html.match(/href="#text-area-detail"/g)||[]).length,4);
 for(const target of references)assert.ok(documentIds.includes(target),target);
 const detail=id=>html.match(new RegExp(`<details\\b[^>]*\\sid="${id}"[^>]*>[\\s\\S]*?</details>`))?.[0]||'';
 const earthquake=detail('text-earthquake-detail');
 const forecast=detail('text-eew-forecast-detail');
 const warning=detail('text-eew-warning-detail');
 const weather=detail('text-weather-detail');
 const area=detail('text-area-detail');
 for(const label of EARTHQUAKE_DETAILS.map(([,label])=>label))assert.ok(earthquake.includes(label),label);
 for(const label of EEW_DETAILS.map(([,label])=>label))assert.ok((forecast+warning).includes(label),label);
 for(const label of WEATHER_DETAILS.map(([,label])=>label))assert.ok(weather.includes(label),label);
 for(const label of THRESHOLD_MODES.map(([,label])=>label))assert.ok(earthquake.includes(label)&&forecast.includes(label)&&warning.includes(label),label);
 for(const label of EEW_WARNING_AREA_MODES.map(([,label])=>label))assert.ok(warning.includes(label),label);
 for(const label of [...WEATHER_LEVELS,...WARNING_LEVELS].map(([,label])=>label))assert.ok(weather.includes(label),label);
 for(const label of SUPPORTER_REGIONS.map(([,label])=>label))assert.ok(area.includes(label),label);
 assert.doesNotMatch(forecast,/警報の対象地方/);
 assert.match(script,/target\.open = true/);
 assert.match(script,/addEventListener\('hashchange', openHashDetail\)/);
 assert.match(script,/source\.focus\(\{preventScroll: true\}\)/);
 assert.match(css,/\.delivery-category\{[^}]*scroll-margin-top:/);
 assert.match(css,/\.detail-ref:focus-visible/);
});


test('new add-on presentation and weather list reflect the revised contract',async()=>{
 const [html,home]=await Promise.all([read('site/supporter/plans.html'),read('site/supporter/index.html')]);
 assert.match(html,/追加（チャンネル3・サーバー2・ルール3）/);
 assert.match(html,/今後も随時追加予定/);
 assert.match(home,/サーバー上限を2件追加/);
 assert.match(home,/通知ルール上限を3件追加/);
 const weather=html.slice(html.indexOf('<summary>気象情報'),html.indexOf('</details>',html.indexOf('<summary>気象情報')));
 assert.match(weather,/<li>大雨に関する警戒レベル情報<\/li>/);
 assert.match(weather,/<li>台風情報<\/li>/);
 assert.match(weather,/<li>気象解説情報（潮位）<\/li>/);
 assert.ok((weather.match(/<li>/g)||[]).length>=19);
});

test('規約・ポリシー・特商法は、番号ごとに段落が分かれる（1行にまとまって表示されない）',async()=>{
 for(const file of ['terms/terms.md','terms/policy.md','terms/spec.md']){
  const lines=(await read(file)).replace(/\r\n/g,'\n').split('\n');
  lines.forEach((line,index)=>{
   if(!/^(?:\d+[.．]|・\d{4}年)/.test(line)||index===0)return;
   const before=lines[index-1];
   assert.ok(!before.trim()||before.startsWith('#'),`${file}:${index+1} ${line.slice(0,20)}`);
  });
 }
});

test('カスタムは Basic の機能を必ず含み、未払いでも停止までは機能を保つ',async()=>{
 const {planFeatures,PLAN_FEATURE_NAMES}=await import('../site/supporter/plan-features.js');
 const custom=status=>planFeatures([{status,recognizedPlan:true,planId:'custom',managedCustom:true,customFeatures:['weatherMap']}]);
 for(const status of ['active','trialing','past_due','unpaid','paused']){
  assert.equal(custom(status).weatherMap,true,status);
  for(const name of PLAN_FEATURE_NAMES.supporter)assert.equal(custom(status)[name],true,`${status} ${name}`);
 }
 assert.equal(custom('canceled').eewMap,false);
});
