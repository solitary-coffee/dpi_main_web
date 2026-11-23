// 操作盤: 使っていないスマホ（Galaxy など）を常時表示の操作パネルにする。
//   - 5 秒ごとに積層灯の状態（/site/patlite-admin/api/state）を読み、点く色・いま起きていること・一時停止/絞り込み/時間帯設定を表示
//   - 1 分ごとに直近 24 時間の履歴（/site/patlite-admin/api/history?days=1）を表示
//   - 2 分ごとに直近 24 時間の配信統計（/site/delivery-admin/api/summary?period=24h。AWS の監視テーブル）を表示
//   - 積層灯の操作（確認・強制停止）は「遠隔操作の依頼」として積む（/site/patlite-admin/api/command）。
//     Arduino をつないだ PC / Chromebook の積層灯ページが 5 秒以内に受け取って実行する
//   - 一時停止・時間帯設定（旧・夜間モード）・一時的な絞り込み（今から N 時間は重大のみ／中以上）は
//     サイトの設定（/site/patlite-admin/api/settings）を直接変える
//   - 強制停止・一時停止は 1 秒長押しで実行（誤操作防止）。画面を消さない（Screen Wake Lock）
//   - Access のログインが切れても、保存した鍵（../patlite-admin/lamp-key.js）と保存したページ本体（sw.js）で表示を続ける
//   - Arduino をつないだ積層灯ページからの報告（5 分ごと）が途絶えたら、実機が点いていないおそれを状態の欄に出す
//   - 色の一覧（重大 / 中 / 軽）を左の情報欄のいちばん下に出す
import { COLORS, COLOR_NAMES, FILTER_LEVELS, LEGEND, PatliteEngine, colorText, filterText, flashText, legendByLevel, policyFor, snoozeText } from '../patlite-admin/logic.js';

import { STATE_API, lamp, lampFetch, registerShell, renewLampKey } from '../patlite-admin/lamp-key.js';

const HISTORY_API = '/site/patlite-admin/api/history?days=1';
const SETTINGS_API = '/site/patlite-admin/api/settings';
const COMMAND_API = '/site/patlite-admin/api/command';
const DELIVERY_API = '/site/delivery-admin/api/summary?period=24h';
const DELIVERY_EVERY_MS = 120_000;   // 監視テーブルを読むので間隔を空ける（サーバー側も 45 秒キャッシュ）
const EVENT_LABELS = { eew: 'EEW', keiho: 'EEW警報', eew_sind: 'EEW震度', zisin: '地震', tunami: '津波', kisyo: '気象', kisyo2: '気象', kazan: '火山', sub: 'その他', supporter: '有料' };
const HOLD_MS = 1000;   // data-hold の秒数を掛ける（無期限停止は 3 秒）
const MAX_CUSTOM_HOURS = 168;
const COMMAND_LABELS = { ack: '確認', fullstop_on: '強制停止', fullstop_off: '強制停止の解除' };
const COMMAND_NOTES = { ack: '積層灯ページが 5 秒以内に受け取り、その 3 秒後に消灯' };
const DEVICE_LATE_SECONDS = 11 * 60;   // 積層灯ページは 5 分ごとに報告する。2 回続けて届かなければ未接続とみなす
const WAKE_KEY = 'control-deck-wake';

const $ = (id) => document.getElementById(id);
const nowSeconds = () => Date.now() / 1000;
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const engine = new PatliteEngine(nowSeconds());
const shortTime = (seconds) => new Date(seconds * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const state = { settings: null, receivedAt: null, deviceAt: undefined, lastOk: null, error: '', wakeLock: null, wantWake: false, toastTimer: null };

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
    if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}（ログインが切れていたら「ログインし直す」）`);
    return data;
}

// ---------------- 表示 ----------------
function renderClock() {
    const now = new Date();
    $('clock-time').textContent = now.toLocaleTimeString('ja-JP', { hour12: false });
    $('clock-date').textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

// Arduino をつないだ積層灯ページから報告が来ていないとき、その説明（来ていれば ''）
function deviceProblem(now) {
    if (state.deviceAt === undefined) return '';
    if (state.deviceAt === null) return '実機の積層灯: 未接続（報告がありません）';
    const age = now - state.deviceAt;
    return age > DEVICE_LATE_SECONDS ? `実機の積層灯: 未接続のおそれ（${duration(age)}報告なし）` : '';
}

function render() {
    const now = nowSeconds();
    const { lamps, shown } = engine.pattern(now);
    $('lamps').innerHTML = COLORS.map((color) => `<span class="deck-lamp ${color} ${lamps[color]}" title="${COLOR_NAMES[color]}: ${{ off: '消灯', on: '点灯', flash: '点滅' }[lamps[color]]}"></span>`).join('');
    $('conditions').innerHTML = shown.length ? shown.map((item) => {
        const why = item.suppressed || (item.acked ? '確認済み' : !item.lit ? (item.repeat ? '表示時間外' : '表示を終えた') : item.flashing ? '点滅' : '点灯');
        return `<li>${chipsFor(item.colors)}<span class="deck-level deck-level-${esc(item.level)}">${esc(item.level)}</span><span${item.lit ? '' : ' class="deck-dim"'}>${esc(item.title)}（${esc(why)}）</span></li>`;
    }).join('') : '<li class="deck-muted">すべて正常（消灯）</li>';
    const policy = policyFor(state.settings, now);
    const notes = [];
    if (state.error) notes.push(state.error);
    else if (lamp.viaKey) notes.push('ログイン切れ（表示は継続・操作はログイン後）');
    const deviceLate = deviceProblem(now);
    if (deviceLate) notes.push(deviceLate);
    if (state.receivedAt) notes.push(`自宅から最終受信 ${new Date(state.receivedAt * 1000).toLocaleTimeString('ja-JP', { hour12: false })}`);
    if (policy.snoozed) notes.push(snoozeText(state.settings, now));
    else if (filterText(state.settings, now)) notes.push(filterText(state.settings, now));
    if (policy.fullStop) notes.push('強制停止中');
    $('status').textContent = notes.join(' / ') || '読み込み中…';
    $('status').classList.toggle('bad', Boolean(state.error || deviceLate));
    $('login-link').hidden = !lamp.loginLost;
    const nightOn = Boolean(state.settings?.night?.enabled);
    const nightLevel = FILTER_LEVELS[state.settings?.night?.level === 'medium' ? 'medium' : 'critical'].label;
    $('night-label').innerHTML = `時間帯設定: ${nightOn ? 'ON' : 'OFF'}<small>${nightOn ? `${esc(state.settings.night.start)}〜${esc(state.settings.night.end)} ${esc(nightLevel)}` : 'タップで切り替え'}</small>`;
    $('night-tile').classList.toggle('active', nightOn);
    $('filter-label').innerHTML = policy.temporary
        ? `${esc(FILTER_LEVELS[policy.temporary].label)}<small>${esc(shortTime(policy.temporaryUntil))} まで</small>`
        : '絞り込み<small>重大のみ・中以上</small>';
    $('filter-tile').classList.toggle('active', Boolean(policy.temporary));
    $('wake-label').textContent = `画面を消さない: ${state.wakeLock ? 'ON' : 'OFF'}`;
    $('wake-tile').classList.toggle('active', Boolean(state.wakeLock));
}

async function loadState() {
    try {
        const { response, data } = await lampFetch(STATE_API, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}`);
        if (!lamp.viaKey) renewLampKey();
        const now = nowSeconds();
        const offset = now - Number(data.serverTime || now);
        state.receivedAt = Number.isFinite(data.receivedAt) ? data.receivedAt + offset : null;
        engine.update(Array.isArray(data.conditions) ? data.conditions : [], state.receivedAt, offset, now);
        state.settings = data.settings || null;
        engine.settings = state.settings;
        engine.device = data.device || null;
        state.deviceAt = Number.isFinite(data.device?.reportedAt) ? data.device.reportedAt + offset : null;
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
            const time = new Date(row.startedAt * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
            const end = row.endedAt === null ? '継続中' : `${duration(row.endedAt - row.startedAt)}で復帰`;
            const muted = row.suppressed ? `<span class="deck-muted-reason">${esc(row.suppressed)}</span>` : '';
            return `<li><span class="deck-time">${time}</span>${chipsFor(LEGEND[row.kind]?.colors || ['white'])}<span>${esc(row.title)}<span class="deck-dim">（${row.endedAt === null ? `${end}・${duration(now - row.startedAt)}` : end}）</span>${muted}</span></li>`;
        }).join('') : '<li class="deck-muted">24時間以内の記録はありません</li>';
    } catch (error) {
        $('history').innerHTML = `<li class="deck-muted">履歴を読めません（${esc(error.message)}）</li>`;
    }
}

// 色見本（2 色の組み合わせは 2 つ並べる）
function chipsFor(colors, flashing = false) {
    return `<span class="deck-chips">${colors.map((color) => `<span class="deck-chip deck-lamp ${color} ${flashing ? 'flash' : 'on'}" title="${COLOR_NAMES[color]}"></span>`).join('')}</span>`;
}

// 色の一覧（重大 / 中 / 軽）。点滅するものは見本も点滅
function renderLegend() {
    $('legend').innerHTML = legendByLevel().map(({ level, items }) => `<li class="deck-legend-head"><span class="deck-level deck-level-${esc(level)}">${esc(level)}</span></li>${
        items.map((value) => `<li>${chipsFor(value.colors, value.flashSeconds !== 0)}<span>${esc(value.label.split('（')[0])}<span class="deck-dim">（${esc(colorText(value.colors))}・${esc(flashText(value.flashSeconds))}）</span></span></li>`).join('')
    }`).join('');
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
        toast(`${COMMAND_LABELS[command]}を送りました（${COMMAND_NOTES[command] || '積層灯ページが 5 秒以内に実行'}）`);
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
        if (tile.dataset.snooze === 'custom') return openCustomSnooze();
        if (tile.dataset.snooze === 'forever') {
            return saveSettings({ snoozeUntil: null, snoozeForever: true }, '積層灯の自動表示を無期限に止めました（「一時停止を解除」で戻ります）');
        }
        const hours = Number(tile.dataset.snooze);
        return saveSettings({ snoozeUntil: hours > 0 ? nowSeconds() + hours * 3600 : null, snoozeForever: false },
            hours > 0 ? `${hours}時間、積層灯の自動表示を止めました` : '一時停止を解除しました');
    }
    return undefined;
}

// カスタム時間: 時間を選ぶ（入れる）画面を出して、決めた時間だけ止める
function openCustomSnooze() {
    const dialog = $('custom-dialog');
    if (typeof dialog.showModal !== 'function') {
        const answer = window.prompt('何時間止めますか？（0.5〜168）', '3');
        if (answer !== null) snoozeHours(Number(answer));
        return;
    }
    dialog.returnValue = '';
    dialog.showModal();
}

function snoozeHours(hours) {
    if (!Number.isFinite(hours) || hours <= 0) { toast('時間を正しく入れてください', 'bad'); return undefined; }
    const value = Math.min(MAX_CUSTOM_HOURS, Math.max(0.5, Math.round(hours * 2) / 2));
    const label = value >= 24 && value % 24 === 0 ? `${value / 24}日` : `${value}時間`;
    return saveSettings({ snoozeUntil: nowSeconds() + Math.round(value * 3600), snoozeForever: false },
        `${label}、積層灯の自動表示を止めました`);
}

// 絞り込み: 「今から N 時間は 重大のみ／中以上」を選ぶ画面
function openFilter() {
    const dialog = $('filter-dialog');
    const policy = policyFor(state.settings, nowSeconds());
    $('filter-level').value = policy.temporary || 'critical';
    if (typeof dialog.showModal !== 'function') {
        const answer = window.prompt('何時間「重大のみ」にしますか？（0.5〜168。0 で解除）', '3');
        if (answer !== null) {
            if (Number(answer) === 0) clearFilter();
            else filterHours(Number(answer), 'critical');
        }
        return;
    }
    dialog.returnValue = '';
    dialog.showModal();
}

function filterHours(hours, level) {
    if (!Number.isFinite(hours) || hours <= 0) { toast('時間を正しく入れてください', 'bad'); return undefined; }
    const value = Math.min(MAX_CUSTOM_HOURS, Math.max(0.5, Math.round(hours * 2) / 2));
    const label = value >= 24 && value % 24 === 0 ? `${value / 24}日` : `${value}時間`;
    return saveSettings({ filter: { until: nowSeconds() + Math.round(value * 3600), level } }, `${label}、${FILTER_LEVELS[level].label}にしました`);
}

function clearFilter() {
    return saveSettings({ filter: { until: null, level: 'critical' } }, '絞り込みを解除しました');
}

// data-hold のタイルは長押しで実行（data-hold の秒数。離したら取り消し）
function bindTile(tile) {
    if (!tile.dataset.hold) {
        tile.addEventListener('click', () => run(tile));
        return;
    }
    let timer = null;
    const holdMs = Math.max(1, Number(tile.dataset.hold) || 1) * HOLD_MS;
    tile.style.setProperty('--hold', `${holdMs}ms`);
    const cancel = () => { clearTimeout(timer); timer = null; tile.classList.remove('holding'); };
    tile.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        tile.classList.add('holding');
        timer = setTimeout(() => { cancel(); if (navigator.vibrate) navigator.vibrate(60); run(tile); }, holdMs);
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
    registerShell('sw.js');
    for (const tile of document.querySelectorAll('.deck-tile[data-command], .deck-tile[data-snooze]')) bindTile(tile);
    $('night-tile').addEventListener('click', () => {
        const night = { ...(state.settings?.night || { start: '22:00', end: '07:00', level: 'critical' }) };
        night.enabled = !night.enabled;
        const level = FILTER_LEVELS[night.level === 'medium' ? 'medium' : 'critical'].label;
        saveSettings({ night }, `時間帯設定を${night.enabled ? 'ON' : 'OFF'}にしました（${night.start}〜${night.end} ${level}）`);
    });
    $('filter-tile').addEventListener('click', openFilter);
    $('refresh-tile').addEventListener('click', () => { loadState(); loadHistory(); loadDelivery(); toast('最新の情報を読み込みました'); });
    const filterDialog = $('filter-dialog');
    for (const button of filterDialog.querySelectorAll('[data-filter-hours]')) {
        button.addEventListener('click', () => { $('filter-hours').value = button.dataset.filterHours; });
    }
    filterDialog.addEventListener('close', () => {
        if (filterDialog.returnValue === 'ok') filterHours(Number($('filter-hours').value), $('filter-level').value === 'medium' ? 'medium' : 'critical');
        else if (filterDialog.returnValue === 'clear') clearFilter();
    });
    $('wake-tile').addEventListener('click', toggleWake);
    const customDialog = $('custom-dialog');
    for (const button of customDialog.querySelectorAll('[data-hours]')) {
        button.addEventListener('click', () => { $('custom-hours').value = button.dataset.hours; });
    }
    customDialog.addEventListener('close', () => {
        if (customDialog.returnValue === 'ok') snoozeHours(Number($('custom-hours').value));
    });
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
    renderLegend();
    setInterval(renderClock, 1000);
    loadState();
    loadHistory();
    loadDelivery();
    setInterval(loadState, 5000);
    setInterval(() => { if (!document.hidden) loadDelivery(); }, DELIVERY_EVERY_MS);
    setInterval(loadHistory, 60000);
}

start();
