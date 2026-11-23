// 積層灯ページの Service Worker。中身は shell-worker.js（ログインが切れた後の再読み込み・再起動でもページを開けるようにする）。
importScripts('/site/patlite-admin/shell-worker.js');
self.startShellWorker({
    cacheName: 'patlite-admin-shell-v1',
    page: '/site/patlite-admin/',
    assets: [
        '/site/patlite-admin/script.js', '/site/patlite-admin/logic.js', '/site/patlite-admin/lamp-key.js', '/site/patlite-admin/ticker.js',
        '/site/patlite-admin/vendor/web-serial-polyfill.js', '/site/patlite-admin/style.css',
        '/site/admin-shell.css', '/site/admin-center/style.css', '/script.js',
    ],
});
