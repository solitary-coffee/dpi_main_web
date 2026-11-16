import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
 EARTHQUAKE_DETAILS,EEW_DETAILS,WEATHER_DETAILS,
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
 assert.match(html,/都道府県単位の指定（北海道は振興局相当の地方区分も選択可能）/);
 assert.doesNotMatch(html,/<th scope="row">北海道内の地方区分<\/th>/);
 assert.match(html,/行政上の振興局区分との完全一致を保証するものではありません/);
});

test('radar rates and rainfall conditions reflect current selectable Worker values',async()=>{
 const html=await read('site/supporter/plans.html');
 assert.deepEqual(RAIN_RADAR_INTERVALS.map(([id])=>id),['1','2','3','6','12','24']);
 assert.deepEqual(RAIN_RADAR_CONDITIONS.map(([id])=>id),['all','rain-detected','rainfall-threshold']);
 assert.match(html,/1・2・3・6・12・24時間ごと/);
 assert.match(html,/0\.1～20 mm\/h/);
 assert.match(html,/定時更新／降雨検知／降水量の閾値以上/);
 assert.match(html,/雨雲レーダー（地方単位）/);
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
 assert.match(html,/class="comparison-table"/);
 assert.match(html,/カスタムを相談する/);
});
