// 画像配信の見本の拡大表示（ライトボックス）。契約画面（app.js）と機能比較ページ（plans-previews.js）で共通。
// 見本の一覧は /site/supporter/previews/manifest.json（種類 → [{file, caption, plan, group}]。自宅の
// tools/render_supporter_previews.py が書く）。拡大表示の中では、開いた見本と同じまとまり（group: 全国・地方・
// 拡大図・表 など）の見本だけを ← / → で切り替える（地方の見本を開いたら地方の見本だけ）。
// インラインのハンドラ・スタイルは使わない（CSP: script-src / style-src 'self'）。見た目は preview-lightbox.css。

export const PREVIEW_BASE = '/site/supporter/previews/';
export const MANIFEST_URL = `${PREVIEW_BASE}manifest.json`;
// 見本の種類（manifest.json のキー）と、拡大表示の見出しに使う名前
export const PREVIEW_TYPES = Object.freeze({
 'earthquake-map': '地震情報の図',
 'weather-map': '気象警報・注意報の地図',
 'warning-table': '気象警報・注意報の表',
 'warning-timeseries': '気象警報・注意報の時系列予想',
 'eew-map': '緊急地震速報（警報）の図',
 'tsunami-map': '津波警報・注意報・津波観測の図・表',
 'hires-radar': '雨雲レーダー（高解像度版）',
});
export const PLANNED_PREVIEW_TYPES = Object.freeze({
 'planned-thunder': '雷レーダー',
 'planned-estimated-intensity': '推計震度分布',
 'planned-typhoon': '台風の進路予想図',
 'planned-rain-disaster': '記録的短時間大雨情報の図',
 'planned-volcano': '火山（噴火警報・噴火速報・降灰予報）の図',
 'planned-rain-forecast': '今後の雨（15時間先までの予想）',
 'planned-himawari': '気象衛星（ひまわり）',
 'planned-weather-distribution': '天気分布予報',
 'planned-amedas': 'アメダスの分布図',
});
export const PREVIEW_PLANS = Object.freeze(['Basic以上', 'Plus以上', 'Pro以上']);
// まとまり（group）の見出し。拡大表示の見出しは「種類（まとまり）」。ここに無いまとまりは種類の名前だけ
export const PREVIEW_GROUPS = Object.freeze({
 'weather-map': {national: '全国', region: '地方', municipality: '市区町村ごとの詳細', alert: '竜巻注意情報・線状降水帯'},
 'warning-table': {national: '全国', regional: '地方'},
 'tsunami-map': {map: '全国の図', enlarged: '地方の拡大図', table: '表'},
 'hires-radar': {national: '全国', region: '地方', forecast: '1時間先までの予想'},
});
// これだけ横に動かしたらスワイプとみなす（px）
const SWIPE_DISTANCE = 50;

// manifest.json の中身を確かめ、正しい見本だけを残す（ファイル名は英小文字・数字・ハイフンの .png / .gif だけ）
export function validateManifest(data) {
 const result = {};
 if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
 for (const type of Object.keys(PREVIEW_TYPES)) {
  const items = Array.isArray(data[type]) ? data[type] : [];
  const valid = items.filter(item => item && typeof item === 'object'
   && typeof item.file === 'string' && /^[a-z0-9][a-z0-9-]*\.(?:png|gif)$/.test(item.file)
   && typeof item.caption === 'string' && item.caption.trim() !== ''
   && PREVIEW_PLANS.includes(item.plan));
  // group が無い・正しくない見本は 'all'（その種類の見本すべてで 1 つのまとまり）
  if (valid.length) result[type] = valid.map(({file, caption, plan, group}) =>
   ({file, caption, plan, group: typeof group === 'string' && /^[a-z0-9-]{1,32}$/.test(group) ? group : 'all'}));
 }
 return result;
}

// 一覧の位置を 0〜length-1 に収める（端から先は反対の端へ回る）
export function wrapIndex(index, length) {
 if (!length) return 0;
 return ((index % length) + length) % length;
}

// 最初に表示する位置: prefer（ファイル名の候補。先にあるものほど優先）に一致する見本、無ければ先頭
export function indexFor(items, prefer = []) {
 for (const file of prefer) {
  const index = items.findIndex(item => item.file === file);
  if (index >= 0) return index;
 }
 return 0;
}

// 拡大表示で切り替える見本: 最初に表示する見本（prefer に一致、無ければ group の先頭、無ければ先頭）と
// 同じまとまりの見本だけ。{items, index}
export function groupFor(items, {prefer = [], group = ''} = {}) {
 let start = -1;
 for (const file of prefer) {
  start = items.findIndex(item => item.file === file);
  if (start >= 0) break;
 }
 if (start < 0 && group) start = items.findIndex(item => item.group === group);
 if (start < 0) start = 0;
 const chosen = items[start];
 if (!chosen) return {items: [], index: 0};
 const same = items.filter(item => (item.group || 'all') === (chosen.group || 'all'));
 return {items: same, index: same.indexOf(chosen)};
}

// 拡大表示の見出し: 種類の名前（まとまりの名前があれば「種類（まとまり）」）
export function titleFor(type, group) {
 const name = PREVIEW_TYPES[type] || PLANNED_PREVIEW_TYPES[type] || '見本';
 const label = PREVIEW_GROUPS[type]?.[group];
 return label ? `${name}（${label}）` : name;
}

let manifestPromise = null;
// manifest.json を 1 回だけ読む（失敗したら次の呼び出しで読み直す）
export function loadManifest(fetchImpl = globalThis.fetch) {
 if (!manifestPromise) {
  manifestPromise = Promise.resolve()
   .then(() => fetchImpl(MANIFEST_URL, {credentials: 'same-origin', headers: {Accept: 'application/json'}}))
   .then(response => {
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    return response.json();
   })
   .then(validateManifest)
   .catch(error => {manifestPromise = null; throw error;});
 }
 return manifestPromise;
}

// --- 拡大表示の画面（<dialog>。最初に開くときに 1 つだけ作る） ---
let view = null;
const state = {items: [], index: 0, type: '', group: '', opener: null};

function element(tag, className, text) {
 const node = document.createElement(tag);
 if (className) node.className = className;
 if (text !== undefined) node.textContent = text;
 return node;
}

function button(className, text, label) {
 const node = element('button', className, text);
 node.type = 'button';
 node.setAttribute('aria-label', label);
 return node;
}

function buildView() {
 const dialog = element('dialog', 'plb');
 dialog.setAttribute('aria-label', '見本の拡大表示');
 const frame = element('div', 'plb-frame');
 const top = element('div', 'plb-top');
 const title = element('p', 'plb-title');
 const counter = element('p', 'plb-counter');
 counter.setAttribute('aria-live', 'polite');
 const close = button('plb-close', '×', '閉じる');
 top.append(title, counter, close);
 const stage = element('div', 'plb-stage');
 const image = element('img', 'plb-image');
 image.decoding = 'async';
 stage.append(image);
 const prev = button('plb-nav plb-prev', '←', '前の見本');
 const next = button('plb-nav plb-next', '→', '次の見本');
 const caption = element('p', 'plb-caption');
 const plan = element('span', 'plb-plan');
 const text = element('span', 'plb-caption-text');
 caption.append(plan, text);
 frame.append(top, prev, stage, next, caption);
 dialog.append(frame);
 document.body.append(dialog);

 close.addEventListener('click', () => dialog.close());
 prev.addEventListener('click', () => step(-1));
 next.addEventListener('click', () => step(1));
 // 画像の外（背景・余白）を押したら閉じる
 dialog.addEventListener('click', event => {
  if (event.target === dialog || event.target === frame || event.target === stage) dialog.close();
 });
 dialog.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') {event.preventDefault(); step(-1);}
  else if (event.key === 'ArrowRight') {event.preventDefault(); step(1);}
 });
 // スワイプ（左へ払う = 次、右へ払う = 前）
 let touch = null;
 stage.addEventListener('touchstart', event => {
  touch = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : null;
 }, {passive: true});
 stage.addEventListener('touchend', event => {
  if (!touch || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - touch.x;
  const dy = event.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
 }, {passive: true});
 // 閉じたら開いた元へフォーカスを戻す
 dialog.addEventListener('close', () => {
  document.documentElement.classList.remove('plb-open');
  const opener = state.opener;
  state.opener = null;
  if (opener && opener.isConnected) opener.focus();
 });
 return {dialog, title, counter, image, prev, next, plan, text};
}

function show() {
 const item = state.items[state.index];
 if (!view || !item) return;
 const several = state.items.length > 1;
 view.title.textContent = titleFor(state.type, item.group);
 view.counter.textContent = `${state.index + 1} / ${state.items.length}`;
 view.image.src = `${PREVIEW_BASE}${item.file}`;
 view.image.alt = `見本：${PREVIEW_TYPES[state.type] || PLANNED_PREVIEW_TYPES[state.type] || ''}（${item.caption}）`;
 view.plan.textContent = item.plan;
 view.plan.dataset.plan = item.plan;
 view.text.textContent = item.caption;
 view.prev.hidden = !several;
 view.next.hidden = !several;
 // 前後の見本を先に読み込んでおく
 if (several) {
  for (const offset of [-1, 1]) {
   const neighbour = state.items[wrapIndex(state.index + offset, state.items.length)];
   const preload = new Image();
   preload.decoding = 'async';
   preload.src = `${PREVIEW_BASE}${neighbour.file}`;
  }
 }
}

function step(offset) {
 if (state.items.length < 2) return;
 state.index = wrapIndex(state.index + offset, state.items.length);
 show();
}

// 拡大表示を開く。type = 見本の種類、prefer = 最初に表示したいファイル名の候補、group = prefer が無いときに開くまとまり、
// opener = 閉じたときにフォーカスを戻す要素。← / → で切り替えるのは最初に表示した見本と同じまとまりの見本だけ。
// manifest.json を読めない・その種類が無いときは、fallback（見本の配列またはそれを返す関数）を表示する
export async function openPreview(type, {prefer = [], group = '', opener = null, fallback = null} = {}) {
 let items = [];
 try {
  items = (await loadManifest())[type] || [];
 } catch {
  items = [];
 }
 if (!items.length && fallback) {
  const alternatives = typeof fallback === 'function' ? fallback() : fallback;
  items = Array.isArray(alternatives) ? alternatives : (alternatives ? [alternatives] : []);
 }
 if (!items.length) return false;
 if (!view) view = buildView();
 const shown = groupFor(items, {prefer, group});
 state.items = shown.items;
 state.type = type;
 state.index = shown.index;
 state.opener = opener;
 show();
 if (!view.dialog.open) {
  document.documentElement.classList.add('plb-open');
  view.dialog.showModal();
 }
 return true;
}

// 見本の枠（figure など）を押すと拡大表示が開くようにする（マウス・Enter・Space）。「クリックで拡大」の表示も付ける
export function attachPreview(target, type, {prefer = [], group = '', caption = '', fallback = null} = {}) {
 if (!target || target.dataset.previewZoom === 'on') return target;
 target.dataset.previewZoom = 'on';
 target.classList.add('preview-zoomable');
 target.tabIndex = 0;
 target.setAttribute('role', 'button');
 target.setAttribute('aria-haspopup', 'dialog');
 target.setAttribute('aria-label', `${caption || PREVIEW_TYPES[type] || PLANNED_PREVIEW_TYPES[type] || '見本'}を拡大表示（他の見本も見られます）`);
 const hint = element('span', 'preview-zoom-hint', 'クリックで拡大');
 hint.setAttribute('aria-hidden', 'true');
 target.append(hint);
 const open = () => openPreview(type, {prefer, group, opener: target, fallback});
 target.addEventListener('click', event => {event.preventDefault(); open();});
 target.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); open();}
 });
 return target;
}
