// 積層灯（PATLITE）管理ページ。Chrome / Edge の Web Serial で、この PC（Chromebook 可）に USB でつないだ
// Arduino（PatliteController.ino Ver.2.1 以降）を直接操作する。アプリのインストールや Python は不要。
//   - 5 秒ごとに /site/patlite-admin/api/state（自宅の積層灯ブリッジが送った「いま起きていること」）を読む
//   - 1 秒ごとに Arduino の状態を読み（GET_STATUS）、表示すべき色と違えば SET を送る
//   - 表示時間などの設定は Arduino の EEPROM に保存されている（CFG_GET / CFG_SET）。どの PC につないでも同じ設定で動く
//   - 一度つないだ Arduino は、次からはページを開く・USB を挿すだけで自動でつながる
import { COLORS, COLOR_NAMES, LEGEND, ACK_EVENTS, LINK_TIMEOUT_SECONDS, PatliteEngine, parseConfig, parseStatus, sameLamps, setCommand } from './logic.js';

const API = '/site/patlite-admin/api/state';
const FETCH_EVERY_TICKS = 5;
const ARDUINO_FILTERS = [{ usbVendorId: 0x2341 }, { usbVendorId: 0x2A03 }, { usbVendorId: 0x1A86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x10C4 }];
const $ = (id) => document.getElementById(id);
const nowSeconds = () => Date.now() / 1000;
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const engine = new PatliteEngine(nowSeconds());
const serial = { port: null, reader: null, writer: null, buffer: '', pending: null, chain: Promise.resolve(), readyWaiter: null, connected: false };
const state = { lastStatus: null, lastEventCounter: null, manualUntil: 0, ticks: 0, fetchMessage: '未取得', lastFetchOk: null, busy: false, config: null, wakeLock: null };

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
    for (const [key, id] of [['maxDisplay', 'cfg-maxd'], ['reminderInterval', 'cfg-rint'], ['reminder', 'cfg-rlen'], ['recovery', 'cfg-recv'], ['period', 'cfg-period'], ['hostTimeout', 'cfg-hto']]) {
        if (Number.isFinite(config[key])) $(id).value = String(config[key]);
    }
}

// ---------------- 1 秒ごとの処理 ----------------
async function tick() {
    state.ticks += 1;
    if (state.ticks % FETCH_EVERY_TICKS === 1) fetchState();
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
        if (!status.fullStop && state.manualUntil <= now) {
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
const stateText = (item) => item.acked ? 'ボタンで確認済み（消灯）' : !item.lit ? '表示時間を過ぎたため消灯' : item.flashing ? '点滅' : '点灯';
const flashText = (value) => {
    const base = value.flashSeconds === null ? '表示中ずっと点滅' : value.flashSeconds === 0 ? '点灯のみ' : `最初の${value.flashSeconds >= 60 ? `${value.flashSeconds / 60}分` : `${value.flashSeconds}秒`}点滅→点灯`;
    return value.remind ? `${base}（続く間は定期的に再表示）` : base;
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
    if (state.lastStatus?.fullStop) notes.push('Arduino は全停止中（ボタン 5 秒で解除）');
    if (state.manualUntil > now) notes.push(`手動操作中: ${new Date(state.manualUntil * 1000).toLocaleTimeString('ja-JP')} まで自動表示を止めています`);
    if (state.lastFetchOk && now - state.lastFetchOk > LINK_TIMEOUT_SECONDS) notes.push('サイトから 3 分以上読めていません');
    $('meta').textContent = notes.join(' / ');
    $('planned').innerHTML = COLORS.map((color) => `<span class="patlite-plan">${COLOR_NAMES[color]}: ${{ off: '消灯', on: '点灯', flash: '点滅' }[lamps[color]]}</span>`).join('');
    $('shown').innerHTML = shown.length
        ? shown.map((item) => `<tr><td>${chips(item.colors)}</td><td>${esc(item.title)}</td><td>${stateText(item)}</td><td>${new Date(item.since * 1000).toLocaleString('ja-JP')}</td></tr>`).join('')
        : '<tr><td>—</td><td>すべて正常（消灯）</td><td>消灯</td><td>—</td></tr>';
    $('connect-btn').hidden = serial.connected;
    $('disconnect-btn').hidden = !serial.connected;
    for (const button of document.querySelectorAll('[data-needs-serial]')) button.disabled = !serial.connected;
}

function renderLegend() {
    $('legend').innerHTML = Object.values(LEGEND).map((value) => `<tr><td>${chips(value.colors)}</td><td>${esc(value.label)}</td><td>${flashText(value)}</td><td>${esc(value.until)}</td></tr>`).join('')
        + '<tr><td>—</td><td>すべて正常</td><td>消灯</td><td>—</td></tr>';
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

async function saveConfig(event) {
    event.preventDefault();
    const values = { MAXD: $('cfg-maxd').value, RINT: $('cfg-rint').value, RLEN: $('cfg-rlen').value, RECV: $('cfg-recv').value, PERIOD: $('cfg-period').value, HTO: $('cfg-hto').value };
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
        }
    });
    $('disconnect-btn').addEventListener('click', () => closeSerial('切断しました。'));
    $('resume-btn').addEventListener('click', () => { state.manualUntil = 0; render(); });
    $('all-off-btn').addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, 'off'])), 60));
    for (const color of COLORS) {
        $(`test-${color}`).addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, c === color ? 'flash' : 'off'])), 10));
    }
    $('config-form').addEventListener('submit', saveConfig);
    $('wake-btn').addEventListener('click', toggleWakeLock);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.wakeLock === null && $('wake-btn').dataset.want === '1') toggleWakeLock(); });
    $('wake-btn').addEventListener('click', () => { $('wake-btn').dataset.want = state.wakeLock ? '0' : '1'; });
    updateWakeButton();
    const ticker = new Worker('ticker.js');
    ticker.addEventListener('message', () => { tick(); });
    fetchState().then(render);
}

start();
