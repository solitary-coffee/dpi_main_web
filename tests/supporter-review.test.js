import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSupporterRequest } from '../worker/supporter.js';
import { reviewAccessConfigured, reviewCookie, reviewCookieValid } from '../worker/supporter-review.js';

const PASSWORD = 'correct-horse-battery';
const baseEnv = () => ({
 SUPPORTER_PUBLIC_ENABLED: 'false',
 SUPPORTER_REVIEW_USER: 'reviewer',
 SUPPORTER_REVIEW_PASSWORD: PASSWORD,
 ASSETS: {fetch: () => new Response('<html>plans</html>', {headers: {'content-type': 'text/html'}})},
});
const basic = (user, password) => 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${password}`)));
const page = headers => new Request('https://dpi-bot.com/site/supporter/', {headers});

test('審査用の認証は、ユーザー名と12文字以上のパスワードがそろったときだけ有効', () => {
 assert.equal(reviewAccessConfigured({}), false);
 assert.equal(reviewAccessConfigured({SUPPORTER_REVIEW_USER: 'a', SUPPORTER_REVIEW_PASSWORD: 'short'}), false);
 assert.equal(reviewAccessConfigured(baseEnv()), true);
});

test('未設定なら従来どおり 404（パスワード入力も出さない）', async () => {
 const env = {...baseEnv(), SUPPORTER_REVIEW_USER: '', SUPPORTER_REVIEW_PASSWORD: ''};
 const response = await handleSupporterRequest(page({}), env);
 assert.equal(response.status, 404);
 assert.equal(response.headers.get('WWW-Authenticate'), null);
});

test('設定済みなら未認証の閲覧にはユーザー名・パスワードを求める', async () => {
 const response = await handleSupporterRequest(page({}), baseEnv());
 assert.equal(response.status, 401);
 assert.match(response.headers.get('WWW-Authenticate'), /^Basic realm=/);
 assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
});

test('誤ったユーザー名・パスワードでは画面を返さない', async () => {
 for (const [user, password] of [['reviewer', 'wrong-password-123'], ['someone', PASSWORD], ['', '']]) {
  const response = await handleSupporterRequest(page({Authorization: basic(user, password)}), baseEnv());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
 }
});

test('正しいユーザー名・パスワードで画面を返し、署名付き Cookie を発行する', async () => {
 const env = baseEnv();
 const response = await handleSupporterRequest(page({Authorization: basic('reviewer', PASSWORD)}), env);
 assert.equal(response.status, 200);
 assert.equal(await response.text(), '<html>plans</html>');
 const cookie = response.headers.get('Set-Cookie');
 assert.match(cookie, /^__Host-dpi_supporter_review=\d+\.[0-9a-f]{64};/);
 assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
 assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
 const again = await handleSupporterRequest(page({Cookie: cookie.split(';')[0]}), env);
 assert.equal(again.status, 200);
});

test('Cookie は改ざん・期限切れ・パスワード変更で無効になる', async () => {
 const env = baseEnv();
 const cookie = (await reviewCookie(env)).split(';')[0];
 const request = value => new Request('https://dpi-bot.com/', {headers: {Cookie: value}});
 assert.equal(await reviewCookieValid(request(cookie), env), true);
 assert.equal(await reviewCookieValid(request(cookie.replace(/.$/, c => c === '0' ? '1' : '0')), env), false);
 assert.equal(await reviewCookieValid(request(cookie), env, Date.now() + 13 * 3600 * 1000), false);
 assert.equal(await reviewCookieValid(request(cookie), {...env, SUPPORTER_REVIEW_PASSWORD: 'another-password-xyz'}), false);
});

test('API は Discord ログインが必要なまま（審査用 Cookie だけでは通らない）', async () => {
 const env = baseEnv();
 const cookie = (await reviewCookie(env)).split(';')[0];
 const response = await handleSupporterRequest(new Request('https://dpi-bot.com/api/supporter/plans', {headers: {Cookie: cookie}}), env);
 assert.equal(response.status, 404);
});

test('テスト公開中はパスワードなしで画面を返し、検索避けを維持する', async () => {
 const env = {...baseEnv(), SUPPORTER_PREVIEW_OPEN: 'true'};
 const response = await handleSupporterRequest(page({}), env);
 assert.equal(response.status, 200);
 assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
});

test('非公開の間は、審査用の入口を出さず一律404にする（パスワードは登録したまま）', async () => {
 const { handleSupporterRequest } = await import('../worker/supporter.js');
 const env = {SUPPORTER_REVIEW_USER: 'review', SUPPORTER_REVIEW_PASSWORD: 'x'.repeat(16), SUPPORTER_PREVIEW_OPEN: 'false', SUPPORTER_PUBLIC_ENABLED: 'false', REUSE_DB: {}, ASSETS: {fetch: async () => new Response('secret page')}};
 const status = async (path, extra = {}, init = {}) => (await handleSupporterRequest(new Request(`https://dpi-bot.com${path}`, init), {...env, ...extra})).status;
 assert.equal(await status('/site/supporter/'), 401);
 for (const path of ['/site/supporter/', '/site/supporter/plans.html', '/site/supporter/app.js', '/api/supporter/plans', '/api/supporter/account']) assert.equal(await status(path, {SUPPORTER_REVIEW_ENABLED: 'false'}), 404, path);
 const basic = {headers: {Authorization: `Basic ${btoa(`review:${'x'.repeat(16)}`)}`}};
 assert.equal(await status('/site/supporter/', {SUPPORTER_REVIEW_ENABLED: 'false'}, basic), 404);
});
test('公開設定: 有料プランは一般公開で、トップページ・開発者紹介などから案内する', async () => {
 const { readFile } = await import('node:fs/promises');
 const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
 assert.deepEqual([config.vars.SUPPORTER_PREVIEW_OPEN, config.vars.SUPPORTER_PUBLIC_ENABLED, config.vars.SUPPORTER_REVIEW_ENABLED], ['false', 'true', 'false']);
 for (const page of ['../index.html', '../site/dever/index.html', '../site/status/index.html', '../map/index.html']) assert.match(await readFile(new URL(page, import.meta.url), 'utf8'), /site\/supporter\//, page);
});
test('管理画面は、非公開の利用者側フォルダを読み込まない（管理者の認証を通る場所から読む）', async () => {
 const { readFile, readdir } = await import('node:fs/promises');
 const dir = new URL('../site/supporter-admin/', import.meta.url);
 for (const name of (await readdir(dir)).filter(item => /\.(?:js|html|css)$/.test(item))) assert.doesNotMatch(await readFile(new URL(name, dir), 'utf8'), /(?:from '|src="|href="|import\(')(?:\.\.\/|\/site\/)supporter\//, name);
 const worker = await readFile(new URL('../worker/supporter.js', import.meta.url), 'utf8');
 assert.ok(worker.indexOf("path === '/site/supporter-admin/plan-features.js'") > worker.indexOf('const admin = await authenticateNewsletterAdmin(request, env);'));
});
