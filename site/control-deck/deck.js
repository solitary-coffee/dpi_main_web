// 操作盤: 使っていないスマホ（Galaxy など）を常時表示の操作パネルにする。
//   - 5 秒ごとに積層灯の状態（/site/patlite-admin/api/state）を読み、点く色・いま起きていること・一時停止/夜間モードを表示
//   - 1 分ごとに直近 24 時間の履歴（/site/patlite-admin/api/history?days=1）を表示
//   - 積層灯の操作（確認・強制停止・イルミネーション試験）は「遠隔操作の依頼」として積む（/site/patlite-admin/api/command）。
//     Arduino をつないだ PC / Chromebook の積層灯ページが 5 秒以内に受け取って実行する
//   - 一時停止・夜間モードはサイトの設定（/site/patlite-admin/api/settings）を直接変える
//   - 強制停止・一時停止は 1 秒長押しで実行（誤操作防止）。画面を消さない（Screen Wake Lock）
import { COLORS, COLOR_NAMES, LEGEND, PatliteEngine, policyFor } from '../patlite-admin/logic.js';

const STATE_API = '/site/patlite-admin/api/state';
const HISTORY_API = '/site/patlite-admin/api/history?days=1';
const SETTINGS_API = '/site/patlite-admin/api/settings';
const COMMAND_API = '/site/patlite-admin/api/command';
const HOLD_MS = 1000;
const COMMAND_LABELS = { ack: '確認', fullstop_on: '強制停止', fullstop_off: '強制停止の解除', illum: 'イルミネーション試験' };
const WAKE_KEY = 'control-deck-wake';

const $ = (id) => document.getElementById(id);
const nowSeconds = () => Date.now() / 1000;
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const engine = new PatliteEngine(nowSeconds());
const state = { settings: null, receivedAt: null, lastOk: null, error: '', wakeLock: null, wantWake: false, toastTimer: null };

function toast(text, tone = 'good') {
    const element = $('toast');
    element.textContent = text;
    element.className = `deck-toast ${tone}`;
    element.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { element.hidden = true; }, 4000);
}

async function api(url, body) {
    const response = await fetch(url, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}（ログインが切れたら再読み込み）`);
    return data;
}

// ---------------- 表示 ----------------
function renderClock() {
    const now = new Date();
    $('clock-time').textContent = now.toLocaleTimeString('ja-JP', { hour12: false });
    $('clock-date').textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

function render() {
    const now = nowSeconds();
    const { lamps, shown } = engine.pattern(now);
    $('lamps').innerHTML = COLORS.map((color) => `<span class="deck-lamp ${color} ${lamps[color]}" title="${COLOR_NAMES[color]}: ${{ off: '消灯', on: '点灯', flash: '点滅' }[lamps[color]]}"></span>`).join('');
    $('conditions').innerHTML = shown.length ? shown.map((item) => {
        const color = item.colors[0] || 'white';
        const why = item.suppressed || (item.acked ? '確認済み' : !item.lit ? '表示時間外' : item.flashing ? '点滅' : '点灯');
        return `<li><span class="deck-chip deck-lamp ${color} on"></span><span${item.lit ? '' : ' class="deck-dim"'}>${esc(item.title)}（${esc(why)}）</span></li>`;
    }).join('') : '<li class="deck-muted">すべて正常（消灯）</li>';
    const policy = policyFor(state.settings, now);
    const notes = [];
    if (state.error) notes.push(state.error);
    if (state.receivedAt) notes.push(`自宅から最終受信 ${new Date(state.receivedAt * 1000).toLocaleTimeString('ja-JP', { hour12: false })}`);
    if (policy.snoozed) notes.push(`一時停止中（${new Date(state.settings.snoozeUntil * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで）`);
    else if (policy.night) notes.push('夜間モード中（重大だけ）');
    $('status').textContent = notes.join(' / ') || '読み込み中…';
    $('status').classList.toggle('bad', Boolean(state.error));
    const nightOn = Boolean(state.settings?.night?.enabled);
    $('night-label').textContent = `夜間モード: ${nightOn ? 'ON' : 'OFF'}`;
    $('night-tile').classList.toggle('active', nightOn);
    $('wake-label').textContent = `画面を消さない: ${state.wakeLock ? 'ON' : 'OFF'}`;
    $('wake-tile').classList.toggle('active', Boolean(state.wakeLock));
}

async function loadState() {
    try {
        const data = await api(STATE_API);
        const now = nowSeconds();
        const offset = now - Number(data.serverTime || now);
        state.receivedAt = Number.isFinite(data.receivedAt) ? data.receivedAt + offset : null;
        engine.update(Array.isArray(data.conditions) ? data.conditions : [], state.receivedAt, offset, now);
        state.settings = data.settings || null;
        engine.settings = state.settings;
        state.lastOk = now;
        state.error = '';
    } catch (error) {
        state.error = `読み込めません: ${error.message}`;
    }
    render();
}

function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}分`;
    return `${Math.floor(seconds / 3600)}時間${Math.round((seconds % 3600) / 60)}分`;
}

async function loadHistory() {
    try {
        const data = await api(HISTORY_API);
        const rows = (data.rows || []).slice(0, 8);
        const now = Number(data.serverTime) || nowSeconds();
        $('history').innerHTML = rows.length ? rows.map((row) => {
            const color = LEGEND[row.kind]?.colors?.[0] || 'white';
            const time = new Date(row.startedAt * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
            const end = row.endedAt === null ? '継続中' : `${duration(row.endedAt - row.startedAt)}で復帰`;
            return `<li><span class="deck-time">${time}</span><span class="deck-chip deck-lamp ${color} on"></span><span>${esc(row.title)}<span class="deck-dim">（${row.endedAt === null ? `${end}・${duration(now - row.startedAt)}` : end}）</span></span></li>`;
        }).join('') : '<li class="deck-muted">24時間以内の記録はありません</li>';
    } catch (error) {
        $('history').innerHTML = `<li class="deck-muted">履歴を読めません（${esc(error.message)}）</li>`;
    }
}

// ---------------- 操作 ----------------
async function sendCommand(command) {
    try {
        await api(COMMAND_API, command === 'illum' ? { command, seconds: 20 } : { command });
        toast(`${COMMAND_LABELS[command]}を送りました（積層灯ページが 5 秒以内に実行）`);
    } catch (error) {
        toast(`${COMMAND_LABELS[command]}を送れませんでした: ${error.message}`, 'bad');
    }
}

async function saveSettings(patch, message) {
    try {
        const data = await api(SETTINGS_API, { ...(state.settings || {}), ...patch });
        state.settings = data.settings;
        engine.settings = data.settings;
        toast(message);
    } catch (error) {
        toast(`設定を保存できませんでした: ${error.message}`, 'bad');
    }
    render();
}

function run(tile) {
    if (tile.dataset.command) return sendCommand(tile.dataset.command);
    if (tile.dataset.snooze !== undefined) {
        const hours = Number(tile.dataset.snooze);
        return saveSettings({ snoozeUntil: hours > 0 ? nowSeconds() + hours * 3600 : null },
            hours > 0 ? `${hours}時間、積層灯の自動表示を止めました` : '一時停止を解除しました');
    }
    return undefined;
}

// data-hold のタイルは 1 秒長押しで実行（離したら取り消し）
function bindTile(tile) {
    if (!tile.dataset.hold) {
        tile.addEventListener('click', () => run(tile));
        return;
    }
    let timer = null;
    const cancel = () => { clearTimeout(timer); timer = null; tile.classList.remove('holding'); };
    tile.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        tile.classList.add('holding');
        timer = setTimeout(() => { cancel(); if (navigator.vibrate) navigator.vibrate(60); run(tile); }, HOLD_MS);
    });
    for (const name of ['pointerup', 'pointerleave', 'pointercancel']) tile.addEventListener(name, cancel);
    tile.addEventListener('click', (event) => { if (event.detail === 0) run(tile); });   // キーボード操作（Enter）はそのまま実行
    tile.addEventListener('contextmenu', (event) => event.preventDefault());
}

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) { toast('このブラウザは「画面を消さない」に対応していません', 'bad'); return; }
    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; render(); });
    } catch (error) {
        toast(`画面を消さない設定にできませんでした: ${error.message}`, 'bad');
    }
    render();
}

async function toggleWake() {
    state.wantWake = !state.wakeLock;
    try { localStorage.setItem(WAKE_KEY, state.wantWake ? '1' : '0'); } catch { /* 保存できなくても動く */ }
    if (state.wakeLock) { await state.wakeLock.release().catch(() => {}); state.wakeLock = null; render(); return; }
    await requestWakeLock();
}

function start() {
    for (const tile of document.querySelectorAll('.deck-tile[data-command], .deck-tile[data-snooze]')) bindTile(tile);
    $('night-tile').addEventListener('click', () => {
        const night = { ...(state.settings?.night || { start: '22:00', end: '07:00' }) };
        night.enabled = !night.enabled;
        saveSettings({ night }, `夜間モードを${night.enabled ? 'ON' : 'OFF'}にしました（${night.start}〜${night.end}）`);
    });
    $('wake-tile').addEventListener('click', toggleWake);
    $('fullscreen-tile').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => toast('全画面にできませんでした', 'bad'));
    });
    try { state.wantWake = localStorage.getItem(WAKE_KEY) === '1'; } catch { state.wantWake = false; }
    // 画面を消さない: 画面に戻ったら取り直す（Wake Lock は裏に回ると自動で外れる）。最初の 1 回はタップが必要な端末もある
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { loadState(); if (state.wantWake && !state.wakeLock) requestWakeLock(); }
    });
    if (state.wantWake) requestWakeLock();
    renderClock();
    setInterval(renderClock, 1000);
    loadState();
    loadHistory();
    setInterval(loadState, 5000);
    setInterval(loadHistory, 60000);
}

start();
