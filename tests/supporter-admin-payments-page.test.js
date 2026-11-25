import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('管理画面と統計画面から支払い詳細へ移動できる',async()=>{
 const [index,stats]=await Promise.all([read('../site/supporter-admin/index.html'),read('../site/supporter-admin/stats.html')]);
 assert.match(index,/href="payments\.html"/u);assert.match(stats,/href="payments\.html"/u);
});

test('支払い詳細ページは外部スクリプトを使い必要な区分を表示する',async()=>{
 const [html,script]=await Promise.all([read('../site/supporter-admin/payments.html'),read('../site/supporter-admin/payments.js')]);
 for(const heading of ['支払いの詳細・実行結果','定期処理の実行結果','支払いの失敗・停止','返金・支払異議・不正の警告','メールの送信結果','クレジットチャージ','公式サーバーのロール','運営通知の履歴'])assert.match(html,new RegExp(heading,'u'));
 assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/iu);assert.doesNotMatch(script,/innerHTML/u);
 assert.match(script,/credentials:'same-origin',cache:'no-store'/u);
});

test('空表示・失敗表示と日時・金額を整形する',async()=>{
 const {emptyMessage,requestErrorMessage,formatJst,formatMoney}=await import('../site/supporter-admin/payments.js');
 assert.equal(emptyMessage([]),'該当はありません');assert.equal(emptyMessage([{}]),'');
 assert.equal(requestErrorMessage(401),'支払い情報の取得に失敗しました（HTTP 401）。');
 assert.equal(requestErrorMessage(403),'支払い情報の取得に失敗しました（HTTP 403）。');
 assert.equal(requestErrorMessage(404),'支払い情報の取得に失敗しました（HTTP 404）。');
 assert.equal(requestErrorMessage(500),'支払い情報の取得に失敗しました（HTTP 500）。');
 assert.match(formatJst(0),/1970\/01\/01 9:00:00/u);assert.equal(formatJst(null),'—');
 assert.equal(formatMoney(1234,'JPY'),'￥1,234');assert.equal(formatMoney(null,'JPY'),'￥0');
});
