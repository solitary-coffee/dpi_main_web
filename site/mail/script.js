const newsletterCaptcha = {
    apiReady: false,
    siteKey: '',
    widgetId: null,
    verified: false,
};

window.onDpiNewsletterRecaptchaReady = function() {
    newsletterCaptcha.apiReady = true;
    renderNewsletterRecaptcha();
};

document.addEventListener('DOMContentLoaded', function() {
    setupMenu();
    setupNewsletterForm();
});

function setupMenu() {
    const button = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.overlay');
    if (!button || !sidebar || !overlay) return;

    button.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
    });
    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });
}

function setupNewsletterForm() {
    const form = document.getElementById('newsletter-form');
    if (!form) return;
    document.getElementById('form-started-at').value = String(Date.now());
    form.addEventListener('submit', submitNewsletterForm);

    loadNewsletterConfig().catch(() => {
        setStatus('登録機能を読み込めませんでした。時間をおいてページを再読み込みしてください。', 'error');
        document.getElementById('recaptcha-loading').textContent = 'reCAPTCHAの読み込みに失敗しました。';
        document.getElementById('submit-btn').disabled = true;
    });
}

async function loadNewsletterConfig() {
    const response = await fetch('/api/newsletter/config', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('config_request_failed');

    const config = await response.json();
    if (!config.configured || !config.siteKey) {
        setStatus('メール配信の登録機能は現在設定中です。', 'error');
        document.getElementById('recaptcha-loading').textContent = '現在は登録できません。';
        return;
    }

    newsletterCaptcha.siteKey = config.siteKey;
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onDpiNewsletterRecaptchaReady&render=explicit';
    script.async = true;
    script.defer = true;
    script.onerror = () => {
        setStatus('reCAPTCHAを読み込めませんでした。ページを再読み込みしてください。', 'error');
    };
    document.head.appendChild(script);
    renderNewsletterRecaptcha();
}

function renderNewsletterRecaptcha() {
    if (
        !newsletterCaptcha.apiReady
        || !newsletterCaptcha.siteKey
        || newsletterCaptcha.widgetId !== null
        || !window.grecaptcha
    ) return;

    newsletterCaptcha.widgetId = window.grecaptcha.render('recaptcha-container', {
        sitekey: newsletterCaptcha.siteKey,
        callback: () => {
            newsletterCaptcha.verified = true;
            document.getElementById('submit-btn').disabled = false;
        },
        'expired-callback': disableAfterCaptcha,
        'error-callback': disableAfterCaptcha,
    });
    document.getElementById('recaptcha-loading').hidden = true;
}

function disableAfterCaptcha() {
    newsletterCaptcha.verified = false;
    document.getElementById('submit-btn').disabled = true;
}

async function submitNewsletterForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = document.getElementById('submit-btn');
    const categories = Array.from(form.querySelectorAll('input[name="categories"]:checked'))
        .map((input) => input.value);

    if (!form.reportValidity()) return;
    if (categories.length === 0) {
        setStatus('受け取る情報を1つ以上選択してください。', 'error');
        return;
    }
    if (!newsletterCaptcha.verified || newsletterCaptcha.widgetId === null) {
        setStatus('reCAPTCHAの確認を完了してください。', 'error');
        return;
    }

    const recaptchaToken = window.grecaptcha.getResponse(newsletterCaptcha.widgetId);
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    setStatus('', '');

    try {
        const response = await fetch('/api/newsletter/subscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email: document.getElementById('email').value,
                categories,
                consent: document.getElementById('consent').checked,
                recaptchaToken,
                formStartedAt: document.getElementById('form-started-at').value,
                website: document.getElementById('website').value,
            }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success !== true) {
            throw new Error(result.message || '登録を受け付けられませんでした。');
        }

        setStatus(result.message, 'success');
        form.reset();
        document.getElementById('form-started-at').value = String(Date.now());
    } catch (error) {
        setStatus(error.message || '送信に失敗しました。時間をおいて再度お試しください。', 'error');
    } finally {
        if (newsletterCaptcha.widgetId !== null && window.grecaptcha) {
            window.grecaptcha.reset(newsletterCaptcha.widgetId);
        }
        newsletterCaptcha.verified = false;
        submitButton.textContent = '確認メールを送る';
        submitButton.disabled = true;
    }
}

function setStatus(message, type) {
    const status = document.getElementById('form-status');
    status.textContent = message;
    status.className = type ? `form-status ${type}` : 'form-status';
}
