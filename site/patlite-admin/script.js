// 積層灯（PATLITE）管理ページ。Chrome / Edge の Web Serial で、この PC（Chromebook 可）に USB でつないだ
// Arduino（PatliteController.ino Ver.2.1 以降）を直接操作する。アプリのインストールや Python は不要。
//   - 5 秒ごとに /site/patlite-admin/api/state（自宅の積層灯ブリッジが送った「いま起きていること」）を読む
//   - 1 秒ごとに Arduino の状態を読み（GET_STATUS）、表示すべき色と違えば SET を送る
//   - 表示時間などの設定は Arduino の EEPROM に保存されている（CFG_GET / CFG_SET）。どの PC につないでも同じ設定で動く
//   - 一度つないだ Arduino は、次からはページを開く・USB を挿すだけで自動でつながる。通信が切れたら 15 秒ごとにつなぎ直す（「切断」を押したときを除く）
//   - Access のログインが切れても、保存した鍵（lamp-key.js）と保存したページ本体（sw.js）で、再読み込み・再起動の後も表示を続ける
//   - Arduino の強制停止の状態を、変わったときと 5 分ごとにサイトへ知らせる（履歴の「強制停止により無連動」に使う）
import { COLORS, COLOR_NAMES, LEGEND, ACK_EVENTS, ACK_DELAY_SECONDS, FILTER_LEVELS, LINK_TIMEOUT_SECONDS, MAX_RECOVERY_SECONDS, PatliteEngine, colorText, dailyIlluminationMinute, filterText, flashText, jstMinutes, legendByLevel, parseConfig, parseStatus, policyFor, sameLamps, setCommand, snoozeText } from './logic.js';

import { COMMAND_DONE_API, DEVICE_API, STATE_API as API, lamp, lampFetch, openedForLogin, registerShell, renewLampKey } from './lamp-key.js';

const SETTINGS_API = '/site/patlite-admin/api/settings';
const HISTORY_API = '/site/patlite-admin/api/history';
const RECONNECT_EVERY_TICKS = 15;   // 通信が切れた Arduino へ、つなぎ直しを試す間隔（秒）
const MAX_STATUS_FAILURES = 5;      // 状態を続けて読めない回数がこれになったら、一度閉じてつなぎ直す
const DEVICE_REPORT_SECONDS = 300;
const MAX_FILTER_HOURS = 168;
const handledCommands = new Set();   // このページで処理済み（取れなかったものも含む）の依頼 ID
const HISTORY_EVERY_TICKS = 60;
const ILLUMINATION_DONE_KEY = 'patlite-illumination-done';
const TRANSPORT_KEY = 'patlite-transport';   // 'usb' なら次回も WebUSB で自動接続
let usbSerialModule = null;

// WebUSB 版（web-serial-polyfill）を必要なときだけ読み込む
async function usbSerial() {
    if (!('usb' in navigator)) throw new Error('このブラウザは WebUSB に対応していません。');
    usbSerialModule = usbSerialModule || await import('./vendor/web-serial-polyfill.js');
    return usbSerialModule.serial;
}

function rememberTransport(value) {
    try { localStorage.setItem(TRANSPORT_KEY, value); } catch { /* 保存できなくても動く */ }
}

function savedTransport() {
    try { return localStorage.getItem(TRANSPORT_KEY) || 'serial'; } catch { return 'serial'; }
}
const FETCH_EVERY_TICKS = 5;
const ARDUINO_FILTERS = [{ usbVendorId: 0x2341 }, { usbVendorId: 0x2A03 }, { usbVendorId: 0x1A86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x10C4 }];
const $ = (id) => document.getElementById(id);
const nowSeconds = () => Date.now() / 1000;
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const engine = new PatliteEngine(nowSeconds());
const serial = { port: null, reader: null, writer: null, buffer: '', pending: null, chain: Promise.resolve(), readyWaiter: null, connected: false, opening: false, manualClose: false, failures: 0 };
const state = { settings: null, savingSettings: false, illuminationDone: '', lastStatus: null, lastEventCounter: null, manualUntil: 0, ticks: 0, fetchMessage: '未取得', lastFetchOk: null, busy: false, config: null, wakeLock: null, reportedFullStop: null, reportedAt: 0 };

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
    if (serial.port === port) await closeSerial('Arduino との通信が切れました。自動でつなぎ直します。');
}

function command(text, timeoutMs = 1500) {
    const run = () => new Promise((resolve, reject) => {
        if (!serial.writer) { reject(new Error('Arduino に接続していません。')); return; }
        const timer = setTimeout(() => { serial.pending = null; reject(new Error(`応答がありません（${text.split(' ')[0]}）`)); }, timeoutMs);
        serial.pending = { resolve, reject, timer };
        serial.writer.write(new TextEncoder().encode(`${text}\n`)).catch((error) => { clearTimeout(timer); serial.pending = null; reject(error); });
    });
    const result = serial.chain.then(run, run);
    serial.chain = result.catch(() => {});
    return result;
}

async function openSerial(port) {
    if (serial.port || serial.opening) return;
    serial.opening = true;
    try { await openPort(port); } finally { serial.opening = false; }
}

async function openPort(port) {
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
        serial.manualClose = false;
        serial.failures = 0;
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
    // 返事待ちの命令は必ず終わらせる（終わらせないと、後の命令がずっと順番待ちになり、つなぎ直しても未接続のままになる）
    if (serial.pending) {
        const { reject, timer } = serial.pending;
        serial.pending = null;
        clearTimeout(timer);
        reject(new Error('通信が切れました。'));
    }
    try { await serial.reader?.cancel(); } catch { /* 無視 */ }
    try { serial.writer?.releaseLock(); } catch { /* 無視 */ }
    serial.writer = null;
    serial.reader = null;
    try { await port?.close(); } catch { /* 無視 */ }
    state.lastStatus = null;
    setConnection(message || '切断しました。', 'warn');
    render();
}

// 通信が切れた Arduino へつなぎ直す（許可済みの機器だけ。「切断」を押した後・ログインし直すためのタブでは行わない）
async function reconnectSerial() {
    if (serial.port || serial.opening || serial.manualClose || openedForLogin()) return;
    try {
        const source = savedTransport() === 'usb' ? await usbSerial() : navigator.serial;
        const ports = source ? await source.getPorts() : [];
        if (ports[0] && !serial.port) await openSerial(ports[0]);
    } catch (error) {
        console.warn('serial reconnect failed', error);
    }
}

function portLabel(port) {
    const info = port.getInfo?.() || {};
    return info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}` : 'シリアル';
}

function applyConfig(config) {
    state.config = config;
    // 復旧の緑は最長 5 秒。古い Arduino（RECV=60 が残っている）でも 5 秒にし、次に「Arduino に保存」すると 5 が書き込まれる
    const recovery = Math.min(Number(config.recovery) || 0, MAX_RECOVERY_SECONDS);
    engine.timing = { maxDisplay: config.maxDisplay, reminderInterval: config.reminderInterval, reminder: config.reminder, recovery };
    for (const [key, id] of [['maxDisplay', 'cfg-maxd'], ['reminderInterval', 'cfg-rint'], ['recovery', 'cfg-recv'], ['period', 'cfg-period'], ['hostTimeout', 'cfg-hto']]) {
        if (Number.isFinite(config[key])) $(id).value = String(key === 'recovery' ? recovery : config[key]);
    }
}

// ---------------- 1 秒ごとの処理 ----------------
async function tick() {
    state.ticks += 1;
    if (state.ticks % FETCH_EVERY_TICKS === 1) fetchState();
    if (state.ticks % HISTORY_EVERY_TICKS === 1) loadHistory();
    if (!serial.connected && state.ticks % RECONNECT_EVERY_TICKS === 0) reconnectSerial();
    if (!serial.connected || state.busy) { render(); return; }
    state.busy = true;
    try {
        const status = parseStatus(await command('GET_STATUS'));
        if (!status) throw new Error('状態を読めませんでした。');
        serial.failures = 0;
        const now = nowSeconds();
        if (status.ackPending) engine.dismissRecovered();   // ボタンの短押しを受け付けた: 復旧の緑はすぐ消す（ほかは 3 秒後）
        engine.device = { fullStop: status.fullStop };
        reportDevice(status.fullStop, now);
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
        serial.failures += 1;
        if (serial.failures >= MAX_STATUS_FAILURES && serial.connected) await closeSerial('Arduino から返事がありません。自動でつなぎ直します。');
        else if (serial.connected) setConnection(`Arduino との通信で問題: ${error.message}`, 'warn');
    } finally {
        state.busy = false;
    }
    render();
}

async function fetchState() {
    try {
        const { response, data } = await lampFetch(API, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok || !data?.success) throw new Error(data?.message || `HTTP ${response.status}`);
        if (!lamp.viaKey) renewLampKey();
        const now = nowSeconds();
        const offset = now - Number(data.serverTime || now);
        const receivedAt = Number.isFinite(data.receivedAt) ? data.receivedAt + offset : null;
        engine.update(Array.isArray(data.conditions) ? data.conditions : [], receivedAt, offset, now);
        if (data.settings && !state.savingSettings) applySettings(data.settings);
        if (!serial.connected) engine.device = data.device || null;   // つないでいないときは、サイトに残っている強制停止の状態を使う
        if (Array.isArray(data.commands) && data.commands.length) processCommands(data.commands);
        state.lastFetchOk = now;
        state.fetchMessage = receivedAt === null ? '自宅のブリッジからまだ一度も届いていません' : `自宅のブリッジからの最終受信: ${new Date(receivedAt * 1000).toLocaleString('ja-JP')}`;
        if (lamp.viaKey) state.fetchMessage += '／ログインが切れています（積層灯の表示は続けています）';
        if (data.admin) $('admin-email').textContent = data.admin;
    } catch (error) {
        state.fetchMessage = `サイトから読めません（${error.message}）`;
    }
}

// Arduino の強制停止の状態をサイトへ知らせる（変わったときと 5 分ごと。失敗したら次の回に送る）
function reportDevice(fullStop, now) {
    if (state.reportedFullStop === fullStop && now - state.reportedAt < DEVICE_REPORT_SECONDS) return;
    state.reportedFullStop = fullStop;
    state.reportedAt = now;
    lampFetch(DEVICE_API, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ fullStop }) })
        .then(({ response }) => { if (!response.ok) state.reportedAt = 0; })
        .catch(() => { state.reportedAt = 0; });
}

// ---------------- 表示 ----------------
function setConnection(text, tone) {
    const element = $('connection');
    element.textContent = text;
    element.className = `patlite-connection patlite-${tone}`;
}

const chips = (colors) => colors.length ? colors.map((color) => `<span class="patlite-chip patlite-${color}" title="${COLOR_NAMES[color]}"></span>${COLOR_NAMES[color]}`).join(' ') : '—';
const levelBadge = (level) => level ? `<span class="patlite-level patlite-level-${esc(level)}">${esc(level)}</span>` : '—';
// 色見本（2 色の組み合わせは 2 つ並べる。点滅するものは見本も点滅）
const swatches = (colors, flashing) => `<span class="patlite-swatches">${colors.map((color) => `<span class="patlite-swatch patlite-${color}${flashing ? ' patlite-swatch-flash' : ''}" title="${COLOR_NAMES[color]}"></span>`).join('')}</span>`;
const stateText = (item) => item.suppressed ? `<span class="patlite-suppressed">${esc(item.suppressed)}</span>`
    : item.acked ? '確認済み（消灯）' : !item.lit ? (item.repeat ? '表示時間を過ぎたため消灯（続けばまた点灯）' : '表示を終えた（繰り返さない）') : item.flashing ? '点滅' : '点灯';

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
    if (policy.snoozed) notes.push(snoozeText(state.settings, now));
    else if (filterText(state.settings, now)) notes.push(filterText(state.settings, now));
    if (engine.ackDueAt !== null) notes.push(`確認を受け付けました（${Math.max(0, Math.ceil(engine.ackDueAt - now))}秒後に消灯）`);
    if (state.manualUntil > now) notes.push(`手動操作中: ${new Date(state.manualUntil * 1000).toLocaleTimeString('ja-JP')} まで自動表示を止めています`);
    if (state.lastFetchOk && now - state.lastFetchOk > LINK_TIMEOUT_SECONDS) notes.push('サイトから 3 分以上読めていません');
    $('meta').textContent = notes.join(' / ');
    $('planned').innerHTML = COLORS.map((color) => `<span class="patlite-plan">${COLOR_NAMES[color]}: ${{ off: '消灯', on: '点灯', flash: '点滅' }[lamps[color]]}</span>`).join('');
    $('shown').innerHTML = shown.length
        ? shown.map((item) => `<tr><td>${chips(item.colors)}</td><td>${levelBadge(item.level)}</td><td>${esc(item.title)}</td><td>${stateText(item)}</td><td>${new Date(item.since * 1000).toLocaleString('ja-JP')}</td></tr>`).join('')
        : '<tr><td>—</td><td>—</td><td>すべて正常（消灯）</td><td>消灯</td><td>—</td></tr>';
    $('login-notice').hidden = !lamp.loginLost;
    $('login-notice-text').textContent = lamp.viaKey
        ? 'Cloudflare のログインが切れています。積層灯の表示は続けています。設定の変更・履歴は、ログインし直すと使えます。'
        : 'サイトから読めません。Cloudflare のログインが切れている可能性があります。ログインし直すまで、積層灯に新しい情報は出ません。';
    $('connect-btn').hidden = serial.connected;
    $('connect-any-btn').hidden = serial.connected;
    $('connect-usb-btn').hidden = serial.connected || !('usb' in navigator);
    $('disconnect-btn').hidden = !serial.connected;
    for (const button of document.querySelectorAll('[data-needs-serial]')) button.disabled = !serial.connected;
}

const LEVEL_NOTES = { 重大: '時間帯設定・絞り込みの「重大のみ」でも点く', 中: '「中以上」なら点く（「重大のみ」の間は点かない）', 軽: '時間帯設定・絞り込みの間は点かない' };
// 色の一覧: 重大 / 中 / 軽 ごとに、色見本（2 色は 2 つ）・色の名前・点滅・内容・消えるまで
function renderLegend() {
    $('legend').innerHTML = legendByLevel().map(({ level, items }) => `<div><h3>${levelBadge(level)} ${esc(LEVEL_NOTES[level])}</h3><div class="table-wrap"><table><thead><tr><th>色</th><th>点き方</th><th>情報・障害</th><th>消えるまで</th></tr></thead><tbody>${
        items.map((value) => `<tr><td>${swatches(value.colors, value.flashSeconds !== 0)} ${esc(colorText(value.colors))}</td><td>${esc(flashText(value.flashSeconds))}</td><td>${esc(value.label)}${value.group === '防災' ? '（防災）' : ''}</td><td>${esc(value.until)}</td></tr>`).join('')
    }</tbody></table></div></div>`).join('') + '<p class="muted">すべて正常なときは全部消灯。</p>';
}

// ---------------- 遠隔操作（操作盤ページなどからの依頼） ----------------
// Arduino につながっているときだけ、依頼を「取って」から実行する（複数のページが開いていても 1 回だけ）
async function processCommands(commands) {
    if (!serial.connected) return;
    for (const item of commands) {
        if (!item?.id || handledCommands.has(item.id)) continue;
        handledCommands.add(item.id);
        try {
            const { response, data } = await lampFetch(COMMAND_DONE_API, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ id: item.id }) });
            if (!response.ok || !data?.claimed) continue;   // 別のページが先に実行した・期限切れ
        } catch {
            continue;
        }
        if (item.command === 'ack') await acknowledgeFromPage();
        else if (item.command === 'fullstop_on' || item.command === 'fullstop_off') await setFullStop(item.command === 'fullstop_on');
        else if (item.command === 'illum') await runIllumination(Number(item.args?.seconds) || 20);
        setConnection(`遠隔操作を実行しました（${{ ack: '確認', fullstop_on: '強制停止', fullstop_off: '強制停止の解除', illum: 'イルミネーション試験' }[item.command] || item.command}）`, 'good');
    }
    render();
}

// 強制停止を指定した向きにする（遠隔操作用。確認ダイアログは出さない）
async function setFullStop(stopping) {
    try {
        const reply = await command(`FULL_STOP ${stopping ? 'ON' : 'OFF'}`);
        if (!reply.startsWith('OK')) throw new Error(reply);
    } catch (error) {
        setConnection(`強制停止を切り替えられませんでした: ${error.message}`, 'bad');
    }
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
        const muted = data.rows.filter((row) => row.suppressed).length;
        const counts = {};
        for (const row of data.rows) counts[row.kind] = (counts[row.kind] || 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([kind, count]) => `${LEGEND[kind]?.label?.split('（')[0] || kind} ${count}件`).join('・');
        $('history-summary').textContent = `直近${data.days}日: ${data.rows.length}件${data.truncated ? '（多いため最新500件）' : ''}、継続中 ${ongoing}件、無連動 ${muted}件${top ? `（多い順: ${top}）` : ''}`;
        $('history').innerHTML = data.rows.length ? data.rows.map((row) => {
            const legend = LEGEND[row.kind];
            const end = row.endedAt === null ? '<strong>継続中</strong>' : new Date(row.endedAt * 1000).toLocaleString('ja-JP');
            const lamp = row.suppressed ? `<span class="patlite-suppressed">${esc(row.suppressed)}</span>` : '連動';
            return `<tr><td>${chips(legend?.colors || [])}</td><td>${levelBadge(legend?.level)}</td><td>${esc(row.title)}</td><td>${lamp}</td><td>${new Date(row.startedAt * 1000).toLocaleString('ja-JP')}</td><td>${end}</td><td>${duration((row.endedAt ?? now) - row.startedAt)}</td></tr>`;
        }).join('') : '<tr><td>—</td><td>—</td><td>この期間の記録はありません</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>';
    } catch (error) {
        $('history-summary').textContent = `履歴を読めませんでした（${error.message}）`;
    }
}

// ---------------- 設定（サイトに保存。どの PC で開いても同じ） ----------------
function applySettings(settings) {
    state.settings = settings;
    engine.settings = settings;
    $('night-enabled').checked = Boolean(settings.night?.enabled);
    if (document.activeElement !== $('night-level')) $('night-level').value = settings.night?.level === 'medium' ? 'medium' : 'critical';
    const policy = policyFor(settings, nowSeconds());
    $('filter-state').textContent = policy.temporary ? filterText({ filter: settings.filter }, nowSeconds()) : '絞り込みしていません';
    if (policy.temporary && document.activeElement !== $('filter-level')) $('filter-level').value = policy.temporary;
    if (document.activeElement !== $('night-start')) $('night-start').value = settings.night?.start || '22:00';
    if (document.activeElement !== $('night-end')) $('night-end').value = settings.night?.end || '07:00';
    $('illum-daily').checked = Boolean(settings.illumination?.daily);
    if (document.activeElement !== $('illum-seconds')) $('illum-seconds').value = String(settings.illumination?.seconds || 20);
    $('snooze-state').textContent = snoozeText(settings, nowSeconds()) || '一時停止していません';
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
    if (hours === 'forever') {
        if (!window.confirm('積層灯の自動表示を無期限に止めますか？（解除するまで、重大な障害・防災情報も点きません）')) return;
        saveSettings({ snoozeUntil: null, snoozeForever: true }, '自動表示を無期限に止めました（「一時停止を解除」で戻ります）。');
        return;
    }
    if (hours > 0 && !window.confirm(`${hours}時間、積層灯の自動表示を全部止めますか？（重大な障害・防災情報も点きません）`)) return;
    const until = hours > 0 ? nowSeconds() + hours * 3600 : null;
    saveSettings({ snoozeUntil: until, snoozeForever: false }, hours > 0 ? `${hours}時間、自動表示を止めました。` : '一時停止を解除しました。');
}

function saveNight(event) {
    event.preventDefault();
    saveSettings({
        night: { enabled: $('night-enabled').checked, start: $('night-start').value, end: $('night-end').value, level: $('night-level').value },
        illumination: { daily: $('illum-daily').checked, seconds: Number($('illum-seconds').value) },
    }, '時間帯設定・試験点灯の設定を保存しました。');
}

// 一時的な絞り込み: 今から N 時間は「重大のみ」か「中以上」だけ点ける（最長 7 日）
function saveFilter(event) {
    event.preventDefault();
    const hours = Number($('filter-hours').value);
    if (!Number.isFinite(hours) || hours <= 0) { setConnection('時間を正しく入れてください（0.5〜168）。', 'bad'); return; }
    const value = Math.min(MAX_FILTER_HOURS, Math.max(0.5, Math.round(hours * 2) / 2));
    const level = $('filter-level').value === 'medium' ? 'medium' : 'critical';
    saveSettings({ filter: { until: nowSeconds() + Math.round(value * 3600), level } }, `${value}時間、${FILTER_LEVELS[level].label}にしました。`);
}

function clearFilter() {
    saveSettings({ filter: { until: null, level: $('filter-level').value === 'medium' ? 'medium' : 'critical' } }, '一時的な絞り込みを解除しました。');
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
    if (policy.snoozed || policy.night || policy.temporary) return false;
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

// 物理ボタンの代わり: 確認（復旧の緑はすぐ、ほかは 3 秒後に消して、消したままにする）。消すのは 1 秒ごとの処理で行う
async function acknowledgeFromPage() {
    const now = nowSeconds();
    engine.requestAck(now);
    state.manualUntil = 0;
    try {
        await command(setCommand(engine.pattern(now).lamps));
        setConnection(`確認しました（${ACK_DELAY_SECONDS}秒後にいま点いているものを消します。新しい情報が来るとまた点きます）`, 'good');
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
    if (Number(values.RECV) > MAX_RECOVERY_SECONDS) { setConnection(`復旧の緑は 0〜${MAX_RECOVERY_SECONDS} 秒にしてください。`, 'bad'); return; }
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
    registerShell('sw.js');
    renderLegend();
    if (!('serial' in navigator)) {
        setConnection('このブラウザは Web Serial に対応していません。PC か Chromebook の Chrome（または Edge）で開いてください。', 'bad');
        $('connect-btn').disabled = true;
    } else {
        setConnection('Arduino 未接続。「Arduino に接続」を押して、Arduino の USB ポートを選んでください。', 'warn');
        if (savedTransport() !== 'usb' && !openedForLogin()) navigator.serial.getPorts().then((ports) => { if (ports[0]) openSerial(ports[0]); });
        navigator.serial.addEventListener('connect', (event) => { if (!serial.port && !openedForLogin()) openSerial(event.target); });
        navigator.serial.addEventListener('disconnect', (event) => { if (serial.port === event.target) closeSerial('Arduino が外されました。挿し直すと自動でつながります。'); });
    }
    $('connect-btn').addEventListener('click', async () => {
        try {
            const port = await navigator.serial.requestPort({ filters: ARDUINO_FILTERS });
            rememberTransport('serial');
            await openSerial(port);
        } catch (error) {
            if (error?.name !== 'NotFoundError') setConnection(`接続できませんでした: ${error.message}`, 'bad');
            else setConnection('Arduino を選ばずに閉じました。一覧に出ない場合は「すべての機器から選ぶ」か、下の手順を試してください。', 'warn');
        }
    });
    // Chromebook で Web Serial の一覧に出ないとき: WebUSB で直接（CDC-ACM）やりとりする
    $('connect-usb-btn').addEventListener('click', async () => {
        try {
            const port = await (await usbSerial()).requestPort({ filters: ARDUINO_FILTERS });
            rememberTransport('usb');
            await openSerial(port);
        } catch (error) {
            if (error?.name === 'NotFoundError') setConnection('Arduino を選ばずに閉じました。', 'warn');
            else setConnection(`WebUSB で接続できませんでした: ${error.message}`, 'bad');
        }
    });
    if ('usb' in navigator) {
        if (savedTransport() === 'usb' && !openedForLogin()) {
            usbSerial().then((usb) => usb.getPorts()).then((ports) => { if (ports[0] && !serial.port) openSerial(ports[0]); }).catch(() => {});
        }
        navigator.usb.addEventListener('connect', () => {
            if (serial.port || savedTransport() !== 'usb' || openedForLogin()) return;
            usbSerial().then((usb) => usb.getPorts()).then((ports) => { if (ports[0] && !serial.port) openSerial(ports[0]); }).catch(() => {});
        });
        navigator.usb.addEventListener('disconnect', (event) => {
            if (serial.port && serial.port.device_ === event.device) closeSerial('Arduino が外されました。挿し直すと自動でつながります。');
        });
    } else {
        $('connect-usb-btn').hidden = true;
    }
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
    $('disconnect-btn').addEventListener('click', () => { serial.manualClose = true; closeSerial('切断しました。'); });
    $('resume-btn').addEventListener('click', () => { state.manualUntil = 0; render(); });
    $('ack-btn').addEventListener('click', acknowledgeFromPage);
    $('fullstop-btn').addEventListener('click', toggleFullStop);
    $('all-off-btn').addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, 'off'])), 60));
    for (const color of COLORS) {
        $(`test-${color}`).addEventListener('click', () => manual(Object.fromEntries(COLORS.map((c) => [c, c === color ? 'flash' : 'off'])), 10));
    }
    $('config-form').addEventListener('submit', saveConfig);
    for (const button of document.querySelectorAll('[data-snooze-hours]')) {
        button.addEventListener('click', () => snooze(button.dataset.snoozeHours === 'forever' ? 'forever' : Number(button.dataset.snoozeHours)));
    }
    $('night-form').addEventListener('submit', saveNight);
    $('filter-form').addEventListener('submit', saveFilter);
    $('filter-clear').addEventListener('click', clearFilter);
    $('history-btn').addEventListener('click', loadHistory);
    $('history-days').addEventListener('change', loadHistory);
    $('illum-btn').addEventListener('click', () => runIllumination(Number($('illum-seconds').value) || 20).then(render));
    $('wake-btn').addEventListener('click', toggleWakeLock);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.wakeLock === null && $('wake-btn').dataset.want === '1') toggleWakeLock(); });
    $('wake-btn').addEventListener('click', () => { $('wake-btn').dataset.want = state.wakeLock ? '0' : '1'; });
    updateWakeButton();
    if (openedForLogin()) setConnection('ログインし直しました。このタブは閉じて、積層灯のタブに戻ってください（積層灯のタブはそのまま続きます）。', 'good');
    const ticker = new Worker('ticker.js');
    ticker.addEventListener('message', () => { tick(); });
    fetchState().then(render);
}

start();
