import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { supporterStats } from '../site/supporter-admin/stats-logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminDirectory = path.join(root, 'site/supporter-admin');

function sidebar(html) {
 return html.match(/<nav class="sidebar" aria-label="管理メニュー">[\s\S]*?<\/nav>/u)?.[0]
  .replace(/>\s+</gu, '><');
}

test('有料プラン管理画面はすべて同じ管理者用左メニューを使用する', async () => {
 const files = (await readdir(adminDirectory)).filter(name => name.endsWith('.html')).sort();
 const indexHtml = await readFile(path.join(adminDirectory, 'index.html'), 'utf8');
 const expected = sidebar(indexHtml);
 assert.ok(expected);

 for (const name of files) {
  const html = await readFile(path.join(adminDirectory, name), 'utf8');
  const actual = sidebar(html);
  assert.equal(actual, expected, name);
  assert.match(actual, />統合管理センター</u, name);
  assert.match(actual, /class="active" aria-current="page">有料プラン管理</u, name);
  assert.doesNotMatch(actual, />配信内容</u, name);
  assert.doesNotMatch(actual, />BOTを招待</u, name);
  assert.match(html, /<script src="\.\.\/\.\.\/script\.js"><\/script>/u, name);
 }
});

test('公開メニュー同期の除外対象と有料プラン管理画面が一致する', async () => {
 const files = (await readdir(adminDirectory)).filter(name => name.endsWith('.html')).sort();
 const script = await readFile(path.join(root, 'scripts/sync-public-sidebar.mjs'), 'utf8');

 for (const name of files) {
  const html = await readFile(path.join(adminDirectory, name), 'utf8');
  if (!/<body class="admin-shell">/u.test(html)) continue;
  assert.match(script, new RegExp(`['"]site/supporter-admin/${name.replaceAll('.', '\\.') }['"]`, 'u'), name);
 }
});

test('統計は標準プランとカスタム契約だけを有効契約として集計する', () => {
 const accounts = [{
  subscriptions: [
   {status: 'active', recognizedPlan: true, planId: 'supporter', amount: 300},
   {status: 'trialing', recognizedPlan: true, planId: 'plus', amount: 800},
   {status: 'past_due', recognizedPlan: true, planId: 'pro', amount: 1500},
   {status: 'active', recognizedPlan: false, customId: 'custom_1', amount: 2400},
   {status: 'canceled', recognizedPlan: false, customId: 'custom_2', amount: 2000},
   {status: 'active', recognizedPlan: false, amount: 999},
  ],
 }];

 const result = supporterStats(accounts);
 assert.equal(result.active.length, 4);
 assert.deepEqual(result.planCounts, {supporter: 1, plus: 1, pro: 1, custom: 1});
 assert.equal(result.monthlyAmount, 5000);
});
