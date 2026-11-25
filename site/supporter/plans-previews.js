// 機能比較ページの「画像配信の見本」：画像がまだ無いものは枠ごと隠し、1枚も無ければ見出しごと隠す。
// 見本を押すと拡大表示（preview-lightbox.js）が開き、同じ種類の他の見本も ← / → で見られる。
// 各見本の枠は data-preview-type（種類）・data-preview-file（最初に表示する見本）・data-preview-plan（対象プラン）を持つ。
import {attachPreview} from './preview-lightbox.js';

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
