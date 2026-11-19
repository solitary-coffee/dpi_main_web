// テスト公開中だけ：ログイン不要でテスト支払いページ（Stripe テストモード）へ進む。正式公開時に削除する。
(() => {
 const section = document.getElementById('preview-checkout');
 if (!section) return;
 const status = document.getElementById('preview-checkout-status');
 const buttons = [...section.querySelectorAll('button[data-preview-plan]')];
 const params = new URLSearchParams(location.search);
 const yen = value => `${Number(value || 0).toLocaleString('ja-JP')}円`;
 const showResult = (text, ok) => {
  status.textContent = text;
  status.classList.toggle('preview-result-ok', ok === true);
  status.classList.toggle('preview-result-ng', ok === false);
  section.scrollIntoView({block: 'start'});
 };
 if (params.get('preview_checkout') === 'canceled') showResult('テスト支払いを中止しました。料金は発生していません。', false);
 if (params.get('preview_checkout') === 'completed') {
  const sessionId = params.get('session_id') || '';
  showResult('テスト支払いの結果を確認しています…');
  fetch(`/api/supporter/preview-checkout/result?session_id=${encodeURIComponent(sessionId)}`, {credentials: 'same-origin', headers: {Accept: 'application/json'}})
   .then(response => response.json().then(data => ({ok: response.ok, data})))
   .then(({ok, data}) => {
    if (!ok) throw new Error(data.message || '支払い結果を確認できませんでした。');
    const method = data.paymentMethod ? `（${data.paymentMethod}で支払い）` : '';
    if (!data.completed) return showResult('テスト支払いはまだ完了していません。完了まで時間がかかる支払い方法の場合は、しばらくしてから再読み込みしてください。', false);
    if (data.kind === 'credit') return showResult(`テストのクレジットチャージが完了しました：${yen(data.amount)}分${method}。テストのため、実際にはクレジットは付与されず、請求も発生しません。`, true);
    return showResult(`テストの申込みが完了しました：${data.planName || ''}プラン（月額${yen(data.amount)}）の登録${method}。テストのため、実際の契約には登録されず、請求も発生しません。`, true);
   })
   .catch(error => showResult(error.message, false));
 }
 for (const button of buttons) {
  button.addEventListener('click', async () => {
   buttons.forEach(item => { item.disabled = true; });
   status.textContent = 'テスト支払いページを準備しています…';
   try {
    const response = await fetch('/api/supporter/preview-checkout', {
     method: 'POST', credentials: 'same-origin',
     headers: {'Content-Type': 'application/json', Accept: 'application/json'},
     body: JSON.stringify(button.dataset.previewPlan === 'credit'
      ? {plan: 'credit', amount: Number(document.getElementById('preview-credit-amount')?.value)}
      : {plan: button.dataset.previewPlan}),
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
