import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FEATURE_DEFINITIONS} from '../site/supporter/plan-features.js';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('カスタムプランの利用者ページと管理ページがある',async()=>{
 const [customer,customerScript,admin,adminScript]=await Promise.all([
  read('../site/supporter/custom/index.html'),read('../site/supporter/custom/custom.js'),
  read('../site/supporter-admin/custom-requests.html'),read('../site/supporter-admin/custom-requests.js'),
 ]);
 assert.match(customer,/カスタムプランのご要望/);
 assert.match(customerScript,/\/api\/supporter\/custom-requests/);
 assert.match(customerScript,/x-reuse-csrf/);
 assert.match(admin,/カスタムプランご要望管理/);
 assert.match(adminScript,/\/site\/supporter-admin\/api\/custom-requests/);
});

test('ご要望の機能一覧はFEATURE_DEFINITIONSを単一の定義元にする',async()=>{
 const source=await read('../site/supporter/custom/custom.js');
 assert.ok(FEATURE_DEFINITIONS.length>0);
 assert.match(source,/import \{FEATURE_DEFINITIONS, FEATURE_SECTIONS\} from '\.\.\/plan-features\.js'/);
 assert.match(source,/\.\.\.FEATURE_DEFINITIONS/);
 for(const feature of FEATURE_DEFINITIONS)assert.equal(typeof feature.name,'string');
});

test('印刷でご要望欄と確認欄をページ途中で切らない',async()=>{
 const [customerCss,adminCss]=await Promise.all([read('../site/supporter/custom/custom.css'),read('../site/supporter-admin/custom-requests.css')]);
 for(const css of [customerCss,adminCss]){assert.match(css,/@media print/);assert.match(css,/break-inside:avoid/);assert.match(css,/@page\{size:A4/);}
});

test('カスタムご要望リンクは公開APIが明示的に有効な場合だけ表示する',async()=>{
 const [page,gate]=await Promise.all([read('../site/supporter/plans.html'),read('../site/supporter/plans-previews.js')]);
 assert.match(page,/href="\/site\/supporter\/custom\/" data-feature-gate="customRequests" hidden/);
 assert.match(gate,/flags\?\.customRequests\?\.enabled !== true\) return;/);
 assert.match(gate,/data-feature-gate="customRequests"/);
});


test('管理画面のご要望は、準備中の機能を識別名のまま表示しない',async()=>{
 const js=await read('../site/supporter-admin/custom-requests.js');
 assert.doesNotMatch(js,/label:name\b/);
 assert.match(js,/plannedItems/);
 assert.match(js,/custom:'準備中'/);
});
