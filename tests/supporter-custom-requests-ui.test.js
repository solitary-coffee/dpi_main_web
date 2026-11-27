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
  assert.match(customer,/カスタムプランの申請/);
 assert.match(customerScript,/\/api\/supporter\/custom-requests/);
 assert.match(customerScript,/x-reuse-csrf/);
  assert.match(admin,/カスタムプラン申請管理/);
 assert.match(adminScript,/\/site\/supporter-admin\/api\/custom-requests/);
});

test('申請の機能一覧はFEATURE_DEFINITIONSを単一の定義元にする',async()=>{
 const source=await read('../site/supporter/custom/custom.js');
 assert.ok(FEATURE_DEFINITIONS.length>0);
 assert.match(source,/import \{FEATURE_DEFINITIONS, FEATURE_SECTIONS(, featureLabel)?\} from '\.\.\/plan-features\.js'/);
 assert.match(source,/\.\.\.FEATURE_DEFINITIONS/);
 for(const feature of FEATURE_DEFINITIONS)assert.equal(typeof feature.name,'string');
});

test('印刷で申請欄と確認欄をページ途中で切らない',async()=>{
 const [customerCss,adminCss]=await Promise.all([read('../site/supporter/custom/custom.css'),read('../site/supporter-admin/custom-requests.css')]);
 for(const css of [customerCss,adminCss]){assert.match(css,/@media print/);assert.match(css,/break-inside:avoid/);assert.match(css,/@page\{size:A4/);}
});

test('利用者向けの印刷は選択した申請1件のA4書類を生成する',async()=>{
 const [html,js,css]=await Promise.all([read('../site/supporter/custom/index.html'),read('../site/supporter/custom/custom.js'),read('../site/supporter/custom/custom.css')]);
 assert.match(html,/id="print-document" class="print-document"/);
 assert.match(html,/id="print-request"/);
 assert.match(html,/PDFで保存（印刷）/);
 assert.match(js,/カスタムプラン 申請書（控え）/);
 assert.match(js,/function buildPrintDocument\(item\)/);
 assert.match(js,/allDefinitions\(\)/);
 assert.match(js,/この書類は控えです。契約・請求は運営が確定するまで発生しません。/);
 assert.match(css,/@page\{size:A4 portrait;margin:15mm\}/);
 assert.match(css,/@media print/);
 assert.match(css,/body>\*:not\(\.print-document\)\{display:none!important\}/);
 assert.match(css,/\.print-document\{display:block!important/);
 assert.match(css,/thead\{display:table-header-group\}/);
 assert.doesNotMatch(js,/innerHTML/);
});

test('カスタム申請リンクは公開APIが明示的に有効な場合だけ表示する',async()=>{
 const [page,dashboard,gate,app]=await Promise.all([read('../site/supporter/plans.html'),read('../site/supporter/index.html'),read('../site/supporter/plans-previews.js'),read('../site/supporter/app.js')]);
 for(const html of [page,dashboard])assert.match(html,/href="\/site\/supporter\/custom\/" data-feature-gate="customRequests" hidden/);
 assert.match(gate,/flags\?\.customRequests\?\.enabled !== true\) return;/);
 assert.match(app,/flags\.customRequests\?\.enabled===true/);
 assert.match(gate,/data-feature-gate="customRequests"/);
});


test('管理画面の申請は、準備中の機能を識別名のまま表示しない',async()=>{
 const js=await read('../site/supporter-admin/custom-requests.js');
 assert.doesNotMatch(js,/label:name\b/);
 assert.match(js,/plannedItems/);
 assert.match(js,/custom:'準備中'/);
});

test('有料プラン管理の各画面で左メニューを申請管理として案内する',async()=>{
 const pages=await Promise.all(['index.html','custom-requests.html','payments.html','stats.html'].map(file=>read(`../site/supporter-admin/${file}`)));
 for(const page of pages)assert.match(page,/href="\/site\/supporter-admin\/"[^>]*>有料プラン・申請管理<\/a>/);
});
