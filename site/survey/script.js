const statusBox = document.getElementById('page-status');
const loginPanel = document.getElementById('login-panel');
const accountPanel = document.getElementById('account-panel');
const accountName = document.getElementById('account-name');
const participantUuid = document.getElementById('participant-uuid');
const answerState = document.getElementById('answer-state');
const openFormButton = document.getElementById('open-form-btn');
const logoutButton = document.getElementById('logout-btn');
let csrfToken = '';

function setStatus(message, kind = 'info') {
    statusBox.textContent = message;
    statusBox.className = `form-status ${kind}`;
}

function appendState(title, detail) {
    answerState.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    answerState.append(strong, paragraph);
}

async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const body = await response.json().catch(() => ({ success: false, message: '応答を読み取れませんでした。' }));
    if (!response.ok) {
        const error = new Error(body.message || '処理に失敗しました。');
        error.code = body.code;
        error.status = response.status;
        throw error;
    }
    return body;
}

async function loadStatus() {
    try {
        const result = await api('/api/survey/status');
        csrfToken = result.csrfToken;
        accountName.textContent = result.user.username;
        participantUuid.textContent = result.participantUuid;
        loginPanel.classList.add('hidden');
        accountPanel.classList.remove('hidden');
        if (result.answered) {
            answerState.classList.add('answered');
            appendState('回答済みです', 'ボタンから以前の回答内容を開き、必要に応じて編集できます。');
            openFormButton.textContent = '回答内容を編集する';
        } else {
            answerState.classList.remove('answered');
            appendState('未回答です', 'ボタンからGoogleフォームを開いて回答してください。');
            openFormButton.textContent = 'Googleフォームで回答する';
        }
        setStatus('Discord認証と回答者UUIDを確認しました。', 'success');
    } catch (error) {
        if (error.status === 401 || ['login_required', 'session_expired'].includes(error.code)) {
            loginPanel.classList.remove('hidden');
            accountPanel.classList.add('hidden');
            setStatus('回答するにはDiscordログインが必要です。', 'info');
            return;
        }
        setStatus(error.message, 'error');
    }
}

openFormButton.addEventListener('click', async () => {
    openFormButton.disabled = true;
    setStatus('安全な回答用URLを発行しています。', 'info');
    try {
        const result = await api('/api/survey/access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Reuse-CSRF': csrfToken },
            body: '{}',
        });
        window.location.assign(result.url);
    } catch (error) {
        setStatus(error.message, 'error');
        openFormButton.disabled = false;
    }
});

logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
        await api('/api/reuse/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        csrfToken = '';
        accountPanel.classList.add('hidden');
        loginPanel.classList.remove('hidden');
        setStatus('ログアウトしました。', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        logoutButton.disabled = false;
    }
});

loadStatus();
