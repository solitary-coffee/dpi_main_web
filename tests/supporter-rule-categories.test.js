// 設定画面の大枠（2026-11-27）：大枠 → 種類 → 設定。準備中は選べない
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, categoryOf, typeChoices } from '../site/supporter/rule-categories.js';

const CURRENT = ['earthquake', 'eew', 'weather', 'rain-radar', 'hires-radar', 'tsunami-map', 'weather-map', 'earthquake-map',
 'eew-map', 'warning-table', 'warning-timeseries'];

test('今ある種類はすべてどこかの大枠に入る', () => {
 const all = CATEGORIES.flatMap(c => c.types.map(([value]) => value));
 for (const type of CURRENT) assert.ok(all.includes(type), type);
 assert.equal(CATEGORIES.length, 6);
 assert.deepEqual(CATEGORIES.map(c => c.name), ['緊急地震速報', '地震・津波関連', '気象警報・注意報関連', '気象情報関連', '火山関連', '気象関連（その他）']);
});

test('categoryOf は種類から大枠を求める', () => {
 assert.equal(categoryOf('eew-map'), 'eew');
 assert.equal(categoryOf('tsunami-map'), 'earthquake');
 assert.equal(categoryOf('warning-timeseries'), 'warning');
 assert.equal(categoryOf('hires-radar'), 'radar');
});

test('準備中は選べず、今の画面に無い種類は出ない', () => {
 const available = [['earthquake', '地震情報']];
 const choices = typeChoices('earthquake', available);
 assert.deepEqual(choices.filter(c => !c[2]).map(c => c[0]), ['earthquake']);         // earthquake-map・tsunami-map は無い
 assert.ok(choices.some(([value, , disabled]) => value === 'pending:estimated-intensity' && disabled));
 assert.ok(typeChoices('volcano', available).every(([, , disabled]) => disabled));     // 火山関連はすべて準備中
 assert.ok(typeChoices('volcano', available).every(([value]) => value.startsWith('pending:')));
});
