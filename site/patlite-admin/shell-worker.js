// 積層灯ページ・操作盤の Service Worker の共通部分（各フォルダの sw.js から importScripts で読む）。
// Cloudflare Access のログインが切れると、ページの再読み込み・タブの破棄・PC の再起動でログイン画面に置き換わり、
// 積層灯の表示そのものが止まる。ログイン中に読んだページ本体（HTML・JS・CSS）を保存しておき、
// ログイン画面へ転送されたとき・通信できないときだけ、保存した分で開く。
//   - ふだんは必ずサイトから読む（保存した分を優先しない）ので、更新はすぐ反映される
//   - API（状態・設定・履歴）は扱わない・保存しない
//   - ?login=1 を付けて開いたときは何もしない（そのまま Access のログイン画面へ進む）
self.startShellWorker = ({ cacheName, page, assets }) => {
    const origin = self.location.origin;
    const shell = new Set([page, ...assets]);
    const load = (path) => fetch(path, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
    const usable = (response) => response.ok && response.type === 'basic';

    self.addEventListener('install', (event) => {
        event.waitUntil((async () => {
            const cache = await caches.open(cacheName);
            for (const path of shell) {
                const response = await load(path);
                if (!usable(response)) throw new Error(`shell ${path}: ${response.status}`);   // 読めないものがあれば入れ替えない
                await cache.put(path, response);
            }
            await self.skipWaiting();
        })());
    });

    self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

    async function fromSiteOrShell(path) {
        const cache = await caches.open(cacheName);
        try {
            const response = await load(path);
            if (usable(response)) {
                await cache.put(path, response.clone()).catch(() => {});
                return response;
            }
            // 404 などサイトの正しい返事はそのまま返す。転送（ログイン画面）・401・403・5xx は保存した分を使う
            const refused = response.type === 'opaqueredirect' || [401, 403].includes(response.status) || response.status >= 500;
            return (refused && await cache.match(path)) || response;
        } catch (error) {
            const saved = await cache.match(path);
            if (saved) return saved;
            throw error;
        }
    }

    self.addEventListener('fetch', (event) => {
        const url = new URL(event.request.url);
        if (event.request.method !== 'GET' || url.origin !== origin || !shell.has(url.pathname)) return;
        if (event.request.mode === 'navigate' && url.searchParams.has('login')) return;
        event.respondWith(fromSiteOrShell(url.pathname));
    });
};
