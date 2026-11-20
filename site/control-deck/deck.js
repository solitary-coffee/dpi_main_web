// 操作盤: 使っていないスマホ（Galaxy など）を常時表示の操作パネルにする。
//   - 5 秒ごとに積層灯の状態（/site/patlite-admin/api/state）を読み、点く色・いま起きていること・一時停止/夜間モードを表示
//   - 1 分ごとに直近 24 時間の履歴（/site/patlite-admin/api/history?days=1）を表示
//   - 2 分ごとに直近 24 時間の配信統計（/site/delivery-admin/api/summary?period=24h。AWS の監視テーブル）を表示
//   - 積層灯の操作（確認・強制停止）は「遠隔操作の依頼」として積む（/site/patlite-admin/api/command）。
//     Arduino をつないだ PC / Chromebook の積層灯ページが 5 秒以内に受け取って実行する
//   - 一時停止・夜間モードはサイトの設定（/site/patlite-admin/api/settings）を直接変える
//   - 強制停止・一時停止は 1 秒長押しで実行（誤操作防止）。画面を消さない（Screen Wake Lock）
import { COLORS, COLOR_NAMES, LEGEND, PatliteEngine, policyFor } from '../patlite-admin/logic.js';

const STATE_API = '/site/patlite-admin/api/state';
const HISTORY_API = '/site/patlite-admin/api/history?days=1';
const SETTINGS_API = '/site/patlite-admin/api/settings';
const COMMAND_API = '/site/patlite-admin/api/command';
const DELIVERY_API = '/site/delivery-admin/api/summary?period=24h';
const DELIVERY_EVERY_MS = 120_000;   // 監視テーブルを読むので間隔を空ける（サーバー側も 45 秒キャッシュ）
const EVENT_LABELS = { eew: 'EEW', keiho: 'EEW警報', eew_sind: 'EEW震度', zisin: '地震', tunami: '津波', kisyo: '気象', kisyo2: '気象', kazan: '火山', sub: 'その他', supporter: '有料' };
const HOLD_MS = 1000;
const COMMAND_LABELS = { ack: '確認', fullstop_on: '強制停止', fullstop_off: '強制停止の解除' };
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

// ---------------- 配信の統計 ----------------
const number = (value) => Number(value || 0).toLocaleString('ja-JP');
const seconds = (ms) => (Number(ms) > 0 ? `${(Number(ms) / 1000).toFixed(Number(ms) < 10_000 ? 1 : 0)}秒` : '—');
const typeLabel = (type) => EVENT_LABELS[type] || type || '不明';

const deliveryView = { data: null, filter: null };

// 有料プランの「送信先 0 件」の記録（該当する契約が無かった分）は直近の一覧に出さない
const meaningful = (row) => !(row.eventType === 'supporter' && Number(row.targets || 0) === 0);

async function loadDelivery() {
    try {
        deliveryView.data = await api(DELIVERY_API);
        $('delivery-updated').textContent = ` ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新`;
        renderDelivery();
    } catch (error) {
        $('delivery-recent').innerHTML = `<li class="deck-muted">配信の統計を読めません（${esc(error.message)}）</li>`;
    }
}

// 種類のチップを押すと、その種類だけの数字と一覧にする（もう一度押すと全部に戻す）
function renderDelivery() {
    const stats = deliveryView.data?.statistics || {};
    const filter = deliveryView.filter;
    const types = (stats.byEventType || []).filter((row) => Number(row.events) > 0).sort((x, y) => y.events - x.events);
    const totals = filter ? (types.find((row) => row.eventType === filter) || {}) : (stats.totals || {});
    const recentAll = (Array.isArray(stats.recent) ? stats.recent : []).filter(meaningful);
    const now = nowSeconds();
    $('kpi-events').textContent = number(totals.events);
    if (filter) {
        $('kpi-hour').textContent = `${typeLabel(filter)}だけ`;
    } else {
        const raw = Array.isArray(stats.recent) ? stats.recent : [];
        const lastHour = raw.filter((row) => now - Number(row.updatedEpoch || 0) <= 3600).length;
        $('kpi-hour').textContent = `直近1時間 ${raw.length >= 50 && lastHour >= raw.length ? '50件以上' : `${lastHour}件`}`;
    }
    $('kpi-targets').textContent = number(totals.targets);
    const sent = Number(totals.normal || 0) + Number(totals.errors || 0);
    $('kpi-rate').textContent = sent ? `成功率 ${(Number(totals.normal || 0) / sent * 100).toFixed(sent >= 1000 ? 2 : 1)}%` : '';
    // 失敗のうち「宛先の Webhook が消えた・使えない」（除外）は利用者側の問題なので、大きい数字には入れない
    const actionable = Math.max(0, Number(totals.errors || 0) - Number(totals.excludedErrors || 0));
    $('kpi-errors').textContent = number(actionable);
    $('kpi-serious').textContent = `重大 ${number(totals.seriousErrors)}・消えた宛先 ${number(totals.excludedErrors)}`;
    $('kpi-errors-box').classList.toggle('bad', Number(totals.seriousErrors || 0) > 0);
    $('kpi-latency').textContent = seconds(totals.maxLatencyMs);
    $('delivery-types').innerHTML = types.map((row) => {
        const classes = ['deck-type'];
        if (Number(row.seriousErrors) > 0) classes.push('bad');
        if (filter === row.eventType) classes.push('active');
        return `<button type="button" class="${classes.join(' ')}" data-type="${esc(row.eventType)}" aria-pressed="${filter === row.eventType}">${esc(typeLabel(row.eventType))} <strong>${number(row.events)}</strong></button>`;
    }).join('') || '<span class="deck-muted">24時間の配信はありません</span>';
    let items;
    if (filter) {
        // 種類を絞ったときは、題名ごとのまとめ（直近 24 時間の回数・送信先・失敗）を新しい順に
        const byTitle = (stats.byTitle || []).filter((row) => row.eventType === filter && !(filter === 'supporter' && Number(row.targets || 0) === 0));
        items = byTitle.slice(0, 8).map((row) => {
            const time = new Date(Number(row.latestEpoch) * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
            const fail = Number(row.errors) - Number(row.excludedErrors || 0) > 0 ? `<span class="deck-bad">失敗 ${number(Number(row.errors) - Number(row.excludedErrors || 0))}</span>` : '';
            return `<li><span class="deck-time">${time}</span><span>${esc(row.title)}<span class="deck-dim">（${number(row.events)}回・${number(row.targets)}件）</span>${fail}</span></li>`;
        });
    } else {
        items = recentAll.slice(0, 6).map((row) => {
            const time = new Date(Number(row.updatedEpoch) * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
            // 直近の一覧の行には「消えた宛先」の内訳が無いので、重大な失敗だけを出す
            const fail = Number(row.seriousErrors) > 0 ? `<span class="deck-bad">重大 ${number(row.seriousErrors)}</span>` : '';
            const title = row.eventType === 'supporter' && row.title === 'supporter' ? '有料プランの配信' : row.title;
            return `<li><span class="deck-time">${time}</span><span class="deck-type-mini">${esc(typeLabel(row.eventType))}</span><span>${esc(title)}<span class="deck-dim">（${number(row.targets)}件・${seconds(row.maxLatencyMs)}）</span>${fail}</span></li>`;
        });
    }
    $('delivery-recent').innerHTML = items.join('') || `<li class="deck-muted">${filter ? `${esc(typeLabel(filter))}の記録はありません` : '直近の配信はありません'}</li>`;
}

// ---------------- 操作 ----------------
async function sendCommand(command) {
    try {
        await api(COMMAND_API, { command });
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
    $('delivery-types').addEventListener('click', (event) => {
        const chip = event.target.closest('[data-type]');
        if (!chip) return;
        deliveryView.filter = deliveryView.filter === chip.dataset.type ? null : chip.dataset.type;
        renderDelivery();
    });
    $('fullscreen-tile').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => toast('全画面にできませんでした', 'bad'));
    });
    try { state.wantWake = localStorage.getItem(WAKE_KEY) === '1'; } catch { state.wantWake = false; }
    // 画面を消さない: 画面に戻ったら取り直す（Wake Lock は裏に回ると自動で外れる）。最初の 1 回はタップが必要な端末もある
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { loadState(); loadDelivery(); if (state.wantWake && !state.wakeLock) requestWakeLock(); }
    });
    if (state.wantWake) requestWakeLock();
    renderClock();
    setInterval(renderClock, 1000);
    loadState();
    loadHistory();
    loadDelivery();
    setInterval(loadState, 5000);
    setInterval(() => { if (!document.hidden) loadDelivery(); }, DELIVERY_EVERY_MS);
    setInterval(loadHistory, 60000);
}

start();
