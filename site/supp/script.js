const contactCaptchaState = {
    apiReady: false,
    siteKey: '',
    widgetId: null,
};

window.onDpiRecaptchaReady = function() {
    contactCaptchaState.apiReady = true;
    renderContactRecaptcha();
};

document.addEventListener('DOMContentLoaded', function() {
    
    // --- ① メニュー開閉機能 ---
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.overlay');

    if (menuToggleBtn && sidebar && overlay) {
        menuToggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('open');
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
        });
    }

    // --- ② スライドショー機能 ---
    const slides = document.querySelector('.slides');
    if (slides) {
        const images = document.querySelectorAll('.slides img');
        const prevBtn = document.querySelector('.prev-btn');
        const nextBtn = document.querySelector('.next-btn');

        if (images.length > 0) {
            let currentIndex = 0;
            const totalImages = images.length;

            function goToSlide(index) {
                if (index < 0) {
                    index = totalImages - 1;
                } else if (index >= totalImages) {
                    index = 0;
                }
                slides.style.transform = `translateX(-${index * 100}%)`;
                currentIndex = index;
            }

            nextBtn.addEventListener('click', () => {
                goToSlide(currentIndex + 1);
            });

            prevBtn.addEventListener('click', () => {
                goToSlide(currentIndex - 1);
            });
        }
    }

    // --- ③ アコーディオン機能 ---
    const commandTriggers = document.querySelectorAll('.command-trigger');

    commandTriggers.forEach(trigger => {
        trigger.addEventListener('click', function() {
            this.classList.toggle('active');
            const content = this.nextElementSibling;

            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    });

    setupContactForm();
});

function setupContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;

    const startedAt = document.getElementById('form-started-at');
    const fileInput = document.getElementById('attachments');
    const submitButton = document.getElementById('submit-btn');

    startedAt.value = String(Date.now());
    fileInput.addEventListener('change', updateAttachmentSelection);
    form.addEventListener('submit', submitContactForm);

    loadRecaptchaConfig().catch(() => {
        setFormStatus(
            'reCAPTCHAを読み込めませんでした。ページを再読み込みするか、メールでお問い合わせください。',
            'error',
        );
        document.getElementById('recaptcha-loading').textContent = 'reCAPTCHAの読み込みに失敗しました。';
        submitButton.disabled = true;
    });
}

async function loadRecaptchaConfig() {
    const response = await fetch('/api/contact/config', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) throw new Error('Contact form configuration request failed');

    const config = await response.json();
    if (!config.configured || typeof config.siteKey !== 'string' || !config.siteKey) {
        throw new Error('reCAPTCHA is not configured');
    }

    contactCaptchaState.siteKey = config.siteKey;
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onDpiRecaptchaReady&render=explicit&hl=ja';
    script.async = true;
    script.defer = true;
    script.onerror = () => {
        setFormStatus('reCAPTCHAの読み込みに失敗しました。', 'error');
    };
    document.head.appendChild(script);
}

function renderContactRecaptcha() {
    const container = document.getElementById('recaptcha-container');
    if (
        !container
        || !contactCaptchaState.apiReady
        || !contactCaptchaState.siteKey
        || contactCaptchaState.widgetId !== null
        || typeof window.grecaptcha === 'undefined'
    ) {
        return;
    }

    contactCaptchaState.widgetId = window.grecaptcha.render(container, {
        sitekey: contactCaptchaState.siteKey,
        theme: 'dark',
        size: window.matchMedia('(max-width: 380px)').matches ? 'compact' : 'normal',
        callback: () => setFormStatus('', ''),
        'expired-callback': () => setFormStatus('reCAPTCHAの有効期限が切れました。もう一度確認してください。', 'error'),
        'error-callback': () => setFormStatus('reCAPTCHAで通信エラーが発生しました。', 'error'),
    });

    document.getElementById('recaptcha-loading').hidden = true;
    document.getElementById('submit-btn').disabled = false;
}

function updateAttachmentSelection() {
    const fileInput = document.getElementById('attachments');
    const selection = document.getElementById('attachment-selection');
    const files = Array.from(fileInput.files || []);

    if (!files.length) {
        selection.textContent = 'ファイルは選択されていません。';
        setFormStatus('', '');
        return;
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    selection.textContent = `${files.length}個選択（合計 ${formatBytes(totalBytes)}）`;
    const error = validateClientFiles(files);
    setFormStatus(error || '', error ? 'error' : '');
}

function validateClientFiles(files) {
    const allowedExtensions = new Set(['png', 'jpg', 'jpeg', 'txt', 'log']);
    if (files.length > 3) return '添付できるファイルは3個までです。';

    let totalBytes = 0;
    for (const file of files) {
        totalBytes += file.size;
        const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
        if (!allowedExtensions.has(extension)) {
            return '添付できるのはPNG・JPEG・TXT・LOGファイルのみです。';
        }
        if (file.size > 2 * 1024 * 1024) {
            return '添付ファイルは1個につき2MB以内にしてください。';
        }
    }

    if (totalBytes > 3 * 1024 * 1024) {
        return '添付ファイルは合計3MB以内にしてください。';
    }
    return '';
}

async function submitContactForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = document.getElementById('submit-btn');
    const files = Array.from(document.getElementById('attachments').files || []);

    if (!form.reportValidity()) return;

    const fileError = validateClientFiles(files);
    if (fileError) {
        setFormStatus(fileError, 'error');
        return;
    }

    if (contactCaptchaState.widgetId === null || typeof window.grecaptcha === 'undefined') {
        setFormStatus('reCAPTCHAを読み込んでいます。しばらくお待ちください。', 'error');
        return;
    }

    const recaptchaToken = window.grecaptcha.getResponse(contactCaptchaState.widgetId);
    if (!recaptchaToken) {
        setFormStatus('「私はロボットではありません」を確認してください。', 'error');
        return;
    }

    const formData = new FormData(form);
    formData.set('recaptchaToken', recaptchaToken);
    const originalButtonText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    setFormStatus('お問い合わせを送信しています。', 'pending');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30_000);

    try {
        const response = await fetch(form.action, {
            method: 'POST',
            body: formData,
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            signal: controller.signal,
        });

        let result;
        try {
            result = await response.json();
        } catch {
            result = { success: false, message: 'サーバーから正しい応答を受信できませんでした。' };
        }

        if (!response.ok || !result.success) {
            throw new Error(result.message || '送信に失敗しました。');
        }

        window.location.assign('./tha.html');
    } catch (error) {
        const message = error.name === 'AbortError'
            ? '送信がタイムアウトしました。通信環境を確認してもう一度お試しください。'
            : error.message;
        setFormStatus(message, 'error');
        window.grecaptcha.reset(contactCaptchaState.widgetId);
    } finally {
        window.clearTimeout(timeoutId);
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
    }
}

function setFormStatus(message, state) {
    const status = document.getElementById('form-status');
    if (!status) return;
    status.textContent = message;
    status.className = `form-status${state ? ` ${state}` : ''}`;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
