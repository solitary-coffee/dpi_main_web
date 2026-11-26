import test from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const planned = [
 ['planned-thunder', 'planned-thunder-national.png', '雷レーダー'],
 ['planned-estimated-intensity', 'planned-estimated-intensity.png', '推計震度分布'],
 ['planned-typhoon', 'planned-typhoon.png', '台風の進路予想図'],
 ['planned-rain-disaster', 'planned-record-rain.png', '記録的短時間大雨情報の図'],
 ['planned-volcano', 'planned-volcano-warning.png', '火山（噴火警報・噴火速報・降灰予報）の図'],
 ['planned-volcano', 'planned-volcano-ash.png', '火山（噴火警報・噴火速報・降灰予報）の図'],
 ['planned-rain-forecast', 'planned-rain-forecast.gif', '今後の雨（15時間先までの予想）'],
 ['planned-himawari', 'planned-himawari-ir.png', '気象衛星（ひまわり）'],
 ['planned-weather-distribution', 'planned-weather-distribution.png', '天気分布予報'],
 ['planned-amedas', 'planned-amedas-temperature.png', 'アメダスの分布図'],
];

test('準備中の画像配信9種類を表に掲載し、全プランを準備中と表示する', async () => {
 const html = await read('site/supporter/plans.html');
 const group = html.match(/<tbody class="comparison-planned">([\s\S]*?)<\/tbody>/)?.[1] || '';
 const rows = [...group.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
 assert.equal(rows.length, 9);
 assert.match(rows[0], /scope="rowgroup" rowspan="9"[^>]*>準備中の画像配信<\/th>/);
 for (const label of [...new Set(planned.map(([, , label]) => label))]) assert.ok(group.includes(label), label);
 for (const row of rows) {
  const cells = [...row.matchAll(/<td>([^<]+)<\/td>/g)].map(match => match[1]);
  assert.deepEqual(cells, ['準備中', '準備中', '準備中', '準備中']);
 }
});

test('準備中の見本9種類は遅延読み込みで、画像ファイルと準備中表示が揃う', async () => {
 const html = await read('site/supporter/plans.html');
 const section = html.match(/<div class="planned-previews">([\s\S]*?)<\/section>/)?.[1] || '';
 assert.match(section, /現在準備中です。申込み・設定はまだできません。提供開始時期や対象プランは未定です。/);
 const figures = [...section.matchAll(/<figure class="preview-thumb" data-preview-type="([^"]+)" data-preview-file="([^"]+)" data-preview-plan="([^"]+)">([\s\S]*?)<\/figure>/g)];
 assert.equal(figures.length, planned.length);
 assert.equal(new Set(figures.map(([, type]) => type)).size, 9);
 for (const [type, file] of planned) {
  const figure = figures.find(([, actualType, actualFile]) => actualType === type && actualFile === file);
  assert.ok(figure, `${type}: ${file}`);
  assert.equal(figure[3], '準備中');
  assert.match(figure[4], />準備中<\/span>/);
  assert.match(figure[4], /<img [^>]*loading="lazy"[^>]*decoding="async"/);
  assert.match(figure[4], /alt="[^"]+"/);
  await access(new URL(`site/supporter/previews/${file}`, root));
 }
});

test('同種の準備中見本は既存見本と分離してlightboxで切り替える', async () => {
 const [plansJs, lightbox] = await Promise.all([
  read('site/supporter/plans-previews.js'),
  read('site/supporter/preview-lightbox.js'),
 ]);
 assert.match(plansJs, /filter\(item => item\.dataset\.previewType === type\)/);
 assert.match(lightbox, /typeof fallback === 'function'/);
 assert.match(lightbox, /'planned-rain-disaster'/);
 assert.match(lightbox, /'planned-volcano'/);
});
