// 積層灯（PATLITE）管理ページ。Chrome / Edge の Web Serial で、この PC（Chromebook 可）に USB でつないだ
// Arduino（PatliteController.ino Ver.2.1 以降）を直接操作する。アプリのインストールや Python は不要。
//   - 5 秒ごとに /site/patlite-admin/api/state（自宅の積層灯ブリッジが送った「いま起きていること」）を読む
//   - 1 秒ごとに Arduino の状態を読み（GET_STATUS）、表示すべき色と違えば SET を送る
//   - 表示時間などの設定は Arduino の EEPROM に保存されている（CFG_GET / CFG_SET）。どの PC につないでも同じ設定で動く
//   - 一度つないだ Arduino は、次からはページを開く・USB を挿すだけで自動でつながる
import { COLORS, COLOR_NAMES, LEGEND, ACK_EVENTS, LINK_TIMEOUT_SECONDS, PatliteEngine, dailyIlluminationMinute, jstMinutes, parseConfig, parseStatus, policyFor, sameLamps, setCommand } from './logic.js';

const API = '/site/patlite-admin/api/state';
const SETTINGS_API = '/site/patlite-admin/api/settings';
const HISTORY_API = '/site/patlite-admin/api/history';
const HISTORY_EVERY_TICKS = 60;
const ILLUMINATION_DONE_KEY = 'patlite-illumination-done';
const FETCH_EVERY_TICKS = 5;
const ARDUINO_FILTERS = [{ usbVendorId: 0x2341 }, { usbVendorId: 0x2A03 }, { usbVendorId: 0x1A86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x10C4 }];
const $ = (id) => document.getElementById(id);
const nowSeconds = () => Date.now() / 1000;
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const engine = new PatliteEngine(nowSeconds());
const serial = { port: null, reader: null, writer: null, buffer: '', pending: null, chain: Promise.resolve(), readyWaiter: null, connected: false };
const state = { settings: null, savingSettings: false, illuminationDone: '', lastStatus: null, lastEventCounter: null, manualUntil: 0, ticks: 0, fetchMessage: '未取得', lastFetchOk: null, busy: false, config: null, wakeLock: null };

// ---------------- シリアル ----------------
function handleLine(line) {
    if (line.startsWith('OK READY')) {
        state.lastEventCounter = null;
        if (serial.readyWaiter) { serial.readyWaiter(line); serial.readyWaiter = null; }
        return;
    }
    if (serial.pending && (line.startsWith('OK') || line.startsWith('ERR'))) {
        const { resolve, timer } = serial.pending;
        serial.pending = null;
        clearTimeout(timer);
        resolve(line);
    }
}

async function readLoop(port) {
    const decoder = new TextDecoder();
    while (port.readable && serial.port === port) {
        serial.reader = port.readable.getReader();
        try {
            for (;;) {
                const { value, done } = await serial.reader.read();
                if (done) break;
                serial.buffer += decoder.decode(value, { stream: true });
                let index;
                while ((index = serial.buffer.indexOf('\n')) >= 0) {
                    const line = serial.buffer.slice(0, index).replace(/\r$/u, '').trim();
                    serial.buffer = serial.buffer.slice(index + 1);
                    if (line) handleLine(line);
                }
                if (serial.buffer.length > 4096) serial.buffer = '';
            }
        } catch (error) {
            console.warn('serial read failed', error);
            break;
        } finally {
            try { serial.reader.releaseLock(); } catch { /* 切断済み */ }
        }
    }
    if (serial.port === port) await closeSerial('Arduino との通信が切れました。USB を挿し直すと自動でつながります。');
}

function command(text, timeoutMs = 1500) {
    const run = () => new Promise((resolve, reject) => {
        if (!serial.writer) { reject(new Error('Arduino に接続していません。')); return; }
        const timer = setTimeout(() => { serial.pending = null; reject(new Error(`応答がありません（${text.split(' ')[0]}）`)); }, timeoutMs);
        serial.pending = { resolve, timer };
        serial.writer.write(new TextEncoder().encode(`${text}\n`)).catch((error) => { clearTimeout(timer); serial.pending = null; reject(error); });
    });
    const result = serial.chain.then(run, run);
    serial.chain = result.catch(() => {});
    return result;
}

async function openSerial(port) {
    if (serial.port) return;
    setConnection('接続中…（Arduino は接続時に再起動します）', 'warn');
    try {
        await port.open({ baudRate: 115200 });
    } catch (error) {
        setConnection(`開けませんでした: ${error.message}（別のタブやアプリが使っていないか確認してください）`, 'bad');
        return;
    }
    serial.port = port;
    serial.writer = port.writable.getWriter();
    serial.buffer = '';
    const ready = new Promise((resolve) => { serial.readyWaiter = resolve; setTimeout(() => resolve(null), 4000); });
    readLoop(port);
    await ready;
    try {
        const pong = await command('PING');
        if (!pong.startsWith('OK PONG')) throw new Error(pong);
        if (!pong.includes('PATLITE_V2')) {
            setConnection('Arduino のプログラムが古い版です。PatliteController.ino Ver.2.1 以降を書き込んでください。', 'bad');
        }
        const config = parseConfig(await command('CFG_GET'));
        if (config) applyConfig(config);
        else setConnection('Arduino から設定を読めませんでした（Ver.2.1 以降が必要）。既定の設定で動かします。', 'warn');
        serial.connected = true;
        state.lastEventCounter = null;
        setConnection(`Arduino に接続しました（${portLabel(port)}）`, 'good');
    } catch (error) {
        await closeSerial(`Arduino が応答しません: ${error.message}`);
    }
    render();
}

async function closeSerial(message) {
    const port = serial.port;
    serial.connected = false;
    serial.port = null;
    if (serial.pending) { clearTimeout(serial.pending.timer); serial.pending = null; }
    try { await serial.reader?.cancel(); } catch { /* 無視 */ }
    try { serial.writer?.releaseLock(); } catch { /* 無視 */ }
    serial.writer = null;
    serial.reader = null;
    try { await port?.close(); } catch { /* 無視 */ }
    state.lastStatus = null;
    setConnection(message || '切断しました。', 'warn');
    render();
}

function portLabel(port) {
    const info = port.getInfo?.() || {};
    return info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}` : 'シリアル';
}

function applyConfig(config) {
    state.config = config;
    engine.timing = { maxDisplay: config.maxDisplay, reminderInterval: config.reminderInterval, reminder: config.reminder, recovery: config.recovery };
    for (const [key, id] of [['maxDisplay', 'cfg-maxd'], ['reminderInterval', 'cfg-rint'], ['recovery', 'cfg-recv'], ['period', 'cfg-period'], ['hostTimeout', 'cfg-hto']]) {
        if (Number.isFinite(config[key])) $(id).value = String(config[key]);
    }
}

// ---------------- 1 秒ごとの処理 ----------------
async function tick() {
    state.ticks += 1;
    if (state.ticks % FETCH_EVERY_TICKS === 1) fetchState();
    if (state.ticks % HISTORY_EVERY_TICKS === 1) loadHistory();
    if (!serial.connected || state.busy) { render(); return; }
    state.busy = true;
    try {
        const status = parseStatus(await command('GET_STATUS'));
        if (!status) throw new Error('状態を読めませんでした。');
        const now = nowSeconds();
        if (Number.isFinite(status.eventCounter)) {
            if (state.lastEventCounter !== null && status.eventCounter !== state.lastEventCounter && ACK_EVENTS.has(status.event)) {
                engine.acknowledge(now);
                state.manualUntil = 0;
            }
            state.lastEventCounter = status.eventCounter;
        }
        state.lastStatus = status;
        if (!status.fullStop && state.manualUntil <= now && await maybeDailyIllumination(now)) {
            // 毎日の試験点灯を始めた（この間は自動表示を止める）
        } else if (!status.fullStop && state.manualUntil <= now) {
            const { lamps } = engine.pattern(now);
            if (!sameLamps(status.lamps, lamps)) {
                const reply = await command(setCommand(lamps));
                if (reply.startsWith('OK')) state.lastStatus = { ...status, lamps };
            }
        }
    } catch (error) {
        setConnection(`Arduino との通信で問題: ${error.message}`, 'warn');
    } finally {
        state.busy = false;
    }
    render();
}

async function fetchState() {
    try {
        const response = await fetch(API, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}`);
        const now = nowSeconds();
        const offset = now - Number(data.serverTime || now);
        const receivedAt = Number.isFinite(data.receivedAt) ? data.receivedAt + offset : null;
        engine.update(Array.isArray(data.conditions) ? data.conditions : [], receivedAt, offset, now);
        if (data.settings && !state.savingSettings) applySettings(data.settings);
        state.lastFetchOk = now;
        state.fetchMessage = receivedAt === null ? '自宅のブリッジからまだ一度も届いていません' : `自宅のブリッジからの最終受信: ${new Date(receivedAt * 1000).toLocaleString('ja-JP')}`;
        if (data.admin) $('admin-email').textContent = data.admin;
    } catch (error) {
        state.fetchMessage = `サイトから読めません（${error.message}）。ログインが切れた場合はページを再読み込みしてください。`;
    }
}

// ---------------- 表示 ----------------
function setConnection(text, tone) {
    const element = $('connection');
    element.textContent = text;
    element.className = `patlite-connection patlite-${tone}`;
}

const chips = (colors) => colors.length ? colors.map((color) => `<span class="patlite-chip patlite-${color}" title="${COLOR_NAMES[color]}"></span>${COLOR_NAMES[color]}`).join(' ') : '—';
const stateText = (item) => item.suppressed ? item.suppressed : item.acked ? 'ボタンで確認済み（消灯）' : !item.lit ? '表示時間を過ぎたため消灯' : item.flashing ? '点滅' : '点灯';
const flashText = (value) => {
    const base = value.flashSeconds === null ? '表示中ずっと点滅' : value.flashSeconds === 0 ? '点灯のみ' : `最初の${value.flashSeconds >= 60 ? `${value.flashSeconds / 60}分` : `${value.flashSeconds}秒`}点滅→点灯`;
    return `${base}（1回に最長 ${Math.round(engine.timing.maxDisplay / 60 * 10) / 10}分）`;
};

function render() {
    const now = nowSeconds();
    const { lamps, shown } = engine.pattern(now);
    const actual = state.lastStatus?.lamps;
    $('tower').innerHTML = COLORS.map((color) => {
        const mode = actual ? actual[color] : 'off';
        return `<div class="patlite-lamp patlite-${color} patlite-mode-${mode}"><span>${COLOR_NAMES[color]}</span></div>`;
    }).join('');
    const notes = [state.fetchMessage];
    if (!serial.connected) notes.push('Arduino 未接続（下の画面の色は、つないだときに点く予定の色です）');
    if (state.lastStatus?.fullStop) notes.push('Arduino は強制停止中（ボタン長押しで解除）');
    const policy = policyFor(state.settings, now);
    if (policy.snoozed) notes.push(`一時停止中: ${new Date(state.settings.snoozeUntil * 1000).toLocaleString('ja-JP')} まで全部消灯`);
    else if (policy.night) notes.push(`夜間モード中（${state.settings.night.start}〜${state.settings.night.end}）: 重大だけ点灯`);
    if (state.manualUntil > now) notes.push(`手動操作中: ${new Date(state.manualUntil * 1000).toLocaleTimeString('ja-JP')} まで自動表示を止めています`);
    if (state.lastFetchOk && now - state.lastFetchOk > LINK_TIMEOUT_SECONDS) notes.push('サイトから 3 分以上読めていません');
    $('meta').textContent = notes.join(' / ');
    $('planned').innerHTML = COLORS.map((color) => `<span class="patlite-plan">${COLOR_NAMES[color]}: ${{ off: '消灯', on: '点灯', flash: '点滅' }[lamps[color]]}</span>`).join('');
    $('shown').innerHTML = shown.length
        ? shown.map((item) => `<tr><td>${chips(item.colors)}</td><td>${esc(item.title)}</td><td>${stateText(item)}</td><td>${new Date(item.since * 1000).toLocaleString('ja-JP')}</td></tr>`).join('')
        : '<tr><td>—</td><td>すべて正常（消灯）</td><td>消灯</td><td>—</td></tr>';
    $('connect-btn').hidden = serial.connected;
    $('connect-any-btn').hidden = serial.connected;
    $('disconnect-btn').hidden = !serial.connected;
    for (const button of document.querySelectorAll('[data-needs-serial]')) button.disabled = !serial.connected;
}

function renderLegend() {
    $('legend').innerHTML = Object.values(LEGEND).map((value) => `<tr><td>${chips(value.colors)}</td><td>${esc(value.label)}</td><td>${flashText(value)}</td><td>${esc(value.until)}</td></tr>`).join('')
        + '<tr><td>—</td><td>すべて正常</td><td>消灯</td><td>—</td></tr>';
}

// ---------------- 履歴 ----------------
function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${Math.round(seconds)}秒`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間${Math.round((seconds % 3600) / 60)}分`;
    return `${Math.floor(seconds / 86400)}日${Math.round((seconds % 86400) / 3600)}時間`;
}

async function loadHistory() {
    const days = $('history-days').value;
    try {
        const response = await fetch(`${HISTORY_API}?days=${encodeURIComponent(days)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}`);
        const now = Number(data.serverTime) || nowSeconds();
        const ongoing = data.rows.filter((row) => row.endedAt === null).length;
        const counts = {};
        for (const row of data.rows) counts[row.kind] = (counts[row.kind] || 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([kind, count]) => `${LEGEND[kind]?.label?.split('（')[0] || kind} ${count}件`).join('・');
        $('history-summary').textContent = `直近${data.days}日: ${data.rows.length}件${data.truncated ? '（多いため最新500件）' : ''}、継続中 ${ongoing}件${top ? `（多い順: ${top}）` : ''}`;
        $('history').innerHTML = data.rows.length ? data.rows.map((row) => {
            const legend = LEGEND[row.kind];
            const end = row.endedAt === null ? '<strong>継続中</strong>' : new Date(row.endedAt * 1000).toLocaleString('ja-JP');
            return `<tr><td>${chips(legend?.colors || [])}</td><td>${esc(row.title)}${legend?.critical ? '（重大）' : ''}</td><td>${new Date(row.startedAt * 1000).toLocaleString('ja-JP')}</td><td>${end}</td><td>${duration((row.endedAt ?? now) - row.startedAt)}</td></tr>`;
        }).join('') : '<tr><td>—</td><td>この期間の記録はありません</td><td>—</td><td>—</td><td>—</td></tr>';
    } catch (error) {
        $('history-summary').textContent = `履歴を読めませんでした（${error.message}）`;
    }
}

// ---------------- 設定（サイトに保存。どの PC で開いても同じ） ----------------
function applySettings(settings) {
    state.settings = settings;
    engine.settings = settings;
    $('night-enabled').checked = Boolean(settings.night?.enabled);
    if (document.activeElement !== $('night-start')) $('night-start').value = settings.night?.start || '22:00';
    if (document.activeElement !== $('night-end')) $('night-end').value = settings.night?.end || '07:00';
    $('illum-daily').checked = Boolean(settings.illumination?.daily);
    if (document.activeElement !== $('illum-seconds')) $('illum-seconds').value = String(settings.illumination?.seconds || 20);
    const until = Number(settings.snoozeUntil);
    $('snooze-state').textContent = Number.isFinite(until) && until > nowSeconds()
        ? `一時停止中: ${new Date(until * 1000).toLocaleString('ja-JP')} まで` : '一時停止していません';
}

async function saveSettings(patch, message) {
    const next = { ...(state.settings || {}), ...patch };
    state.savingSettings = true;
    try {
        const response = await fetch(SETTINGS_API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(next) });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}`);
        applySettings(data.settings);
        setConnection(message, 'good');
    } catch (error) {
        setConnection(`設定を保存できませんでした: ${error.message}`, 'bad');
    } finally {
        state.savingSettings = false;
        render();
    }
}

function snooze(hours) {
    if (hours > 0 && !window.confirm(`${hours}時間、積層灯の自動表示を全部止めますか？（重大な障害・防災情報も点きません）`)) return;
    const until = hours > 0 ? nowSeconds() + hours * 3600 : null;
    saveSettings({ snoozeUntil: until }, hours > 0 ? `${hours}時間、自動表示を止めました。` : '一時停止を解除しました。');
}

function saveNight(event) {
    event.preventDefault();
    saveSettings({
        night: { enabled: $('night-enabled').checked, start: $('night-start').value, end: $('night-end').value },
        illumination: { daily: $('illum-daily').checked, seconds: Number($('illum-seconds').value) },
    }, '夜間モード・試験点灯の設定を保存しました。');
}

async function runIllumination(seconds) {
    try {
        const reply = await command(`ILLUM ${seconds}`);
        if (!reply.startsWith('OK')) throw new Error(reply === 'ERR UNKNOWN_COMMAND' ? 'Arduino のプログラムが古い版です（Ver.2.2 以降が必要）' : reply);
        state.manualUntil = nowSeconds() + seconds + 1;
        return true;
    } catch (error) {
        setConnection(`イルミネーション試験を始められませんでした: ${error.message}`, 'bad');
        return false;
    }
}

// 毎日のランダムな時刻の試験点灯（設定 ON・一時停止中でない・夜間でない・何も点いていないときだけ。1 日 1 回）
async function maybeDailyIllumination(now) {
    const settings = state.settings;
    if (!settings?.illumination?.daily) return false;
    const policy = policyFor(settings, now);
    if (policy.snoozed || policy.night) return false;
    const target = dailyIlluminationMinute(now);
    const minute = jstMinutes(now);
    if (minute < target || minute >= target + 3) return false;
    const day = new Date(now * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let done = state.illuminationDone;
    try { done = localStorage.getItem(ILLUMINATION_DONE_KEY) || done; } catch { /* 保存できなくても動く */ }
    if (done === day) return false;
    if (Object.values(engine.pattern(now).lamps).some((mode) => mode !== 'off')) return false;
    state.illuminationDone = day;
    try { localStorage.setItem(ILLUMINATION_DONE_KEY, day); } catch { /* 無視 */ }
    return runIllumination(Number(settings.illumination.seconds) || 20);
}

// ---------------- 操作 ----------------
async function manual(lampsMap, seconds) {
    state.manualUntil = nowSeconds() + seconds;
    try {
        await command(setCommand(lampsMap));
    } catch (error) {
        setConnection(`操作できませんでした: ${error.message}`, 'bad');
    }
    render();
}

// 物理ボタンの代わり: 確認（いま点いているものを消したままにする）
async function acknowledgeFromPage() {
    const now = nowSeconds();
    engine.acknowledge(now);
    state.manualUntil = 0;
    try {
        await command(setCommand(engine.pattern(now).lamps));
        setConnection('確認しました（いま点いていたものを消しました。新しい情報が来るとまた点きます）', 'good');
    } catch (error) {
        setConnection(`確認を送れませんでした: ${error.message}`, 'bad');
    }
    render();
}

// 物理ボタンの長押しの代わり: 強制停止（全停止）の切り替え
async function toggleFullStop() {
    const stopping = !state.lastStatus?.fullStop;
    if (stopping && !window.confirm('強制停止しますか？（解除するまで積層灯は何も点きません）')) return;
    try {
        const reply = await command(`FULL_STOP ${stopping ? 'ON' : 'OFF'}`);
        if (!reply.startsWith('OK')) throw new Error(reply);
        setConnection(stopping ? '強制停止しました。' : '強制停止を解除しました。', 'good');
    } catch (error) {
        setConnection(`強制停止を切り替えられませんでした: ${error.message}`, 'bad');
    }
    render();
}

async function saveConfig(event) {
    event.preventDefault();
    const values = { MAXD: $('cfg-maxd').value, RINT: $('cfg-rint').value, RECV: $('cfg-recv').value, PERIOD: $('cfg-period').value, HTO: $('cfg-hto').value };
    if (!Object.values(values).every((value) => /^\d+$/u.test(value))) { setConnection('設定は数字で入力してください。', 'bad'); return; }
    if (!window.confirm('この設定を Arduino に保存しますか？（次からどの PC につないでもこの設定で動きます）')) return;
    try {
        const reply = await command(`CFG_SET ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ')}`);
        const config = parseConfig(reply);
        if (!config) throw new Error(reply === 'ERR CFG_RANGE' ? '範囲外の値があります' : reply);
        applyConfig(config);
        setConnection('Arduino に設定を保存しました。', 'good');
    } catch (error) {
        setConnection(`保存できませんでした: ${error.message}`, 'bad');
    }
}

async function toggleWakeLock() {
    try {
        if (state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
        else if ('wakeLock' in navigator) {
            state.wakeLock = await navigator.wakeLock.request('screen');
            state.wakeLock.addEventListener('release', () => { state.wakeLock = null; updateWakeButton(); });
        }
    } catch (error) {
        setConnection(`画面を消さない設定にできませんでした: ${error.message}`, 'warn');
    }
    updateWakeButton();
}

function updateWakeButton() {
    $('wake-btn').textContent = state.wakeLock ? '画面を消さない: ON' : '画面を消さない: OFF';
}

function start() {
    renderLegend();
    if (!('serial' in navigator)) {
        setConnection('このブラウザは Web Serial に対応していません。PC か Chromebook の Chrome（または Edge）で開いてください。', 'bad');
        $('connect-btn').disabled = true;
    } else {
        setConnection('Arduino 未接続。「Arduino に接続」を押して、Arduino の USB ポートを選んでください。', 'warn');
        navigator.serial.getPorts().then((ports) => { if (ports[0]) openSerial(ports[0]); });
        navigator.serial.addEventListener('connect', (event) => { if (!serial.port) openSerial(event.target); });
        navigator.serial.addEventListener('disconnect', (event) => { if (serial.port === event.target) closeSerial('Arduino が外されました。挿し直すと自動でつながります。'); });
    }
    $('connect-btn').addEventListener('click', async () => {
        try {
            const port = await navigator.serial.requestPort({ filters: ARDUINO_FILTERS });
            await openSerial(port);
        } catch (error) {
            if (error?.name !== 'NotFoundError') setConnection(`接続できませんでした: ${error.message}`, 'bad');
            else setConnection('Arduino を選ばずに閉じました。一覧に出ない場合は「すべての機器から選ぶ」か、下の手順を試してください。', 'warn');
        }
    });
    // 互換機などで識別番号が違うと、絞り込んだ一覧に出ない。絞り込まずに全部のシリアル機器から選ぶ
    $('connect-any-btn').addEventListener('click', async () => {
        try {
            const port = await navigator.serial.requestPort();
            await openSerial(port);
        } catch (error) {
            if (error?.name !== 'NotFoundError') setConnection(`接続できませんでした: ${error.message}`, 'bad');
            else setConnection('シリアル機器が 1 つも見つかりませんでした。下の「対応デバイスが見つかりません」と出るときの手順を確認してください。', 'bad');
        }
    });
    $('disconnect-btn').addEventListener('click', () => closeSerial('切断しました。'));
    $('resume-btn').addEventListener('click', () => { state.manualUntil = 0; render(); });
    $('ack-btn').addEventListener('click', acknowledgeFromPage);
    $('fullstop-btn').addEventListener('click', toggleFullStop);
    $('all-off-btn').addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, 'off'])), 60));
    for (const color of COLORS) {
        $(`test-${color}`).addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, c === color ? 'flash' : 'off'])), 10));
    }
    $('config-form').addEventListener('submit', saveConfig);
    for (const button of document.querySelectorAll('[data-snooze-hours]')) {
        button.addEventListener('click', () => snooze(Number(button.dataset.snoozeHours)));
    }
    $('night-form').addEventListener('submit', saveNight);
    $('history-btn').addEventListener('click', loadHistory);
    $('history-days').addEventListener('change', loadHistory);
    $('illum-btn').addEventListener('click', () => runIllumination(Number($('illum-seconds').value) || 20).then(render));
    $('wake-btn').addEventListener('click', toggleWakeLock);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.wakeLock === null && $('wake-btn').dataset.want === '1') toggleWakeLock(); });
    $('wake-btn').addEventListener('click', () => { $('wake-btn').dataset.want = state.wakeLock ? '0' : '1'; });
    updateWakeButton();
    const ticker = new Worker('ticker.js');
    ticker.addEventListener('message', () => { tick(); });
    fetchState().then(render);
}

start();
