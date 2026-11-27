import test from 'node:test';
import assert from 'node:assert/strict';
import {findRuleTargetMismatches,imageRuleTargetSummary,nextCheckboxSelection,normalizeWarningTableSelection} from '../site/supporter/rule-targets.js';
import {normalizeSupporterRules} from '../worker/supporter.js';
import {reconcileRulesForLimits} from '../worker/supporter-billing.js';
import {planFeatures} from '../site/supporter/plan-features.js';

const GUILD='12345678901234567';
const CHANNEL='98765432109876543';
const guilds=[{id:GUILD,name:'DPI Test'}];
const limits={servers:5,channels:20,rules:30,complexConditions:true,multiDestination:true,...planFeatures([{status:'active',recognizedPlan:true,planId:'pro'}])};
const base={guildId:GUILD,channelId:CHANNEL,channelIds:[CHANNEL],type:'warning-table',deliverOn:'changed',showAllAreas:false};

test('表の対象を短い見出しとして表示する',()=>{
 assert.equal(imageRuleTargetSummary({...base,tables:['regional'],regions:['hokkaido']}),'地方の表：北海道');
 assert.equal(imageRuleTargetSummary({...base,tables:['national'],regions:[]}),'全国の表');
 assert.equal(imageRuleTargetSummary({...base,tables:['national','regional'],regions:['tohoku','kinki']}),'全国の表／地方の表：東北・近畿');
});

test('全国の表だけへ切り替えたら画面側でも不要な地方を残さない',()=>{
 assert.deepEqual(normalizeWarningTableSelection(['national'],['shikoku']),{tables:['national'],regions:[]});
 assert.deepEqual(normalizeWarningTableSelection(['regional'],['shikoku']),{tables:['regional'],regions:['shikoku']});
});

test('チェックボックスの連続変更は別ルールの選択配列を変更しない',()=>{
 const second=['kinki'];
 let first=['tohoku'];
 first=nextCheckboxSelection(first,'hokkaido',true);
 first=nextCheckboxSelection(first,'tohoku',false);
 assert.deepEqual(first,['hokkaido']);
 assert.deepEqual(second,['kinki']);
});

test('名前が示す地方と表の選択が違うルールだけを確認対象にする',()=>{
 const mismatches=findRuleTargetMismatches([
  {...base,name:'警報　北海道',tables:['regional'],regions:['tohoku']},
  {...base,name:'東北地方',tables:['regional'],regions:['tohoku','kinki']},
  {...base,name:'四国地方',tables:['national'],regions:[]},
  {...base,name:'北海道・東北',tables:['regional'],regions:['kinki']},
  {...base,name:'警報一覧',tables:['regional'],regions:['kinki']},
  {...base,name:'北海道地方',tables:['regional'],regions:['hokkaido']},
 ]);
 assert.deepEqual(mismatches.map(item=>item.name),['警報　北海道','東北地方','四国地方']);
 assert.deepEqual(mismatches.map(item=>item.selection),['地方の表：東北','地方の表：東北・近畿','全国の表']);
});

test('保存正規化で表と地方が別ルールへ移動・混在しない',()=>{
 const input=[
  {...base,name:'北海道',tables:['regional'],regions:['hokkaido']},
  {...base,name:'東北地方',tables:['regional'],regions:['tohoku','kinki']},
  {...base,name:'四国地方',tables:['national'],regions:['shikoku']},
 ];
 const normalized=normalizeSupporterRules(input,guilds,limits,null,{imageRules:true,imageRulesV2:true});
 assert.deepEqual(normalized.map(rule=>({name:rule.name,tables:rule.tables,regions:rule.regions})),[
  {name:'北海道',tables:['regional'],regions:['hokkaido']},
  {name:'東北地方',tables:['regional'],regions:['tohoku','kinki']},
  {name:'四国地方',tables:['national'],regions:[]},
 ]);
});

test('契約上限の自動調整は残すルールの表と地方を組み替えない',()=>{
 const rules=[
  {...base,name:'北海道',tables:['regional'],regions:['hokkaido']},
  {...base,name:'東北',tables:['regional'],regions:['tohoku']},
  {...base,name:'近畿',tables:['regional'],regions:['kinki']},
 ];
 const adjusted=reconcileRulesForLimits(JSON.stringify({rules}),{servers:1,channels:20,rules:2,complexConditions:true,multiDestination:true});
 assert.deepEqual(adjusted.rules.map(rule=>({name:rule.name,tables:rule.tables,regions:rule.regions})),[
  {name:'北海道',tables:['regional'],regions:['hokkaido']},
  {name:'東北',tables:['regional'],regions:['tohoku']},
 ]);
});
