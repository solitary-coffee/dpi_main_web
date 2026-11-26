import test from 'node:test';
import assert from 'node:assert/strict';
import {mailSignatureHtml,mailSignatureText} from '../worker/mail-signature.js';
import {__test as newsletterTest} from '../worker/newsletter.js';
import {__test as reuseTest} from '../worker/reuse.js';
import {supporterMailSignature} from '../worker/supporter-billing.js';

test('newsletter・reuse・有料プランの署名は共通部分を含み、有料プランだけ追加行を含む',()=>{
 const signatures=[newsletterTest.emailSignatureText(),reuseTest.reuseEmailSignature(),supporterMailSignature()];
 for(const signature of signatures){
  assert.match(signature,/^----------------------------------------\nDPI-Bot 運営/u);
  assert.match(signature,/公式サイト: https:\/\/dpi-bot\.com\//u);
  assert.match(signature,/公式サポートサーバー: https:\/\/discord\.gg\/qFuZcGUb4K/u);
  assert.match(signature,/お問い合わせ: support@dpi-bot\.com/u);
  assert.match(signature,/© 2026 DPI-Bot$/u);
 }
 for(const signature of signatures.slice(0,2))assert.doesNotMatch(signature,/契約・支払い方法の管理/u);
 assert.match(signatures[2],/契約・支払い方法の管理: https:\/\/dpi-bot\.com\/site\/supporter\//u);
 assert.match(signatures[2],/利用規約・特定商取引法に基づく表記/u);
 assert.match(signatures[2],/配信停止の設定にかかわらず/u);
 assert.equal(mailSignatureText(),signatures[0]);
});

test('共通HTML署名は追加行をエスケープしURLだけをリンクにする',()=>{
 const html=mailSignatureHtml({extraLines:['危険<script>: https://example.com/a?x=1&y=2',`引用"' <b>`]});
 assert.doesNotMatch(html,/<script>|<b>/u);
 assert.match(html,/危険&lt;script&gt;:/u);
 assert.match(html,/<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">https:\/\/example\.com\/a\?x=1&amp;y=2<\/a>/u);
 assert.match(html,/引用&quot;&#39; &lt;b&gt;/u);
});
