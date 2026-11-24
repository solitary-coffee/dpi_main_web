// 積層灯（PATLITE）管理ページの判定ロジック（画面・シリアルに依存しない部分。tests/patlite-admin.test.js で試験）。
// 操作盤（site/control-deck/deck.js）とサイトの API（worker/patlite-admin.js の履歴の「無連動」の理由）からも使う。
// Arduino積層灯制御システム server/dpi_status.py と同じ決まり:
//   赤 = 配信が止まる重大障害 / 黄 = 一部の障害・注意 / 青 = AWS 側・監視の途絶 / 白 = 防災情報 / 緑 = 復旧。
//   防災情報の「重大」は 白＋赤・白＋黄 の 2 色の組み合わせにして、障害（白を使わない）と見分けられるようにする。
//   段階（level）: 重大 / 中 / 軽。時間帯設定・一時的な絞り込みで「重大のみ」「中以上」だけ点けられる。
//   正常なときは消灯。
//   - 障害（group = 障害）: 「最長 maxDisplay 秒点ける → reminderInterval 秒消す → まだ続いていればまた点ける」を繰り返す。
//   - 防災情報（group = 防災）: 最長 5 分か確認まで点けたら、その項目は二度と点けない（繰り返さない）。
//     種類が変わった（津波注意報→津波警報、震度5強→6弱 など）ときはブリッジが別の id で送るので、新しい項目としてまた点ける。
//   点滅は色ごと（Arduino がリレーの ON/OFF で点滅させる）。

export const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue', 'white']);
export const COLOR_NAMES = Object.freeze({ red: '赤', yellow: '黄', green: '緑', blue: '青', white: '白' });
const SERIAL_KEYS = Object.freeze({ red: 'R', yellow: 'Y', green: 'G', blue: 'B', white: 'W' });

// 段階: 数字が大きいほど重い
export const LEVELS = Object.freeze(['重大', '中', '軽']);
export const LEVEL_RANK = Object.freeze({ 重大: 3, 中: 2, 軽: 1 });
// 時間帯設定・一時的な絞り込みで選べる「点けるもの」
export const FILTER_LEVELS = Object.freeze({
    critical: Object.freeze({ label: '重大のみ', min: 3 }),
    medium: Object.freeze({ label: '中以上', min: 2 }),
});
export const DISASTER_MAX_SECONDS = 300;   // 防災情報を点ける最長時間（この後は繰り返さない）
export const ACK_DELAY_SECONDS = 3;        // 確認を押してから消灯するまで（Arduino のボタンも 3 秒）
export const MAX_RECOVERY_SECONDS = 5;     // 復旧の緑の最長（Arduino に古い値 RECV=60 が残っていてもこれより長くしない）

// colors は「白＋赤」のように見せたい順（防災は白を先に）。flashSeconds: null = 表示中ずっと点滅、0 = 点灯のみ、n = 最初の n 秒点滅→点灯
const item = (colors, flashSeconds, level, group, label, until) => Object.freeze({
    colors: Object.freeze(colors), flashSeconds, level, critical: level === '重大', repeat: group === '障害', group, label, until,
});
const SYSTEM_UNTIL = '最長5分→30分消灯→続けばまた点灯';
const DISASTER_UNTIL = '最長5分か確認まで（繰り返さない）';
export const LEGEND = Object.freeze({
    home_critical: item(['red'], 60, '重大', '障害', '自宅の重大障害（中央配信・EEW・地震・津波・気象の受信停止、起動管理に接続できない）', SYSTEM_UNTIL),
    aws_failover: item(['red', 'blue'], 60, '重大', '障害', 'AWS の予備系で配信中（自宅から配信できていない）', SYSTEM_UNTIL),
    link_lost: item(['blue'], null, '重大', '障害', '監視情報の途絶（自宅のブリッジから3分届かない・この画面がサイトから読めない）', SYSTEM_UNTIL),
    home_restart_loop: item(['yellow'], 60, '中', '障害', '自宅のプログラムが起動に失敗し続けている（再起動待ち）', SYSTEM_UNTIL),
    aws_alarm: item(['yellow', 'blue'], 30, '中', '障害', 'AWS のアラーム（請求アラームを除く）', SYSTEM_UNTIL),
    home_degraded: item(['yellow'], 0, '軽', '障害', '自宅のその他のプログラム停止', SYSTEM_UNTIL),
    home_resource: item(['yellow'], 0, '軽', '障害', '自宅サーバーの空き容量・メモリ不足、CPU 高負荷の継続', SYSTEM_UNTIL),
    aws_degraded: item(['yellow', 'blue'], 0, '軽', '障害', 'AWS 予備系の準備中・AWS の状態を読めない', SYSTEM_UNTIL),
    maintenance: item([], 0, '軽', 'お知らせ', 'メンテナンス中（障害の項目と、監視情報の途絶を出さない。防災情報は出す）', '期限か解除まで'),
    recovered: item(['green'], 0, '軽', '障害', '障害から復旧した', '5秒（確認を押すとすぐ消灯）'),
    eew_warning: item(['white', 'red'], null, '重大', '防災', '緊急地震速報（警報）', `${DISASTER_UNTIL}。最後の報から3分・取消ですぐ消灯`),
    tsunami_major: item(['white', 'red'], null, '重大', '防災', '大津波警報', `${DISASTER_UNTIL}。津波警報などから切り替わったらまた表示`),
    tsunami_warning: item(['white', 'yellow'], null, '重大', '防災', '津波警報', `${DISASTER_UNTIL}。注意報・大津波警報から切り替わったらまた表示`),
    special_warning: item(['white', 'yellow'], 0, '重大', '防災', '気象の特別警報', `${DISASTER_UNTIL}。別の地域で出たらまた表示`),
    quake_6plus: item(['white', 'red'], 0, '重大', '防災', '震度6弱以上を観測', `${DISASTER_UNTIL}。震度5から上がったらまた表示`),
    nankai_investigating: item(['white'], null, '重大', '防災', '南海トラフ地震臨時情報（調査中）', DISASTER_UNTIL),
    tsunami_advisory: item(['white'], 0, '中', '防災', '津波注意報', DISASTER_UNTIL),
    quake_5: item(['white'], 0, '中', '防災', '震度5弱・5強を観測', DISASTER_UNTIL),
    long_term_caution: item(['white'], 0, '中', '防災', '南海トラフ（巨大地震警戒・注意）／北海道・三陸沖後発地震注意情報', DISASTER_UNTIL),
});
export const SYSTEM_KINDS = Object.freeze(new Set(Object.entries(LEGEND).filter(([kind, value]) => value.group === '障害' && kind !== 'recovered').map(([kind]) => kind)));

// Arduino の EEPROM 設定（CFG_GET）が読めるまでの既定値
export const DEFAULT_TIMING = Object.freeze({ maxDisplay: 300, reminderInterval: 1800, reminder: 30, recovery: MAX_RECOVERY_SECONDS });
export const MAINTENANCE_MAX_SECONDS = 6 * 3600 + 120;   // これより長いメンテナンスは信用しない
export const LINK_TIMEOUT_SECONDS = 180;   // ブリッジは 60 秒ごとに送る
export const ACK_EVENTS = Object.freeze(new Set(['ACK_BUTTON', 'DISPLAY_BUZZER_OFF', 'BUZZER_OFF_BUTTON']));

// 色の説明（例: 「白＋赤」）と点滅の説明（例: 「ずっと点滅」）
export const colorText = (colors) => colors.map((color) => COLOR_NAMES[color]).join('＋') || '—';
export function flashText(flashSeconds) {
    if (flashSeconds === null) return 'ずっと点滅';
    if (flashSeconds === 0) return '点灯';
    return `最初の${flashSeconds >= 60 ? `${flashSeconds / 60}分` : `${flashSeconds}秒`}点滅→点灯`;
}

// 色の一覧を段階ごとにまとめる（画面の凡例用）。[{ level, items: [{ kind, ...legend }] }]
export function legendByLevel() {
    return LEVELS.map((level) => ({ level, items: Object.entries(LEGEND).filter(([, value]) => value.level === level).map(([kind, value]) => ({ kind, ...value })) }));
}

// 時間帯設定（旧・夜間モード）: 開始〜終了（日本時間。終了が開始より前なら日をまたぐ）の間は選んだ段階だけ点ける
export function jstMinutes(nowSeconds) {
    const date = new Date(nowSeconds * 1000 + 9 * 3600 * 1000);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
}

const toMinutes = (text) => { const [h, m] = String(text).split(':').map(Number); return h * 60 + m; };
const filterCode = (value) => (value === 'medium' ? 'medium' : 'critical');   // 以前の夜間モード（level なし）は「重大のみ」

export function isNight(settings, nowSeconds) {
    const night = settings?.night;
    if (!night?.enabled) return false;
    const start = toMinutes(night.start);
    const end = toMinutes(night.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const minute = jstMinutes(nowSeconds);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// 表示の方針: snoozed = 一時停止中（全部消す）、forever = 無期限停止、night = 時間帯設定の時間内、
// band = 時間帯設定で点ける段階（critical / medium。時間外は null）、temporary = 一時的な絞り込み（期限内だけ）、
// fullStop = Arduino が強制停止中（積層灯ページが知らせた値）
export function policyFor(settings, nowSeconds, device = null) {
    const snoozeUntil = Number(settings?.snoozeUntil);
    const forever = settings?.snoozeForever === true;
    const night = isNight(settings, nowSeconds);
    const filterUntil = Number(settings?.filter?.until);
    const temporary = settings?.filter?.until != null && Number.isFinite(filterUntil) && filterUntil > nowSeconds ? filterCode(settings.filter.level) : null;
    return {
        snoozed: forever || (Number.isFinite(snoozeUntil) && snoozeUntil > nowSeconds),
        forever,
        night,
        band: night ? filterCode(settings.night.level) : null,
        temporary,
        temporaryUntil: temporary ? filterUntil : null,
        fullStop: device?.fullStop === true,
    };
}

// この項目を積層灯に出さない理由（出すなら ''）。履歴にもこの文のまま残す
export function suppressionReason(legend, policy) {
    if (!policy) return '';
    if (policy.forever) return '無期限停止により無連動';
    if (policy.snoozed) return '一時停止により無連動';
    if (policy.fullStop) return '強制停止により無連動';
    const rank = LEVEL_RANK[legend?.level] || 0;
    if (policy.temporary && rank < FILTER_LEVELS[policy.temporary].min) return `一時的な絞り込み（${FILTER_LEVELS[policy.temporary].label}）により無連動`;
    if (policy.band && rank < FILTER_LEVELS[policy.band].min) return `時間帯設定（${FILTER_LEVELS[policy.band].label}）により無連動`;
    return '';
}

const shortTime = (seconds) => new Date(seconds * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 一時停止の説明（画面の表示用）
export function snoozeText(settings, nowSeconds) {
    if (settings?.snoozeForever === true) return '無期限で停止中（解除するまで全部消灯）';
    const until = Number(settings?.snoozeUntil);
    if (settings?.snoozeUntil != null && Number.isFinite(until) && until > nowSeconds) return `一時停止中: ${shortTime(until)} まで`;
    return '';
}

// 絞り込み（一時的な絞り込み・時間帯設定）の説明。どちらも効いていなければ ''
export function filterText(settings, nowSeconds) {
    const policy = policyFor(settings, nowSeconds);
    const parts = [];
    if (policy.temporary) parts.push(`一時的な絞り込み中: ${FILTER_LEVELS[policy.temporary].label}（${shortTime(policy.temporaryUntil)} まで）`);
    if (policy.band) parts.push(`時間帯設定中（${settings.night.start}〜${settings.night.end}）: ${FILTER_LEVELS[policy.band].label}`);
    return parts.join(' / ');
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
    const show = Math.max(1, timing.maxDisplay);
    let phase;
    if (legend.repeat === false) {
        // 防災情報: 最長 5 分（表示の設定がそれより短ければその長さ）点けたら、もう点けない
        if (value >= Math.min(show, DISASTER_MAX_SECONDS)) return { visible: false, flashing: false };
        phase = value;
    } else {
        const cycle = show + Math.max(60, timing.reminderInterval);
        phase = value % cycle;           // 点ける → 消す → （続いていれば）また点ける
        if (phase >= show) return { visible: false, flashing: false };
    }
    const flashing = legend.flashSeconds === null || (legend.flashSeconds > 0 && phase < legend.flashSeconds);
    return { visible: true, flashing };
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
        const suppressed = suppressionReason(legend, policy);
        if (isAcked || suppressed) { visible = false; flashing = false; }
        if (visible) {
            for (const color of legend.colors) {
                if (flashing) lamps[color] = 'flash';
                else if (lamps[color] === 'off') lamps[color] = 'on';
            }
        }
        shown.push({ id: String(condition.id), kind: condition.kind, title: condition.title || legend.label, colors: legend.colors, lit: visible, flashing, acked: isAcked, suppressed, level: legend.level, critical: legend.critical, repeat: legend.repeat, since });
    }
    return { lamps, shown };
}

export function setCommand(lamps) {
    const mode = { off: 'OFF', on: 'ON', flash: 'FLASH' };
    return `SET ${COLORS.map((color) => `${SERIAL_KEYS[color]}=${mode[lamps[color]] || 'OFF'}`).join(' ')} BZ=0`;
}

// "OK STATUS FS=0 R=OFF Y=ON ... ACK=0 ... EV=READY EC=3 UP=12" → { fullStop, lamps, ackPending, event, eventCounter, link }
export function parseStatus(line) {
    if (!line.startsWith('OK STATUS ')) return null;
    const fields = Object.fromEntries(line.slice(10).split(' ').map((part) => part.split('=')).filter((pair) => pair.length === 2));
    const mode = { OFF: 'off', ON: 'on', FLASH: 'flash' };
    const lamps = Object.fromEntries(COLORS.map((color) => [color, mode[fields[SERIAL_KEYS[color]]] || 'off']));
    return { fullStop: fields.FS === '1', lamps, ackPending: fields.ACK === '1', event: fields.EV || '', eventCounter: Number(fields.EC), link: fields.LINK || '', uptime: Number(fields.UP) };
}

// "OK CFG MAXD=300 RINT=1800 RLEN=30 RECV=5 PERIOD=500 HTO=60"
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
        this.settings = null;   // サイトに保存した一時停止・時間帯設定・絞り込みの設定
        this.device = null;     // { fullStop } Arduino の強制停止（積層灯ページが知らせた値）
        this.ackDueAt = null;   // 確認を押した → この時刻に、点いているものを消す
    }

    // receivedAt: サイトが受け取った時刻（この PC の時刻に直したもの）、offset: この PC の時刻 - サイトの時刻
    update(conditions, receivedAt, offset, now) {
        const wasLost = this.linkLost(now);
        const clean = conditions.filter((c) => c && LEGEND[c.kind]).map((c) => ({ ...c, since: Number.isFinite(c.since) ? c.since + offset : now }));
        if (receivedAt !== null && now - receivedAt <= LINK_TIMEOUT_SECONDS) {
            if (wasLost && this.lastFresh !== null) this.addRecovered('link_lost', LEGEND.link_lost.label, now);
            this.lastFresh = receivedAt;
        }
        // until もこの PC の時刻に直す（メンテナンスの期限の判定に使う）
        for (const c of clean) if (c.kind === 'maintenance' && Number.isFinite(c.until)) c.until += offset;
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
        const seconds = Math.min(Number(this.timing.recovery) || 0, MAX_RECOVERY_SECONDS);
        if (seconds <= 0) return;
        this.recovered.set(`recovered:${id}`, { id: `recovered:${id}`, kind: 'recovered', title: `復旧: ${title}`, since: now, until: now + seconds });
    }

    // 復旧の緑は確認を待たない。確認を押したらすぐ消す
    dismissRecovered() {
        this.recovered.clear();
    }

    // 最後に届いた「メンテナンス中」の期限（この PC の時刻）。無ければ null。長すぎる期限は無視する
    maintenanceUntil() {
        const found = this.conditions.find((c) => c.kind === 'maintenance' && Number.isFinite(c.until));
        return found && found.until - found.since <= MAINTENANCE_MAX_SECONDS ? found.until : null;
    }

    // 監視情報の途絶が始まった時刻（メンテナンスの期限までは途絶としない）
    linkLostAt() {
        const reference = (this.lastFresh ?? this.startedAt) + LINK_TIMEOUT_SECONDS;
        return Math.max(reference, this.maintenanceUntil() ?? reference);
    }

    linkLost(now) {
        return now > this.linkLostAt();
    }

    items(now) {
        for (const [id, value] of this.recovered) if (value.until <= now) this.recovered.delete(id);
        // 期限の過ぎた「メンテナンス中」は出さない（自宅が止まっていて消えないことがある）
        const list = [...this.conditions.filter((c) => c.kind !== 'maintenance' || !(c.until <= now)), ...this.recovered.values()];
        if (this.linkLost(now)) list.push({ id: 'link_lost', kind: 'link_lost', title: LEGEND.link_lost.label, since: this.linkLostAt() });
        return list;
    }

    // 確認の予約が時刻に達していたら、いま点いているものを消す（消したら true）
    settleAck(now) {
        if (this.ackDueAt === null || now < this.ackDueAt) return false;
        this.acknowledge(now);
        return true;
    }

    pattern(now) {
        this.settleAck(now);
        return desiredPattern(this.items(now), this.acked, now, this.timing, policyFor(this.settings, now, this.device));
    }

    // ページ・操作盤の「確認」: 復旧の緑はすぐ消し、ほかは ACK_DELAY_SECONDS 後に消す（Arduino のボタンと同じ）
    requestAck(now) {
        this.dismissRecovered();
        if (this.ackDueAt === null) this.ackDueAt = now + ACK_DELAY_SECONDS;
    }

    acknowledge(now) {
        this.ackDueAt = null;
        this.dismissRecovered();
        for (const shown of this.pattern(now).shown) if (shown.lit) this.acked.add(shown.id);
    }
}
