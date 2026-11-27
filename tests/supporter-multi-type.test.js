// Pro の情報種別の複数選択（2026-11-27）：同じ送信先のルールを groupId でまとめる。Pro 以上だけ
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSupporterRules} from '../worker/supporter.js';

const guildId = '123456789012345678', channel = '223456789012345678';
const base = {name: '警報と速報', guildId, channelId: channel, channelIds: [channel]};
const pair = groupId => [{...base, groupId, type: 'weather', detail: 'all', region: 'all'}, {...base, groupId, type: 'eew', detail: 'all', region: 'all'}];
const plus = {servers: 3, channels: 10, rules: 15, complexConditions: false, multiDestination: false};
const pro = {servers: 5, channels: 20, rules: 30, complexConditions: true, multiDestination: true};

test('Pro は同じグループの複数の情報種別を保存でき、groupId が残る', () => {
 const saved = normalizeSupporterRules(pair('g-1'), [{id: guildId}], pro);
 assert.equal(saved.length, 2);
 assert.deepEqual(saved.map(r => [r.type, r.groupId]), [['weather', 'g-1'], ['eew', 'g-1']]);
 assert.deepEqual(saved.map(r => r.channelIds), [[channel], [channel]]);
});

test('Plus 以下は同じグループに 2 つ以上を入れられない', () => {
 assert.throws(() => normalizeSupporterRules(pair('g-1'), [{id: guildId}], plus), /Pro 以上/);
 const single = normalizeSupporterRules([{...base, groupId: 'g-2', type: 'weather', detail: 'all', region: 'all'}], [{id: guildId}], plus);
 assert.equal(single.length, 1);   // 1 つだけなら今までどおり保存できる
});

test('不正な groupId は捨てる（グループにしない）', () => {
 const saved = normalizeSupporterRules([{...base, groupId: '<script>', type: 'weather', detail: 'all', region: 'all'}], [{id: guildId}], plus);
 assert.equal(saved[0].groupId, undefined);
});
