// 画像配信の見本の拡大表示（site/supporter/preview-lightbox.js）と見本一覧（previews/manifest.json）の確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import * as lightbox from '../site/supporter/preview-lightbox.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const TYPES = ['earthquake-map', 'weather-map', 'warning-table', 'eew-map', 'tsunami-map', 'hires-radar'];
const MAX_BYTES = 400 * 1024;
const MAX_WIDTH = 1200;

// PNG の幅（IHDR）
async function pngWidth(path) {
 const data = await readFile(new URL(path, root));
 assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG', path);
 return data.readUInt32BE(16);
}

test('manifest: 正しい形で、どの種類にも見本が 2 枚以上ある', async () => {
 const manifest = JSON.parse(await read('site/supporter/previews/manifest.json'));
 assert.deepEqual(Object.keys(manifest).sort(), [...TYPES].sort());
 // validateManifest で何も落ちない = すべての項目が正しい
 assert.deepEqual(lightbox.validateManifest(manifest), manifest);
 const files = new Set();
 for (const type of TYPES) {
  assert.ok(manifest[type].length >= 2, `${type}: ${manifest[type].length}`);
  for (const item of manifest[type]) {
   assert.deepEqual(Object.keys(item).sort(), ['caption', 'file', 'plan']);
   assert.ok(item.file.startsWith(`${type}-`), item.file);
   assert.ok(['Basic以上', 'Plus以上', 'Pro以上'].includes(item.plan), item.plan);
   assert.ok(!files.has(item.file), `重複: ${item.file}`);
   files.add(item.file);
  }
 }
});

test('manifest: 載っている画像はすべてあり、幅 1200px・400KB 以下', async () => {
 const manifest = JSON.parse(await read('site/supporter/previews/manifest.json'));
 for (const item of Object.values(manifest).flat()) {
  const path = `site/supporter/previews/${item.file}`;
  const info = await stat(new URL(path, root));
  assert.ok(info.isFile(), path);
  assert.ok(info.size <= MAX_BYTES, `${path}: ${info.size}`);
  assert.ok(await pngWidth(path) <= MAX_WIDTH, path);
 }
});

test('validateManifest: 不正な項目・知らない種類は落とす', () => {
 const ok = {file: 'weather-map-a.png', caption: '全国', plan: 'Plus以上'};
 assert.deepEqual(lightbox.validateManifest(null), {});
 assert.deepEqual(lightbox.validateManifest([]), {});
 assert.deepEqual(lightbox.validateManifest({
  'weather-map': [ok, {file: '../x.png', caption: 'a', plan: 'Plus以上'}, {file: 'b.png', caption: '', plan: 'Plus以上'},
   {file: 'c.png', caption: 'c', plan: '無料'}, {file: 'd.jpg', caption: 'd', plan: 'Pro以上'}, null],
  'unknown-type': [ok],
  'tsunami-map': 'x',
 }), {'weather-map': [ok]});
 assert.deepEqual(lightbox.validateManifest({'eew-map': [{...ok, file: 'eew-map-a.png', extra: 1}]}),
  {'eew-map': [{file: 'eew-map-a.png', caption: '全国', plan: 'Plus以上'}]});
});

test('wrapIndex / indexFor: 端で反対側へ回り、候補に合う見本から開く', () => {
 assert.equal(lightbox.wrapIndex(-1, 4), 3);
 assert.equal(lightbox.wrapIndex(4, 4), 0);
 assert.equal(lightbox.wrapIndex(5, 4), 1);
 assert.equal(lightbox.wrapIndex(2, 0), 0);
 const items = [{file: 'a.png'}, {file: 'b.png'}, {file: 'c.png'}];
 assert.equal(lightbox.indexFor(items, ['x.png', 'c.png', 'b.png']), 2);
 assert.equal(lightbox.indexFor(items, ['x.png']), 0);
 assert.equal(lightbox.indexFor(items), 0);
});

test('loadManifest: 1 回だけ読み、失敗したら次に読み直す', async () => {
 const manifest = JSON.parse(await read('site/supporter/previews/manifest.json'));
 let calls = 0;
 const failing = async () => {calls += 1; return {ok: false, status: 500, json: async () => ({})};};
 await assert.rejects(lightbox.loadManifest(failing));
 const working = async url => {calls += 1; assert.equal(url, lightbox.MANIFEST_URL); return {ok: true, json: async () => manifest};};
 assert.deepEqual(await lightbox.loadManifest(working), manifest);
 assert.deepEqual(await lightbox.loadManifest(working), manifest);
 assert.equal(calls, 2);
});

test('モジュールはページが使うものを公開している', () => {
 for (const name of ['attachPreview', 'openPreview', 'loadManifest', 'validateManifest', 'wrapIndex', 'indexFor'])
  assert.equal(typeof lightbox[name], 'function', name);
 assert.equal(lightbox.PREVIEW_BASE, '/site/supporter/previews/');
 assert.equal(lightbox.MANIFEST_URL, '/site/supporter/previews/manifest.json');
 assert.deepEqual(Object.keys(lightbox.PREVIEW_TYPES).sort(), [...TYPES].sort());
});

test('拡大表示: dialog・← / →・Esc・スワイプ・フォーカスを戻す・日本語の aria-label', async () => {
 const source = await read('site/supporter/preview-lightbox.js');
 for (const text of ["element('dialog'", 'showModal()', "'ArrowLeft'", "'ArrowRight'", "'touchstart'", "'touchend'",
  "addEventListener('close'", 'opener.focus()', "'前の見本'", "'次の見本'", "'閉じる'", "'クリックで拡大'", 'new Image()'])
  assert.ok(source.includes(text), text);
 assert.match(source, /`\$\{state\.index \+ 1\} \/ \$\{state\.items\.length\}`/);
 assert.doesNotMatch(source, /innerHTML|\.style\.|setAttribute\('style'/);
 const css = await read('site/supporter/preview-lightbox.css');
 assert.match(css, /\.preview-zoomable\{cursor:zoom-in/);
 assert.match(css, /min-height:48px/);
 assert.match(css, /@media\(max-width:768px\)\{[^}]*"prev next"/);
});

test('ページ: 契約画面と機能比較ページが拡大表示を使う', async () => {
 const [app, plans, plansJs, index, pkg] = await Promise.all(['site/supporter/app.js', 'site/supporter/plans.html',
  'site/supporter/plans-previews.js', 'site/supporter/index.html', 'package.json'].map(read));
 const manifest = JSON.parse(await read('site/supporter/previews/manifest.json'));
 assert.match(app, /import \{ PREVIEW_BASE, attachPreview \} from '\.\/preview-lightbox\.js';/);
 assert.match(app, /attachPreview\(figure,type,/);
 assert.match(app, /earthquakeMapFields\(box,rule\);previewImages\(box,rulePreviews\(rule\)\)/);
 assert.match(plansJs, /import \{attachPreview\} from '\.\/preview-lightbox\.js';/);
 assert.match(plansJs, /addEventListener\('error', hide/);
 assert.match(plans, /<script type="module" src="plans-previews\.js"><\/script>/);
 for (const page of [plans, index]) assert.match(page, /<link rel="stylesheet" href="preview-lightbox\.css">/);
 // CSP: インラインのハンドラ・スクリプトは使わない
 assert.doesNotMatch(plans, /\son[a-z]+="/);
 assert.doesNotMatch(plans, /<script>(?!<\/script>)/);
 // 機能比較ページの見本は manifest にある見本を指し、地震情報の図もある
 const figures = [...plans.matchAll(/data-preview-type="([^"]+)" data-preview-file="([^"]+)" data-preview-plan="([^"]+)"/g)];
 assert.ok(figures.length >= TYPES.length);
 for (const [, type, file] of figures)
  assert.ok((manifest[type] || []).some(item => item.file === file), `${type} ${file}`);
 for (const type of TYPES) assert.ok(figures.some(([, t]) => t === type), type);
 // 契約画面のサムネイル（rulePreviews の名前）も manifest にある
 for (const name of ['weather-map-national', 'weather-map-region', 'hires-radar-national', 'hires-radar-region', 'eew-map-national',
  'warning-table-national', 'warning-table-regional', 'warning-table-timeseries', 'tsunami-map-map', 'tsunami-map-table',
  'earthquake-map-shindo', 'earthquake-map-hypocenter', 'earthquake-map-detail', 'earthquake-map-long-period'])
  assert.ok(Object.values(manifest).flat().some(item => item.file === `${name}.png`), name);
 assert.ok(JSON.parse(pkg).scripts.check.includes('node --check site/supporter/preview-lightbox.js'));
});
