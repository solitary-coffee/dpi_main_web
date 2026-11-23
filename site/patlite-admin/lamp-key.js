// 積層灯ページ・操作盤で共通: Cloudflare Access のログインが切れても表示を続けるための鍵。
//   - ログイン中に発行してブラウザに保存する（有効 400 日・1 日ごとに更新）。鍵でできるのは「状態を読む・強制停止の報告・依頼を実行済みにする」だけ
//   - まずログイン（Access）で読み、読めないとき（ログイン切れ）だけ鍵で Access の外の API（/api/patlite/lamp/*）を使う
export const STATE_API = '/site/patlite-admin/api/state';
export const COMMAND_DONE_API = '/site/patlite-admin/api/command/done';
export const DEVICE_API = '/site/patlite-admin/api/device';
const LAMP_KEY_API = '/site/patlite-admin/api/lamp-key';
const LAMP_API = { [STATE_API]: '/api/patlite/lamp/state', [COMMAND_DONE_API]: '/api/patlite/lamp/command-done', [DEVICE_API]: '/api/patlite/lamp/device' };
const LAMP_KEY_STORAGE = 'patlite-lamp-key';
const LAMP_KEY_RENEW_SECONDS = 86400;   // ログイン中は 1 日ごとに新しい鍵へ更新する（有効 400 日）
export const FETCH_TIMEOUT_MS = 10_000;   // 返事が来ないまま待ち続けない（ログインの確認で止まっても鍵へ切り替える）

// viaKey: いま鍵で読んでいる（ログイン切れ）。loginLost: ログインでは読めなかった（鍵が無いときも true）
export const lamp = { viaKey: false, loginLost: false, renewing: false };
let memoryKey = null;   // ブラウザに保存できない設定でも、開いている間は使えるように持っておく

const usable = (saved) => Boolean(saved && typeof saved.key === 'string' && Number(saved.expiresAt) > Date.now() / 1000);

export function savedLampKey() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAMP_KEY_STORAGE) || 'null');
        if (usable(saved)) return saved;
    } catch { /* 保存を読めないときは下の控えを使う */ }
    return usable(memoryKey) ? memoryKey : null;
}

function forgetLampKey() {
    memoryKey = null;
    try { localStorage.removeItem(LAMP_KEY_STORAGE); } catch { /* 何もしない */ }
}

// ログイン中に呼ぶ: 鍵が無い・発行から 1 日以上たっていたら新しく発行して保存する
export async function renewLampKey() {
    const saved = savedLampKey();
    if (lamp.renewing || (saved && Date.now() / 1000 - Number(saved.issuedAt || 0) < LAMP_KEY_RENEW_SECONDS)) return;
    lamp.renewing = true;
    try {
        const response = await fetch(LAMP_KEY_API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.success && data.key) {
            memoryKey = { key: data.key, expiresAt: data.expiresAt, issuedAt: Date.now() / 1000 };
            localStorage.setItem(LAMP_KEY_STORAGE, JSON.stringify(memoryKey));
        }
    } catch { /* 発行できなくても、ログイン中は今までどおり動く */ } finally { lamp.renewing = false; }
}

// まずログイン（Access）で読む。読めないとき（ログイン切れ）は、保存してある鍵で Access の外の API を使う
export async function lampFetch(url, init = {}) {
    let failure = null;
    try {
        const response = await fetch(url, { credentials: 'same-origin', ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const data = await response.clone().json().catch(() => null);
        if (response.ok && data) { lamp.viaKey = false; lamp.loginLost = false; return { response, data }; }
        if (data && response.status !== 401 && response.status !== 403) return { response, data };   // ログイン以外の理由（入力の誤りなど）
        failure = new Error(`HTTP ${response.status}`);
    } catch (error) {
        failure = error;   // ログイン画面への転送は別サイトなので、通信エラーになる
    }
    const saved = savedLampKey();
    if (!saved || !LAMP_API[url]) { lamp.viaKey = false; lamp.loginLost = true; throw failure; }
    const response = await fetch(LAMP_API[url], { ...init, credentials: 'omit', headers: { ...(init.headers || {}), Authorization: `Bearer ${saved.key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await response.json().catch(() => null);
    if (response.status === 401) { forgetLampKey(); lamp.viaKey = false; lamp.loginLost = true; throw failure; }
    lamp.viaKey = true;
    lamp.loginLost = true;
    return { response, data };
}

// ページ本体を保存しておく Service Worker を登録する（ログインが切れた後の再読み込み・再起動でもページを開けるように）
export function registerShell(scriptUrl) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(scriptUrl).catch((error) => console.warn('service worker registration failed', error));
}

// 「ログインし直す」で開いたタブ（?login=1）か
export const openedForLogin = () => new URLSearchParams(location.search).has('login');
