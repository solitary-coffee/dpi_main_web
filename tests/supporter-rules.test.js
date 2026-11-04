import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupporterRules, SUPPORTER_REGIONS, WEATHER_LEVELS, WEATHER_DETAILS, EARTHQUAKE_DETAILS, EEW_DETAILS } from '../worker/supporter.js';

const guilds = [{id:'12345678901234567',name:'DPI Test'}];
const base = {name:'北海道の大雨',guildId:guilds[0].id,channelId:'98765432109876543',type:'weather',region:'hokkaido'};

test('地方区分、警戒レベル、詳細情報種別を提供する', () => {
 assert.deepEqual(SUPPORTER_REGIONS.map(([id])=>id), [
  'all','hokkaido','tohoku','kanto-koshin','hokuriku','tokai','kinki','chugoku','shikoku','kyushu-north','kyushu-south-amami','okinawa',
 ]);
 assert.deepEqual(WEATHER_LEVELS.map(([id])=>id), ['all','1','2','3','4','5']);
 assert.ok(WEATHER_DETAILS.some(([id])=>id==='heavy-rain-level'));
 assert.ok(WEATHER_DETAILS.some(([id])=>id==='landslide-level'));
 assert.ok(EARTHQUAKE_DETAILS.some(([id])=>id==='intensity-flash'));
 assert.ok(EEW_DETAILS.some(([id])=>id==='forecast'));
 assert.ok(EEW_DETAILS.some(([id])=>id==='warning'));
});

test('大雨ルールは地方と警戒レベルを正規化して保存する', () => {
 const normalized=normalizeSupporterRules([{...base,detail:'heavy-rain-level',weatherLevel:'3'}],guilds)[0];
 assert.equal(normalized.detail,'heavy-rain-level');
 assert.equal(normalized.weatherLevel,'3');
 assert.equal(normalized.warningLevel,'');
 assert.equal(normalized.intensity,'');
});

test('警報・注意報系だけ警報条件を保存する', () => {
 const normalized=normalizeSupporterRules([{...base,detail:'wave-warning',warningLevel:'warning'}],guilds)[0];
 assert.equal(normalized.warningLevel,'warning');
 assert.equal(normalized.weatherLevel,'');
});

test('既存ルールは詳細未設定ならすべてとして扱う', () => {
 const normalized=normalizeSupporterRules([base],guilds)[0];
 assert.equal(normalized.detail,'all');
 assert.equal(normalized.weatherLevel,'');
});

test('地震ルールは震度、上下変化、マグニチュード範囲を保持する', () => {
 const rule={...base,type:'earthquake',name:'関東の地震',detail:'intensity-flash',region:'kanto-koshin',intensity:'5-',intensityChange:'increase',magnitudeMin:'5.2',magnitudeMax:7,magnitudeChange:'decrease'};
 const normalized=normalizeSupporterRules([rule],guilds)[0];
 assert.equal(normalized.intensity,'5-');
 assert.equal(normalized.intensityChange,'increase');
 assert.equal(normalized.magnitudeMin,5.2);
 assert.equal(normalized.magnitudeMax,7);
 assert.equal(normalized.magnitudeChange,'decrease');
 assert.equal(normalized.weatherLevel,'');
});

test('不正な詳細条件、範囲、地方、サーバーを拒否する', () => {
 assert.throws(()=>normalizeSupporterRules([{...base,region:'unknown'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,detail:'heavy-rain-level',weatherLevel:'6'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,detail:'not-defined'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,type:'earthquake',intensity:'4',magnitudeMin:8,magnitudeMax:7}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,type:'earthquake',intensity:'4',magnitudeMin:11}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,guildId:'11111111111111111'}],guilds));
});
