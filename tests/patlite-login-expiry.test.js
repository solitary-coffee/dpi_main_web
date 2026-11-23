// Cloudflare Access のログインが切れた後も、積層灯ページ・操作盤が表示を続けられること
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------------- 保存したページ本体（Service Worker） ----------------
async function startWorker(file, respond) {
    const core = await read('site/patlite-admin/shell-worker.js');
    const store = new Map();
    const handlers = {};
    const calls = [];
    const self = { location: { origin: 'https://dpi-bot.com' }, addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const context = vm.createContext({
        self, URL, Set, Error,
        importScripts: (path) => { assert.equal(path, '/site/patlite-admin/shell-worker.js'); vm.runInContext(core, context); },
        caches: { open: async () => ({ put: async (key, value) => { store.set(key, value); }, match: async (key) => store.get(key) }) },
        fetch: async (path, init) => { calls.push({ path, init }); return respond(path); },
    });
    vm.runInContext(await read(file), context);
    const wait = async (name) => { let promise; handlers[name]({ waitUntil: (value) => { promise = value; } }); await promise; };
    const request = async (url, init = {}) => {
        let result = null;
        handlers.fetch({ request: { url: `https://dpi-bot.com${url}`, method: 'GET', mode: 'no-cors', ...init }, respondWith: (value) => { result = value; } });
        return result;
    };
    return { store, calls, wait, request };
}

const page = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, type: 'basic', text, clone() { return page(text, status); } });
const redirected = () => ({ ok: false, status: 0, type: 'opaqueredirect' });

for (const [file, root] of [['site/patlite-admin/sw.js', '/site/patlite-admin/'], ['site/control-deck/sw.js', '/site/control-deck/']]) {
    test(`${file}: ふだんはサイトから読み、ログイン画面へ転送・401/403/5xx・通信不可のときだけ保存した分で開く`, async () => {
        let answer = (path) => page(`v1 ${path}`);
        const worker = await startWorker(file, (path) => answer(path));
        await worker.wait('install');
        assert.ok(worker.store.has(root));
        assert.ok(worker.store.has('/site/patlite-admin/lamp-key.js'));
        assert.ok(worker.calls.every(({ init }) => init.redirect === 'manual' && init.credentials === 'same-origin'));

        answer = () => page('v2');
        assert.equal((await worker.request(root, { mode: 'navigate' })).text, 'v2', '更新はすぐ反映される');
        for (const broken of [redirected, () => page('x', 401), () => page('x', 403), () => page('x', 503), () => { throw new TypeError('offline'); }]) {
            answer = broken;
            assert.equal((await worker.request(root, { mode: 'navigate' })).text, 'v2');
        }
        answer = () => page('not found', 404);
        assert.equal((await worker.request(root, { mode: 'navigate' })).status, 404);

        answer = () => page('should not be read');
        assert.equal(await worker.request(`${root}?login=1`, { mode: 'navigate' }), null, 'ログインし直すときは何もしない');
        assert.equal(await worker.request('/site/patlite-admin/api/state'), null, 'API は扱わない');
        assert.equal(await worker.request('/site/patlite-admin/api/settings', { method: 'POST' }), null);
        assert.equal(await worker.request('/site/supporter-admin/'), null, 'ほかの管理ページは扱わない');
    });

    test(`${file}: ログインが切れた状態では、保存を入れ替えない`, async () => {
        const worker = await startWorker(file, () => redirected());
        await assert.rejects(worker.wait('install'), /shell/u);
        assert.equal(worker.store.size, 0);
    });

    test(`${file}: ページが読むファイルをすべて保存する`, async () => {
        const worker = await startWorker(file, (path) => page(path));
        await worker.wait('install');
        const html = await read(`${root.slice(1)}index.html`);
        const sources = [...html.matchAll(/<(?:script[^>]+src|link rel="stylesheet" href)="([^"]+)"/gu)].map((match) => match[1]);
        const modules = [];
        for (const source of sources.filter((value) => value.endsWith('.js') && !value.startsWith('../../'))) {
            const code = await read(`${root.slice(1)}${source}`);
            modules.push(...[...code.matchAll(/(?:from |import\()'([^']+)'/gu)].map((match) => match[1]));
        }
        for (const path of [...sources, ...modules]) {
            assert.ok(worker.store.has(new URL(path, `https://dpi-bot.com${root}`).pathname), path);
        }
    });
}

// ---------------- 鍵 ----------------
test('lampFetch: ログインで読めないときだけ鍵を使い、鍵が無効なら捨てて知らせる', async () => {
    const saved = new Map();
    globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
    const originalFetch = globalThis.fetch;
    const { STATE_API, lamp, lampFetch, renewLampKey, savedLampKey } = await import('../site/patlite-admin/lamp-key.js');
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const calls = [];
    let login = () => reply({ success: true, from: 'login' });
    let key = () => reply({ success: true, from: 'key' });
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        assert.ok(init.signal, '返事が来ないまま待ち続けない');
        if (url.endsWith('/lamp-key')) return reply({ success: true, key: 'v1.key', expiresAt: Date.now() / 1000 + 1000 });
        return url.startsWith('/api/patlite/lamp/') ? key() : login();
    };
    try {
        login = () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(lampFetch(STATE_API), /Failed to fetch/u);
        assert.deepEqual([lamp.viaKey, lamp.loginLost], [false, true], '鍵が無ければログイン切れと知らせる');

        login = () => reply({ success: true, from: 'login' });
        assert.equal((await lampFetch(STATE_API)).data.from, 'login');
        assert.deepEqual([lamp.viaKey, lamp.loginLost], [false, false]);
        await renewLampKey();
        assert.equal(savedLampKey().key, 'v1.key');

        for (const broken of [() => { throw new TypeError('Failed to fetch'); }, () => reply({ success: false }, 403), () => new Response('<html>', { status: 200 })]) {
            login = broken;
            assert.equal((await lampFetch(STATE_API)).data.from, 'key');
            assert.deepEqual([lamp.viaKey, lamp.loginLost], [true, true]);
        }
        assert.equal(calls.at(-1).url, '/api/patlite/lamp/state');
        assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer v1.key');
        assert.equal(calls.at(-1).init.credentials, 'omit');

        key = () => reply({ success: false }, 401);
        await assert.rejects(lampFetch(STATE_API));
        assert.equal(savedLampKey(), null);
        assert.deepEqual([lamp.viaKey, lamp.loginLost], [false, true]);
    } finally {
        globalThis.fetch = originalFetch;
        delete globalThis.localStorage;
    }
});

// ---------------- 画面 ----------------
test('積層灯ページ: 通信が切れたら返事待ちの命令を終わらせ、自動でつなぎ直す', async () => {
    const script = await read('site/patlite-admin/script.js');
    const close = script.slice(script.indexOf('async function closeSerial'), script.indexOf('async function reconnectSerial'));
    assert.match(close, /reject\(new Error\('通信が切れました。'\)\);/u, '返事待ちを残すと、後の命令が永久に待つ');
    assert.match(script, /serial\.pending = \{ resolve, reject, timer \};/u);
    assert.match(script, /if \(!serial\.connected && state\.ticks % RECONNECT_EVERY_TICKS === 0\) reconnectSerial\(\);/u);
    assert.match(script, /serial\.manualClose \|\| openedForLogin\(\)\) return;/u, '「切断」を押した後・ログイン用のタブではつながない');
    assert.match(script, /serial\.manualClose = true; closeSerial\('切断しました。'\)/u);
});

test('積層灯ページ・操作盤: ログインし直すボタンと、実機の報告が途絶えたときの表示', async () => {
    const html = await read('site/patlite-admin/index.html');
    const script = await read('site/patlite-admin/script.js');
    const deckHtml = await read('site/control-deck/index.html');
    const deck = await read('site/control-deck/deck.js');
    assert.match(html, /id="login-notice"[^>]*hidden>/u);
    assert.match(html, /href="\/site\/patlite-admin\/\?login=1" target="_blank" rel="noopener"/u);
    assert.doesNotMatch(script, /ページを再読み込み/u, '再読み込みを案内しない（積層灯の表示が止まるため）');
    assert.match(deckHtml, /id="login-link"[^>]*href="\/site\/control-deck\/\?login=1" hidden/u);
    assert.match(script, /registerShell\('sw\.js'\)/u);
    assert.match(deck, /registerShell\('sw\.js'\)/u);
    assert.match(deck, /await lampFetch\(STATE_API,/u);
    assert.match(deck, /if \(!lamp\.viaKey\) renewLampKey\(\);/u);
    assert.match(deck, /DEVICE_LATE_SECONDS = 11 \* 60/u);
});
