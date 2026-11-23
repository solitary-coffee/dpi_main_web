// 操作盤の Service Worker。中身は ../patlite-admin/shell-worker.js（ログインが切れた後の再読み込み・再起動でもページを開けるようにする）。
importScripts('/site/patlite-admin/shell-worker.js');
self.startShellWorker({
    cacheName: 'control-deck-shell-v1',
    page: '/site/control-deck/',
    assets: [
        '/site/control-deck/deck.js', '/site/control-deck/deck.css',
        '/site/patlite-admin/logic.js', '/site/patlite-admin/lamp-key.js',
    ],
});
