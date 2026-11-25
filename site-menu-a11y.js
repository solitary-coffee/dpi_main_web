export function setupSiteMenu(doc = document) {
    const button = doc.getElementById('menu-toggle-btn');
    const sidebar = doc.querySelector('.sidebar');
    const overlay = doc.querySelector('.overlay');
    if (!button || !sidebar || !overlay || button.dataset.menuA11yReady === 'true') return;

    button.dataset.menuA11yReady = 'true';
    if (button.tagName !== 'BUTTON') {
        button.setAttribute('role', 'button');
        button.setAttribute('tabindex', '0');
    }

    if (!sidebar.id) {
        let id = 'site-menu';
        let suffix = 2;
        while (doc.getElementById(id)) id = `site-menu-${suffix++}`;
        sidebar.id = id;
    }
    button.setAttribute('aria-controls', sidebar.id);

    const syncState = () => {
        const open = sidebar.classList.contains('open');
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
    };
    const close = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        syncState();
    };

    syncState();
    button.addEventListener('click', syncState);
    overlay.addEventListener('click', syncState);
    if (button.tagName !== 'BUTTON') {
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            button.click();
        });
    }
    doc.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !sidebar.classList.contains('open')) return;
        close();
        button.focus();
    });
}
