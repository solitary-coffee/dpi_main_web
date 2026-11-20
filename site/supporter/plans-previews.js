// 機能比較ページの「画像配信の見本」：画像がまだ無いものは枠ごと隠し、1枚も無ければ見出しごと隠す。
(() => {
 const section = document.querySelector('.comparison-previews');
 if (!section) return;
 const update = () => { if (!section.querySelector('.preview-thumb')) section.hidden = true; };
 for (const img of section.querySelectorAll('.preview-thumb img')) {
  const hide = () => { img.closest('.preview-thumb')?.remove(); update(); };
  img.addEventListener('error', hide, {once: true});
 }
})();
