// 積層灯（PATLITE）管理ページの判定ロジック（画面・シリアルに依存しない部分。tests/patlite-admin.test.js で試験）。
// Arduino積層灯制御システム server/dpi_status.py と同じ決まり:
//   赤 = 配信が止まる重大障害 / 黄 = 一部の障害・注意 / 青 = AWS 側・監視の途絶 / 白 = 防災情報 / 緑 = 復旧。
//   正常なときは消灯。1 項目を点けるのは最長 maxDisplay 秒。重大障害（remind）は続く間 reminderInterval 秒ごとに
//   reminder 秒だけ点滅で再表示。点滅は色ごと（Arduino がリレーの ON/OFF で点滅させる）。

export const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue', 'white']);
export const COLOR_NAMES = Object.freeze({ red: '赤', yellow: '黄', green: '緑', blue: '青', white: '白' });
const SERIAL_KEYS = Object.freeze({ red: 'R', yellow: 'Y', green: 'G', blue: 'B', white: 'W' });

const item = (colors, flashSeconds, remind, group, label, until) => Object.freeze({ colors, flashSeconds, remind, group, label, until, critical: false });
export const LEGEND = Object.freeze({
    home_critical: Object.freeze({ ...item(['red'], 60, true, '障害', '自宅の重大障害（中央配信・EEW・地震・津波・気象の受信停止、起動管理に接続できない）', '復旧まで'), critical: true }),
    aws_failover: Object.freeze({ ...item(['red', 'blue'], 60, true, '障害', 'AWS の予備系で配信中（自宅から配信できていない）', '復旧まで'), critical: true }),
    link_lost: Object.freeze({ ...item(['blue'], null, true, '障害', '監視情報の途絶（自宅のブリッジから3分届かない・この画面がサイトから読めない）', '復旧まで'), critical: true }),
    home_restart_loop: item(['yellow'], 60, false, '障害', '自宅のプログラムが起動に失敗し続けている（再起動待ち）', '復旧まで'),
    home_degraded: item(['yellow'], 0, false, '障害', '自宅のその他のプログラム停止', '復旧まで'),
    home_resource: item(['yellow'], 0, false, '障害', '自宅サーバーの空き容量・メモリ不足、CPU 高負荷の継続', '解消まで'),
    aws_alarm: item(['yellow', 'blue'], 30, false, '障害', 'AWS のアラーム（請求アラームを除く）', 'アラーム解消まで'),
    aws_degraded: item(['yellow', 'blue'], 0, false, '障害', 'AWS 予備系の準備中・AWS の状態を読めない', '復旧まで'),
    recovered: item(['green'], 0, false, '障害', '障害から復旧した', '復旧の緑の時間'),
    eew_warning: Object.freeze({ ...item(['white'], null, false, '防災', '緊急地震速報（警報）', '最後の報から3分（取消ですぐ消灯）'), critical: true }),
    tsunami_major: Object.freeze({ ...item(['white'], null, false, '防災', '大津波警報', '最長表示まで（警報が上がったらまた表示）'), critical: true }),
    tsunami_warning: Object.freeze({ ...item(['white'], null, false, '防災', '津波警報', '最長表示まで（警報が上がったらまた表示）'), critical: true }),
    tsunami_advisory: item(['white'], 0, false, '防災', '津波注意報', '最長表示まで'),
    quake_6plus: Object.freeze({ ...item(['white'], null, false, '防災', '震度6弱以上を観測', '最長表示まで'), critical: true }),
    quake_5: item(['white'], 0, false, '防災', '震度5弱・5強を観測', '最長表示まで'),
    special_warning: Object.freeze({ ...item(['white'], 60, false, '防災', '気象の特別警報', '最長表示まで（別の地域で出たらまた表示）'), critical: true }),
    nankai_investigating: Object.freeze({ ...item(['white'], null, false, '防災', '南海トラフ地震臨時情報（調査中）', '最長表示まで'), critical: true }),
    long_term_caution: item(['white'], 0, false, '防災', '南海トラフ（巨大地震警戒・注意）／北海道・三陸沖後発地震注意情報', '最長表示まで'),
});
export const SYSTEM_KINDS = Object.freeze(new Set(Object.entries(LEGEND).filter(([kind, value]) => value.group === '障害' && kind !== 'recovered').map(([kind]) => kind)));

// Arduino の EEPROM 設定（CFG_GET）が読めるまでの既定値
export const DEFAULT_TIMING = Object.freeze({ maxDisplay: 300, reminderInterval: 1800, reminder: 30, recovery: 60 });
export const LINK_TIMEOUT_SECONDS = 180;   // ブリッジは 60 秒ごとに送る
export const ACK_EVENTS = Object.freeze(new Set(['ACK_BUTTON', 'DISPLAY_BUZZER_OFF', 'BUZZER_OFF_BUTTON']));

// 夜間モード: 開始〜終了（日本時間。終了が開始より前なら日をまたぐ）の間は「重大」だけ点ける
export function jstMinutes(nowSeconds) {
    const date = new Date(nowSeconds * 1000 + 9 * 3600 * 1000);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
}

const toMinutes = (text) => { const [h, m] = String(text).split(':').map(Number); return h * 60 + m; };

export function isNight(settings, nowSeconds) {
    const night = settings?.night;
    if (!night?.enabled) return false;
    const start = toMinutes(night.start);
    const end = toMinutes(night.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const minute = jstMinutes(nowSeconds);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// 表示の方針: snoozed = 一時停止中（全部消す）、night = 夜間モード中（重大だけ）
export function policyFor(settings, nowSeconds) {
    const snoozeUntil = Number(settings?.snoozeUntil);
    return { snoozed: Number.isFinite(snoozeUntil) && snoozeUntil > nowSeconds, night: isNight(settings, nowSeconds) };
}

// 毎日のランダムな試験点灯の時刻（日本時間 10:00〜19:59 のどこか。日付から決めるので、どの PC でも同じ時刻）
export function dailyIlluminationMinute(nowSeconds) {
    const day = new Date(nowSeconds * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let hash = 2166136261;
    for (const ch of day) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    return 600 + (hash % 600);
}


export function itemVisible(age, legend, timing) {
    const value = Math.max(0, age);
    if (value < timing.maxDisplay) {
        const flashing = legend.flashSeconds === null || (legend.flashSeconds > 0 && value < legend.flashSeconds);
        return { visible: true, flashing };
    }
    if (legend.remind) {
        const interval = Math.max(60, timing.reminderInterval);
        const phase = (value - timing.maxDisplay) % interval;
        if (phase >= interval - timing.reminder) return { visible: true, flashing: legend.flashSeconds !== 0 };
    }
    return { visible: false, flashing: false };
}

export function desiredPattern(conditions, acked, now, timing = DEFAULT_TIMING, policy = { snoozed: false, night: false }) {
    const lamps = Object.fromEntries(COLORS.map((color) => [color, 'off']));
    const shown = [];
    for (const condition of conditions) {
        const legend = LEGEND[condition?.kind];
        if (!legend) continue;
        const since = Number.isFinite(condition.since) ? condition.since : now;
        let { visible, flashing } = itemVisible(now - since, legend, timing);
        const isAcked = acked.has(String(condition.id));
        let suppressed = '';
        if (policy.snoozed) suppressed = '一時停止中';
        else if (policy.night && !legend.critical) suppressed = '夜間モード（重大以外は消灯）';
        if (isAcked || suppressed) { visible = false; flashing = false; }
        if (visible) {
            for (const color of legend.colors) {
                if (flashing) lamps[color] = 'flash';
                else if (lamps[color] === 'off') lamps[color] = 'on';
            }
        }
        shown.push({ id: String(condition.id), kind: condition.kind, title: condition.title || legend.label, colors: legend.colors, lit: visible, flashing, acked: isAcked, suppressed, critical: legend.critical, since });
    }
    return { lamps, shown };
}

export function setCommand(lamps) {
    const mode = { off: 'OFF', on: 'ON', flash: 'FLASH' };
    return `SET ${COLORS.map((color) => `${SERIAL_KEYS[color]}=${mode[lamps[color]] || 'OFF'}`).join(' ')} BZ=0`;
}

// "OK STATUS FS=0 R=OFF Y=ON ... EV=READY EC=3 UP=12" → { fullStop, lamps, event, eventCounter, link }
export function parseStatus(line) {
    if (!line.startsWith('OK STATUS ')) return null;
    const fields = Object.fromEntries(line.slice(10).split(' ').map((part) => part.split('=')).filter((pair) => pair.length === 2));
    const mode = { OFF: 'off', ON: 'on', FLASH: 'flash' };
    const lamps = Object.fromEntries(COLORS.map((color) => [color, mode[fields[SERIAL_KEYS[color]]] || 'off']));
    return { fullStop: fields.FS === '1', lamps, event: fields.EV || '', eventCounter: Number(fields.EC), link: fields.LINK || '', uptime: Number(fields.UP) };
}

// "OK CFG MAXD=300 RINT=1800 RLEN=30 RECV=60 PERIOD=500 HTO=60"
export function parseConfig(line) {
    if (!line.startsWith('OK CFG ')) return null;
    const fields = Object.fromEntries(line.slice(7).split(' ').map((part) => part.split('=')).filter((pair) => pair.length === 2).map(([key, value]) => [key, Number(value)]));
    if (![fields.MAXD, fields.RINT, fields.RLEN, fields.RECV].every(Number.isFinite)) return null;
    return { maxDisplay: fields.MAXD, reminderInterval: fields.RINT, reminder: fields.RLEN, recovery: fields.RECV, period: fields.PERIOD, hostTimeout: fields.HTO };
}

export function sameLamps(left, right) {
    return Boolean(left && right) && COLORS.every((color) => left[color] === right[color]);
}

// サイトから読んだ一覧・復旧の緑・確認済み・途絶を持つ（時刻はすべてこの PC の UNIX 秒）
export class PatliteEngine {
    constructor(now) {
        this.conditions = [];
        this.recovered = new Map();
        this.acked = new Set();
        this.prevSystem = new Map();
        this.lastFresh = null;       // ブリッジの最終送信（この PC の時刻に直したもの）
        this.startedAt = now;
        this.timing = { ...DEFAULT_TIMING };
        this.settings = null;   // サイトに保存した一時停止・夜間モードの設定
    }

    // receivedAt: サイトが受け取った時刻（この PC の時刻に直したもの）、offset: この PC の時刻 - サイトの時刻
    update(conditions, receivedAt, offset, now) {
        const wasLost = this.linkLost(now);
        const clean = conditions.filter((c) => c && LEGEND[c.kind]).map((c) => ({ ...c, since: Number.isFinite(c.since) ? c.since + offset : now }));
        if (receivedAt !== null && now - receivedAt <= LINK_TIMEOUT_SECONDS) {
            if (wasLost && this.lastFresh !== null) this.addRecovered('link_lost', LEGEND.link_lost.label, now);
            this.lastFresh = receivedAt;
        }
        this.conditions = clean;
        const system = new Map(clean.filter((c) => SYSTEM_KINDS.has(c.kind)).map((c) => [String(c.id), c]));
        for (const [id, previous] of this.prevSystem) {
            if (!system.has(id)) this.addRecovered(id, previous.title || LEGEND[previous.kind].label, now);
        }
        this.prevSystem = system;
        const current = new Set(this.items(now).map((c) => String(c.id)));
        for (const id of [...this.acked]) if (!current.has(id)) this.acked.delete(id);
    }

    addRecovered(id, title, now) {
        if (this.timing.recovery <= 0) return;
        this.recovered.set(`recovered:${id}`, { id: `recovered:${id}`, kind: 'recovered', title: `復旧: ${title}`, since: now, until: now + this.timing.recovery });
    }

    linkLost(now) {
        const reference = this.lastFresh ?? this.startedAt;
        return now - reference > LINK_TIMEOUT_SECONDS;
    }

    items(now) {
        for (const [id, value] of this.recovered) if (value.until <= now) this.recovered.delete(id);
        const list = [...this.conditions, ...this.recovered.values()];
        if (this.linkLost(now)) {
            const reference = this.lastFresh ?? this.startedAt;
            list.push({ id: 'link_lost', kind: 'link_lost', title: LEGEND.link_lost.label, since: reference + LINK_TIMEOUT_SECONDS });
        }
        return list;
    }

    pattern(now) {
        return desiredPattern(this.items(now), this.acked, now, this.timing, policyFor(this.settings, now));
    }

    acknowledge(now) {
        for (const shown of this.pattern(now).shown) if (shown.lit) this.acked.add(shown.id);
    }
}
