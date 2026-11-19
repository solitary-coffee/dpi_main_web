// テスト公開中だけ：ログイン不要でテスト支払いページ（Stripe テストモード）へ進む。正式公開時に削除する。
(() => {
 const section = document.getElementById('preview-checkout');
 if (!section) return;
 const status = document.getElementById('preview-checkout-status');
 const buttons = [...section.querySelectorAll('button[data-preview-plan]')];
 const params = new URLSearchParams(location.search);
 if (params.get('preview_checkout') === 'completed') status.textContent = 'テスト支払いが完了しました（テストモードのため請求はされず、契約にも登録されません）。';
 if (params.get('preview_checkout') === 'canceled') status.textContent = 'テスト支払いを中止しました。';
 for (const button of buttons) {
  button.addEventListener('click', async () => {
   buttons.forEach(item => { item.disabled = true; });
   status.textContent = 'テスト支払いページを準備しています…';
   try {
    const response = await fetch('/api/supporter/preview-checkout', {
     method: 'POST', credentials: 'same-origin',
     headers: {'Content-Type': 'application/json', Accept: 'application/json'},
     body: JSON.stringify({plan: button.dataset.previewPlan}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.url !== 'string' || !data.url.startsWith('https://checkout.stripe.com/')) {
     throw new Error(data.message || 'テスト支払いページを用意できませんでした。時間をおいて再試行してください。');
    }
    location.href = data.url;
   } catch (error) {
    status.textContent = error.message;
    buttons.forEach(item => { item.disabled = false; });
   }
  });
 }
})();
