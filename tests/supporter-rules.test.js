import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupporterRules, SUPPORTER_REGIONS, WEATHER_LEVELS } from '../worker/supporter.js';

const guilds = [{id:'12345678901234567',name:'DPI Test'}];
const base = {name:'北海道の大雨',guildId:guilds[0].id,channelId:'98765432109876543',type:'weather',region:'hokkaido'};

test('気象庁の主要地方区分と2026年の警戒レベルを提供する', () => {
 assert.deepEqual(SUPPORTER_REGIONS.map(([id])=>id), [
  'all','hokkaido','tohoku','kanto-koshin','hokuriku','tokai','kinki','chugoku','shikoku','kyushu-north','kyushu-south-amami','okinawa',
 ]);
 assert.deepEqual(WEATHER_LEVELS.map(([id])=>id), ['all','1','2','3','4','5']);
});

test('気象ルールは地方と警戒レベルを正規化して保存する', () => {
 assert.deepEqual(normalizeSupporterRules([{...base,weatherLevel:'3'}],guilds), [{
  name:'北海道の大雨',guildId:guilds[0].id,channelId:'98765432109876543',type:'weather',region:'hokkaido',intensity:'',weatherLevel:'3',
 }]);
});

test('既存の気象ルールは警戒レベル未設定ならすべてとして扱う', () => {
 assert.equal(normalizeSupporterRules([base],guilds)[0].weatherLevel,'all');
});

test('地震ルールは震度を保持し気象レベルを保存しない', () => {
 const rule={...base,type:'earthquake',name:'関東の地震',region:'kanto-koshin',intensity:'5-'};
 assert.equal(normalizeSupporterRules([rule],guilds)[0].intensity,'5-');
 assert.equal(normalizeSupporterRules([rule],guilds)[0].weatherLevel,'');
});

test('未定義の地方・警戒レベルと管理権限のないサーバーを拒否する', () => {
 assert.throws(()=>normalizeSupporterRules([{...base,region:'unknown'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,weatherLevel:'6'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,guildId:'11111111111111111'}],guilds));
});
