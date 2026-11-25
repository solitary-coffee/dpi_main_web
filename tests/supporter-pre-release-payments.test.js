import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('正式リリース前の案内はJSなしでも両画面と支払い欄に表示される', async () => {
 const [index, plans, app, style] = await Promise.all([
  read('../site/supporter/index.html'), read('../site/supporter/plans.html'),
  read('../site/supporter/app.js'), read('../site/supporter/style.css'),
 ]);
 for(const html of [index, plans]){
  assert.match(html, /<!-- 正式リリース前の案内（正式リリース時に外す） -->/);
  assert.match(html, /class="pre-release-notice"/);
  assert.match(html, /有料プランは正式リリース前です/);
  assert.match(html, /当方の故意または重大な過失/);
 }
 assert.match(index, /id="billing"[\s\S]*?class="pre-release-notice"[\s\S]*?原則として補填はありません[\s\S]*?\/terms\/terms\.html/);
 assert.equal((app.match(/className='(?:credit-consent|legal-consent) pre-release-notice'/g)||[]).length, 3);
 assert.match(style, /\.pre-release-notice\{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
});

test('規約と画面は正式リリース前の補填例外および入金後付与を明記する', async () => {
 const [terms, spec, app] = await Promise.all([
  read('../terms/terms.md'), read('../terms/spec.md'), read('../site/supporter/app.js'),
 ]);
 assert.match(terms, /5\.第7項の期間を除き/);
 assert.match(terms, /7\.正式リリースまでの間[\s\S]*当方の故意または重大な過失[\s\S]*二重請求[\s\S]*法令上返金もしくは賠償/);
 assert.match(terms, /10\.銀行振込またはコンビニ払い[\s\S]*入金を確認した後にクレジットを付与/);
 for(const text of ['クレジットチャージでのみ選択','支払期限はStripeの画面','振込手数料は利用者の負担','入金額に過不足','付与した日（入金の確認日）から1年間'])assert.match(spec,new RegExp(text));
 assert.match(app, /銀行振込・コンビニ払いは、入金の確認後にクレジットを付与します（確認まで利用できません）。/);
 assert.match(app, /pending:'入金・決済の確認待ち'/);
 assert.match(app, /hasPendingTopup[\s\S]*status==='pending'/);
});
