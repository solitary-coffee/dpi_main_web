// 機能比較ページの「画像配信の見本」：画像がまだ無いものは枠ごと隠し、1枚も無ければ見出しごと隠す。
// 見本を押すと拡大表示（preview-lightbox.js）が開き、同じ種類の他の見本も ← / → で見られる。
// 各見本の枠は data-preview-type（種類）・data-preview-file（最初に表示する見本）・data-preview-plan（対象プラン）を持つ。
import {attachPreview} from './preview-lightbox.js';

// 公開の切り替えで隠している行は、公開 API が有効を返したときだけ出す
fetch('/api/supporter/plans', {credentials: 'same-origin', cache: 'no-store', headers: {Accept: 'application/json'}})
 .then(response => response.ok ? response.json() : null)
 .then(flags => {
  if (flags?.customRequests?.enabled !== true) return;
  for (const item of document.querySelectorAll('[data-feature-gate="customRequests"]')) item.hidden = false;
 })
 .catch(() => {});

const detailReferences = [...document.querySelectorAll('.detail-ref[href^="#"]')];
const detailTarget = hash => {
 if (!hash || hash === '#') return null;
 try {
  const target = document.getElementById(decodeURIComponent(hash.slice(1)));
  return target?.matches('.comparison-catalog details') ? target : null;
 } catch { return null; }
};
const openDetail = (hash, source) => {
 const target = detailTarget(hash);
 if (!target) return null;
 target.open = true;
 const back = target.querySelector('.detail-back a');
 if (back && source) back.href = `#${source.id}`;
 return target;
};
detailReferences.forEach((reference, index) => {
 if (!reference.id) reference.id = `comparison-detail-ref-${index + 1}`;
 reference.addEventListener('click', () => openDetail(reference.hash, reference));
});
for (const back of document.querySelectorAll('.detail-back a')) {
 back.addEventListener('click', event => {
  const source = document.getElementById(decodeURIComponent(back.hash.slice(1)));
  if (!source?.matches('.detail-ref')) return;
  event.preventDefault();
  location.hash = source.id;
  source.focus({preventScroll: true});
  source.scrollIntoView({block: 'center'});
 });
}
const openHashDetail = () => {
 const target = openDetail(location.hash);
 if (target) requestAnimationFrame(() => target.scrollIntoView({block: 'start'}));
};
window.addEventListener('hashchange', openHashDetail);
openHashDetail();

const section = document.querySelector('.comparison-previews');
if (section) {
 const update = () => { if (!section.querySelector('.preview-thumb')) section.hidden = true; };
 for (const figure of section.querySelectorAll('.preview-thumb')) {
  const img = figure.querySelector('img');
  if (!img) continue;
  const hide = () => { figure.remove(); update(); };
  // このスクリプトより先に読み込みに失敗していた画像も隠す
  if (img.complete && img.naturalWidth === 0) { hide(); continue; }
  img.addEventListener('error', hide, {once: true});
  const type = figure.dataset.previewType;
  const file = figure.dataset.previewFile;
  if (!type || !file) continue;
  const caption = figure.querySelector('figcaption')?.textContent || '';
  attachPreview(figure, type, {prefer: [file], caption,
   fallback: {file, caption, plan: figure.dataset.previewPlan || 'Plus以上'}});
 }
 update();
}
