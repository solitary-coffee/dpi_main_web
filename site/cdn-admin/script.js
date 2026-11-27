// 画像CDN 管理画面: /site/cdn-admin/api/stats（Access 認証済み管理者のみ）から Bot の集計
// （非公開 R2 バケット dpi-image-cdn-meta の admin-stats.json）と Worker の使用量（usage.json）を読み、60 秒ごとに再表示する。
(() => {
    const API = '/site/cdn-admin/api/stats';
    const REFRESH_MS = 60_000;
    const STALE_MS = 2 * 60 * 60 * 1000;          // the bot publishes hourly
    const MODE_LABELS = {
        'aws:r2': 'AWS経由／画像R2',
        'aws:s3': 'AWS経由／画像S3',
        'aws:mixed': 'AWS経由／画像R2・S3混在',
        'direct:r2': '自宅直送／画像R2',
        'direct:s3': '自宅直送／画像S3',
        'direct:mixed': '自宅直送／画像R2・S3混在',
        'direct:attach': '自宅直送／添付',
    };
    const MODE_ORDER = Object.keys(MODE_LABELS);
    const PROVIDER_LABELS = { r2: 'Cloudflare R2', s3: 'AWS S3', cloudfront: 'AWS CloudFront' };
    const COST_ITEM_LABELS = {
        storage: '保存', classA: 'Class A 操作', classB: 'Class B 操作', put: 'PUT', get: 'GET',
        transfer: '転送量', requests: 'リクエスト',
    };
    const BASIS_LABELS = { analytics: '実測（Cloudflare Analytics）', estimate: '推定', measured: '実測（CloudWatch）' };
    let timer = null;
    let loading = false;

    function start() {
        document.getElementById('refresh-btn').addEventListener('click', () => loadStats());
        document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });
        timer = setInterval(() => { if (!document.hidden) loadStats(); }, REFRESH_MS);
        return loadStats();
    }

    async function loadStats() {
        if (loading) return;
        loading = true;
        const button = document.getElementById('refresh-btn');
        button.disabled = true;
        try {
            const response = await fetch(API, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
            document.getElementById('admin-email').textContent = data.admin || '';
            render(data);
            if (data.stats) setStatus('', '');
            else setStatus(data.statsError || 'まだ集計がありません。Botの画像ワーカーが1時間ごとに集計を保存します（手動: py -3.11 Di\\supporter_image_cdn_stats.py --once）。', data.statsError ? 'error' : 'info');
        } catch (error) {
            setStatus(error.message || '取得に失敗しました。', 'error');
        } finally {
            button.disabled = false;
            loading = false;
        }
    }

    function render(data) {
        const stats = data.stats || {};
        const usage = data.usage || {};
        const r2 = stats.r2?.available ? stats.r2 : (data.usage ? { available: true, ...usage, fromUsageFile: true } : stats.r2 || {});
        const limits = stats.limits || {};
        const quota = Number(r2.quotaBytes || limits.r2QuotaBytes || 50_000_000_000);
        const cap = Number(r2.monthlyUploadCap || limits.r2MonthlyUploadCap || 1_300_000);
        renderUpdated(stats, data);
        renderOverview(stats, r2, quota, cap);
        renderR2(stats, r2, usage, quota, cap);
        renderAws(stats, limits);
        renderInventory(selectInventory(stats.inventory, usage.inventory));
        renderHealth(stats.health);
        renderModes(stats.sendModes);
        renderCost(stats.cost);
    }

    function renderUpdated(stats, data) {
        const generated = stats.generatedAt || data.statsSavedAt;
        document.getElementById('updated-at').textContent = `集計: ${formatDate(generated)} ／ 表示: ${formatDate(data.fetchedAt)}`;
        const notice = document.getElementById('stale-notice');
        const age = Date.parse(data.fetchedAt || '') - Date.parse(generated || '');
        const stale = Boolean(generated) && Number.isFinite(age) && age > STALE_MS;
        notice.hidden = !stale;
        notice.textContent = stale ? `集計が${Math.floor(age / 3_600_000)}時間以上更新されていません。画像ワーカーが停止していないか確認してください。` : '';
    }

    function renderOverview(stats, r2, quota, cap) {
        const cost = stats.cost || {};
        const providers = stats.health?.providers || [];
        const health = providers.filter((p) => p.configured)
            .map((p) => `${p.name.toUpperCase()} ${p.up ? 'UP' : 'DOWN'}`).join(' / ') || '未設定';
        const anyDown = providers.some((p) => p.configured && !p.up);
        const cards = [
            ['推定費用（月末見込み）', Number.isFinite(cost.totalJpy) ? `${number(cost.totalJpy)}円` : '—',
                Number.isFinite(cost.budgetJpy) ? `予算 ${number(cost.budgetJpy)}円${cost.withinBudget === false ? '（超過見込み）' : ''}` : '', cost.withinBudget === false ? 'bad' : 'good'],
            ['R2 保存量', r2.available ? formatBytes(r2.bytes) : '取得不可', r2.available ? `上限 ${formatBytes(quota)} の ${percent(r2.bytes, quota)}` : (r2.error || ''), level(r2.bytes, quota)],
            ['R2 今月のアップロード', r2.available ? `${number(r2.uploadsThisMonth)}件` : '取得不可', r2.available ? `上限 ${number(cap)}件 の ${percent(r2.uploadsThisMonth, cap)}` : '', level(r2.uploadsThisMonth, cap)],
            ['稼働状態', health, anyDown ? 'DOWN の保存先があります' : '', anyDown ? 'bad' : 'good'],
        ];
        document.getElementById('overview-cards').replaceChildren(...cards.map(([label, value, detail, state]) => {
            const card = el('article', `metric-card cdn-metric cdn-${state || 'none'}`);
            card.append(el('span', '', label), el('strong', '', value), el('small', 'muted', detail));
            return card;
        }));
    }

    function renderR2(stats, r2, usage, quota, cap) {
        const analytics = stats.r2Analytics || {};
        const cards = [];
        if (!r2.available) {
            cards.push(infoCard('R2', r2.configured === false ? '未設定' : '取得不可', r2.error || 'Botに R2 の設定がありません。'));
        } else {
            cards.push(barCard('保存量', `${formatBytes(r2.bytes)} / ${formatBytes(quota)}`, r2.bytes, quota));
            cards.push(infoCard('保存件数', `${number(r2.objects)}件`, '30日で自動削除'));
            cards.push(barCard('今月のアップロード', `${number(r2.uploadsThisMonth)} / ${number(cap)}件`, r2.uploadsThisMonth, cap));
        }
        if (!analytics.configured) {
            cards.push(infoCard('読み取り（Class B）', '未設定', 'CLOUDFLARE_ANALYTICS_TOKEN を設定すると実測値を表示します'));
        } else if (!analytics.available) {
            cards.push(infoCard('読み取り（Class B）', '取得不可', analytics.error || ''));
        } else {
            cards.push(barCard('読み取り（Class B、今月）', `${number(analytics.classB)}回`, analytics.classB, 10_000_000, `無料枠 1,000万回／うち画像取得 ${number(analytics.getObject)}回`));
            cards.push(barCard('書き込み等（Class A、今月）', `${number(analytics.classA)}回`, analytics.classA, 1_000_000, '無料枠 100万回'));
        }
        document.getElementById('r2-cards').replaceChildren(...cards);
        const computed = usage.computedAt || r2.computedAt;
        document.getElementById('r2-note').textContent = `${r2.fromUsageFile ? 'Workerの使用量記録から表示。' : ''}使用量の再計算（6時間ごと）: ${formatDate(computed)}。月はUTC基準。`;
    }

    function renderAws(stats, limits) {
        const aws = stats.aws || {};
        const cards = [];
        if (!stats.aws) {
            cards.push(infoCard('AWS', '集計なし', ''));
        } else if (aws.configured === false) {
            cards.push(infoCard('AWS', '未設定', 'Botに S3 の設定がありません。'));
        } else {
            const s3 = aws.s3 || {};
            const cloudfront = aws.cloudfront || {};
            if (s3.available) {
                cards.push(infoCard('S3 保存量', formatBytes(s3.bytes), s3.note || `CloudWatch 日次値 ${formatDate(s3.measuredAt)}`));
                cards.push(infoCard('S3 保存件数', `${number(s3.objects)}件`, '稼働確認用の小さなファイルを含む'));
            } else {
                cards.push(infoCard('S3', '取得不可', s3.error || ''));
            }
            if (cloudfront.available) {
                const freeBytes = Number(limits.cloudfrontFreeBytes || 1e12);
                const freeRequests = Number(limits.cloudfrontFreeRequests || 10_000_000);
                cards.push(barCard('CloudFront 転送量（今月）', `${formatBytes(cloudfront.bytesDownloaded)} / ${formatBytes(freeBytes)}`, cloudfront.bytesDownloaded, freeBytes, '常時無料枠 1 TB/月'));
                cards.push(barCard('CloudFront リクエスト（今月）', `${number(cloudfront.requests)}回`, cloudfront.requests, freeRequests, '常時無料枠 1,000万回/月'));
            } else {
                cards.push(infoCard('CloudFront', '取得不可', cloudfront.error || ''));
            }
        }
        document.getElementById('aws-cards').replaceChildren(...cards);
        document.getElementById('aws-note').textContent = 'S3はCloudWatchの1日1回の値、CloudFrontは今月（UTC）の合計です。';
    }

    function selectInventory(statsInventory, usageInventory) {
        const statsView = inventoryViewModel(statsInventory);
        return statsView.available ? statsView : inventoryViewModel(usageInventory);
    }

    // API の不完全な値を、DOM に依存しない安全な表示用データへ変換する。
    function inventoryViewModel(inventory) {
        const unavailable = Object.freeze({
            available: false,
            message: 'まだ集計されていません（自宅の集計は 1 時間ごと）',
            generatedAt: '',
            locations: [],
        });
        if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || !Array.isArray(inventory.locations)) return unavailable;

        const locations = inventory.locations
            .filter((location) => location && typeof location === 'object' && !Array.isArray(location))
            .map((location) => {
                const categories = Array.isArray(location.categories) ? location.categories : [];
                return {
                    id: safeText(location.id),
                    label: safeText(location.label) || safeText(location.id) || '保存先',
                    available: location.available === true,
                    error: safeText(location.error),
                    objects: safeInteger(location.objects),
                    bytes: safeInteger(location.bytes),
                    categories: categories
                        .filter((category) => category && typeof category === 'object' && !Array.isArray(category))
                        .map((category) => ({
                            id: safeText(category.id),
                            label: safeText(category.label) || safeText(category.id) || '種類不明',
                            objects: safeInteger(category.objects),
                            bytes: safeInteger(category.bytes),
                            latest: formatInventoryDate(category.latest),
                        }))
                        .sort((left, right) => right.bytes - left.bytes),
                };
            });
        return {
            available: true,
            message: '',
            generatedAt: formatInventoryDate(inventory.generatedAt),
            locations,
        };
    }

    function renderInventory(view) {
        const generatedAt = document.getElementById('inventory-generated-at');
        const target = document.getElementById('inventory-locations');
        generatedAt.textContent = view.available ? `集計時刻: ${view.generatedAt}` : '';
        if (!view.available) {
            target.replaceChildren(el('p', 'cdn-notice', view.message));
            return;
        }
        if (!view.locations.length) {
            target.replaceChildren(el('p', 'muted', '保存先の記録がありません。'));
            return;
        }
        target.replaceChildren(...view.locations.map((location) => {
            const section = el('article', 'cdn-inventory-location');
            const heading = el('div', 'cdn-inventory-heading');
            const total = `合計 ${number(location.objects)}枚 ／ ${formatInventoryBytes(location.bytes)}`;
            const summary = location.available ? total : `${total} ／ 取得不可${location.error ? `: ${location.error}` : ''}`;
            heading.append(el('h3', '', location.label), el('p', location.available ? 'muted' : 'cdn-inventory-error', summary));
            section.append(heading);

            const wrap = el('div', 'table-wrap');
            const table = el('table');
            const thead = el('thead');
            const header = el('tr');
            ['種類', '枚数', '大きさ', '最新の日時'].forEach((label) => header.append(el('th', '', label)));
            thead.append(header);
            const tbody = el('tbody');
            const rows = location.categories.map((category) => {
                const row = el('tr');
                row.append(el('td', '', category.label), el('td', '', `${number(category.objects)}枚`),
                    el('td', '', formatInventoryBytes(category.bytes)), el('td', '', category.latest));
                return row;
            });
            tbody.replaceChildren(...(rows.length ? rows : [emptyRow(4, location.available ? '種類別の記録がありません。' : '取得できなかったため内訳はありません。')]));
            table.append(thead, tbody);
            wrap.append(table);
            section.append(wrap);
            return section;
        }));
    }

    function renderHealth(health) {
        const rows = (health?.providers || []).map((p) => {
            const row = el('tr');
            const state = !p.configured ? ['未設定', 'status-stopped'] : p.up ? ['UP', 'status-operational'] : ['DOWN', 'status-major_outage'];
            const badge = el('span', `component-status ${state[1]}`, state[0]);
            const stateCell = el('td');
            stateCell.append(badge);
            row.append(el('td', '', PROVIDER_LABELS[p.name] || p.name), stateCell, el('td', '', p.reason || '—'),
                el('td', '', formatDate(p.checkedAt)), el('td', '', `${number(p.downEvents24h)}回`),
                el('td', '', p.lastDownAt ? `${formatDate(p.lastDownAt)}${p.lastDownReason ? `（${p.lastDownReason}）` : ''}` : 'なし'));
            return row;
        });
        document.getElementById('health-rows').replaceChildren(...(rows.length ? rows : [emptyRow(6, '稼働状態の記録がありません。')]));
        const source = health?.source === 'worker' ? '画像ワーカーの常時監視（30秒ごと）の結果です。'
            : health?.source === 'probe' ? '手動集計時の単発確認の結果です（DOWN履歴は含みません）。' : '';
        document.getElementById('health-note').textContent = `${source}${health && health.enabled === false ? ' URL方式は停止中です（常に添付方式）。' : ''}`;
    }

    function renderModes(modes) {
        const day = modes?.last24h || {};
        const month = modes?.month || {};
        const keys = [...new Set([...MODE_ORDER, ...Object.keys(day), ...Object.keys(month)])]
            .filter((key) => Number(day[key] || 0) + Number(month[key] || 0) > 0);
        const rows = keys.map((key) => {
            const row = el('tr');
            row.append(el('td', '', MODE_LABELS[key] || key), el('td', '', `${number(day[key])}件`), el('td', '', `${number(month[key])}件`));
            return row;
        });
        document.getElementById('mode-rows').replaceChildren(...(rows.length ? rows : [emptyRow(3, '送信方式の記録がありません。')]));
        const upload = modes?.uploadMs24h || {};
        const parts = [];
        if (modes) parts.push(`ジョブ数: 過去24時間 ${number(modes.jobs24h)}件 ／ 今月 ${number(modes.jobsMonth)}件`);
        if (upload.count) parts.push(`アップロード時間（24時間）: 平均 ${number(upload.avg)}ms ／ p95 ${number(upload.p95)}ms`);
        if (modes && modes.monthComplete === false && modes.recordsSince) parts.push(`今月分は記録が残っている ${formatDate(modes.recordsSince)} 以降のみ`);
        document.getElementById('modes-note').textContent = parts.join('。');
    }

    function renderCost(cost) {
        const rows = [];
        const providers = cost?.providers || {};
        for (const key of ['r2', 's3', 'cloudfront']) {
            const item = providers[key];
            if (!item) continue;
            const detail = Object.entries(item.items || {})
                .map(([name, usd]) => `${COST_ITEM_LABELS[name] || name} $${money(usd)}`).join('、');
            const row = el('tr');
            row.append(el('td', '', PROVIDER_LABELS[key] || key), el('td', '', detail), el('td', '', BASIS_LABELS[item.basis] || item.basis || ''),
                el('td', '', `$${money(item.usd)}`), el('td', '', `${number(item.jpy)}円`));
            rows.push(row);
        }
        if (rows.length) {
            const total = el('tr', 'cdn-total-row');
            total.append(el('td', '', '合計'), el('td', '', ''), el('td', '', ''), el('td', '', `$${money(cost.totalUsd)}`), el('td', '', `${number(cost.totalJpy)}円`));
            rows.push(total);
        }
        document.getElementById('cost-rows').replaceChildren(...(rows.length ? rows : [emptyRow(5, '費用を計算できるデータがありません。')]));
        const budgetBox = document.getElementById('budget-bar');
        budgetBox.replaceChildren();
        if (cost && Number.isFinite(cost.totalJpy) && Number.isFinite(cost.budgetJpy)) {
            budgetBox.append(barCard('予算に対する月末見込み', `${number(cost.totalJpy)}円 / ${number(cost.budgetJpy)}円`, cost.totalJpy, cost.budgetJpy));
        }
        document.getElementById('cost-note').textContent = cost?.providers
            ? `今月（UTC）の${Math.round(Number(cost.monthFraction || 0) * 100)}%経過時点の値から月末を見込んでいます。為替 1ドル=${number(cost.jpyPerUsd)}円。無料枠を差し引いた追加費用の目安で、請求額とは異なる場合があります。R2の操作数が未設定の場合、Class Aは推定（アップロード数・稼働確認・一覧）、Class Bは含みません。`
            : '';
    }

    function barCard(label, value, used, limit, detail = '') {
        const card = el('article', 'cdn-card');
        const ratio = Number(limit) > 0 ? Number(used || 0) / Number(limit) : 0;
        const bar = el('div', 'cdn-bar');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', label);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(Math.min(100, Math.round(ratio * 100))));
        const fill = el('span', `cdn-bar-fill cdn-${level(used, limit)}`);
        fill.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
        bar.append(fill);
        card.append(el('span', 'cdn-card-label', label), el('strong', '', value), bar,
            el('small', 'muted', [`${percent(used, limit)}`, detail].filter(Boolean).join('　')));
        return card;
    }

    function infoCard(label, value, detail = '') {
        const card = el('article', 'cdn-card');
        card.append(el('span', 'cdn-card-label', label), el('strong', '', value), el('small', 'muted', detail));
        return card;
    }

    function emptyRow(columns, text) {
        const row = el('tr');
        const cell = el('td', 'empty', text);
        cell.setAttribute('colspan', String(columns));
        row.append(cell);
        return row;
    }

    function level(used, limit) {
        const ratio = Number(limit) > 0 ? Number(used || 0) / Number(limit) : 0;
        return ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'good';
    }
    function percent(used, limit) {
        if (!(Number(limit) > 0)) return '';
        const value = (Number(used || 0) / Number(limit)) * 100;
        return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
    }
    function formatBytes(value) {
        const bytes = Number(value || 0);
        if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
        if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
        if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
        if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
        return `${bytes} B`;
    }
    function formatInventoryBytes(value) {
        const bytes = safeInteger(value);
        if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
        if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
        if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
        return `${bytes} B`;
    }
    function safeInteger(value) {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : 0;
    }
    function safeText(value) { return typeof value === 'string' ? value : ''; }
    function formatInventoryDate(value) {
        const date = new Date(typeof value === 'string' ? value : '');
        return Number.isFinite(date.getTime())
            ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(date)
            : '未記録';
    }
    function money(value) { return Number(value || 0).toFixed(2); }
    function number(value) { return new Intl.NumberFormat('ja-JP').format(Number(value || 0)); }
    function formatDate(value) {
        const date = new Date(value || '');
        return value && Number.isFinite(date.getTime())
            ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(date)
            : '未記録';
    }
    function setStatus(message, type) {
        const target = document.getElementById('global-status');
        target.textContent = message;
        target.className = type ? `status ${type}` : 'status';
    }
    function el(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== '') node.textContent = text;
        return node;
    }

    let ready = null;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { ready = start(); });
    else ready = start();
    globalThis.CdnAdmin = Object.freeze({
        loadStats, render, inventoryViewModel, selectInventory,
        stop: () => clearInterval(timer), MODE_LABELS, get ready() { return ready; },
    });
})();
