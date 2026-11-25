import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupSiteMenu } from '../site-menu-a11y.js';

class FakeTarget {
    constructor(tagName = 'DIV') {
        this.tagName = tagName;
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.id = '';
        this.focused = false;
        const classes = new Set();
        this.classList = {
            contains: (name) => classes.has(name),
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            toggle: (name) => classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true),
        };
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatch(type, key) {
        const event = { key, preventDefault() { this.defaultPrevented = true; } };
        for (const listener of this.listeners.get(type) || []) listener(event);
        return event;
    }
    click() { this.dispatch('click'); }
    focus() { this.focused = true; }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function makeDom(tagName = 'BUTTON') {
    const button = new FakeTarget(tagName);
    const sidebar = new FakeTarget();
    const overlay = new FakeTarget();
    const doc = new FakeTarget('DOCUMENT');
    const reserved = new FakeTarget();
    reserved.id = 'site-menu';
    doc.getElementById = (id) => id === 'menu-toggle-btn' ? button
        : [reserved, sidebar].find((node) => node.id === id) || null;
    doc.querySelector = (selector) => selector === '.sidebar' ? sidebar : overlay;
    button.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
    });
    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });
    return { doc, button, sidebar, overlay };
}

test('共通メニューJSは状態・関連先・Esc・外側クリックを扱う', () => {
    const { doc, button, sidebar, overlay } = makeDom();
    setupSiteMenu(doc);
    setupSiteMenu(doc);

    assert.equal(sidebar.id, 'site-menu-2');
    assert.equal(button.getAttribute('aria-controls'), 'site-menu-2');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'メニューを開く');

    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'メニューを閉じる');
    overlay.click();
    assert.equal(button.getAttribute('aria-expanded'), 'false');

    button.click();
    doc.dispatch('keydown', 'Escape');
    assert.equal(sidebar.classList.contains('open'), false);
    assert.equal(button.focused, true);
});

test('button以外はEnterとSpaceで一度ずつ動く', () => {
    const { doc, button, sidebar } = makeDom('DIV');
    setupSiteMenu(doc);
    setupSiteMenu(doc);
    assert.equal(button.getAttribute('role'), 'button');
    assert.equal(button.getAttribute('tabindex'), '0');

    button.dispatch('keydown', 'Enter');
    assert.equal(sidebar.classList.contains('open'), true);
    button.dispatch('keydown', ' ');
    assert.equal(sidebar.classList.contains('open'), false);
});

test('対象HTMLの見出しはh1が一つで階層が飛ばない', async () => {
    for (const file of ['map/index.html', 'site/infre/index.html', 'site/status/index.html']) {
        const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html;
        const levels = [...main.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
        assert.equal(levels.filter((level) => level === 1).length, 1, `${file}: h1`);
        for (let index = 1; index < levels.length; index++) {
            assert.ok(levels[index] <= levels[index - 1] + 1, `${file}: h${levels[index - 1]}→h${levels[index]}`);
        }
    }
});
