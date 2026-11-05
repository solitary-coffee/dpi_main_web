const ADMONITION_STYLES = new Set(['info', 'tip', 'warn', 'alert']);
const ADMONITION_LABELS = {
    info: '情報',
    tip: 'ポイント',
    warn: '注意',
    alert: '警告'
};

const footnoteDefinitions = new Map();
const footnoteOrder = [];
const footnoteReferences = new Map();

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function safeFragmentId(value) {
    return encodeURIComponent(String(value).trim().toLowerCase())
        .replaceAll('%', '')
        .replace(/[^a-z0-9_-]/g, '-') || 'note';
}

function resetRenderState() {
    footnoteDefinitions.clear();
    footnoteOrder.length = 0;
    footnoteReferences.clear();
}

const admonitionExtension = {
    name: 'admonition',
    level: 'block',
    start(src) {
        return src.match(/^:::(?:note|tip|warning|danger|summary)\b/m)?.index;
    },
    tokenizer(src) {
        const rule = /^:::(note|tip|warning|danger|summary)(?:[ \t]+([^\n]*))?\n([\s\S]*?)\n:::(?:\n|$)/;
        const match = rule.exec(src);
        if (!match) return;

        const kind = match[1].toLowerCase();
        const options = (match[2] || '').trim().split(/\s+/).filter(Boolean);
        const requestedStyle = options[0]?.toLowerCase();
        let style = ADMONITION_STYLES.has(requestedStyle) ? requestedStyle : 'info';
        let title = ADMONITION_STYLES.has(requestedStyle) ? options.slice(1).join(' ') : options.join(' ');

        if (kind === 'tip') style = 'tip';
        if (kind === 'warning') style = 'warn';
        if (kind === 'danger') style = 'alert';
        if (kind === 'summary' && !title) title = '概要';
        if (!title) title = ADMONITION_LABELS[style];

        const token = {
            type: 'admonition',
            raw: match[0],
            style,
            title,
            text: match[3].trim(),
            tokens: []
        };
        this.lexer.blockTokens(token.text, token.tokens);
        return token;
    },
    renderer(token) {
        return `<aside class="admonition ${token.style}" role="note">`
            + `<div class="admonition-title">${escapeHtml(token.title)}</div>`
            + `${this.parser.parse(token.tokens)}</aside>`;
    }
};

const detailsExtension = {
    name: 'detailsBlock',
    level: 'block',
    start(src) {
        return src.match(/^:::details\b/m)?.index;
    },
    tokenizer(src) {
        const match = /^:::details(?:[ \t]+([^\n]*))?\n([\s\S]*?)\n:::(?:\n|$)/.exec(src);
        if (!match) return;
        const token = {
            type: 'detailsBlock',
            raw: match[0],
            title: match[1]?.trim() || '詳細を表示',
            text: match[2].trim(),
            tokens: []
        };
        this.lexer.blockTokens(token.text, token.tokens);
        return token;
    },
    renderer(token) {
        return `<details class="markdown-details"><summary>${escapeHtml(token.title)}</summary>`
            + `<div class="markdown-details-body">${this.parser.parse(token.tokens)}</div></details>`;
    }
};

const youtubeExtension = {
    name: 'youtube',
    level: 'block',
    start(src) {
        return src.match(/^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)/m)?.index;
    },
    tokenizer(src) {
        const rule = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,20})(?:[^\s]*)?(?:\n|$)/;
        const match = rule.exec(src);
        if (!match) return;
        return { type: 'youtube', raw: match[0], videoId: match[1] };
    },
    renderer(token) {
        return `<div class="video-container youtube-placeholder" data-video-id="${token.videoId}"></div>`;
    }
};

const mermaidExtension = {
    name: 'mermaidBlock',
    level: 'block',
    start(src) {
        return src.match(/^ {0,3}```mermaid\s*$/m)?.index;
    },
    tokenizer(src) {
        const match = /^ {0,3}```mermaid\s*\n([\s\S]*?)\n {0,3}```(?:\n|$)/.exec(src);
        if (!match) return;
        return { type: 'mermaidBlock', raw: match[0], text: match[1].trim() };
    },
    renderer(token) {
        return `<pre class="mermaid">${escapeHtml(token.text)}</pre>`;
    }
};

const blockMathExtension = {
    name: 'blockMath',
    level: 'block',
    start(src) {
        return src.indexOf('$$');
    },
    tokenizer(src) {
        const match = /^ {0,3}\$\$\s*\n?([\s\S]*?)\n?\$\$(?:\n|$)/.exec(src);
        if (!match) return;
        return { type: 'blockMath', raw: match[0], expression: match[1].trim() };
    },
    renderer(token) {
        return katex.renderToString(token.expression, { displayMode: true, throwOnError: false });
    }
};

const inlineMathExtension = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
        return src.indexOf('$');
    },
    tokenizer(src) {
        const match = /^\$([^$\n]+?)\$/.exec(src);
        if (!match || match[1].trim() !== match[1]) return;
        return { type: 'inlineMath', raw: match[0], expression: match[1] };
    },
    renderer(token) {
        return katex.renderToString(token.expression, { displayMode: false, throwOnError: false });
    }
};

const footnoteDefinitionExtension = {
    name: 'footnoteDefinition',
    level: 'block',
    start(src) {
        return src.match(/^ {0,3}\[\^[^\]\s]+\]:/m)?.index;
    },
    tokenizer(src) {
        const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]+([^\n]+)(?:\n|$)/.exec(src);
        if (!match) return;
        const id = match[1];
        if (!footnoteDefinitions.has(id)) footnoteOrder.push(id);
        footnoteDefinitions.set(id, match[2].trim());
        return { type: 'footnoteDefinition', raw: match[0] };
    },
    renderer() {
        return '';
    }
};

const footnoteReferenceExtension = {
    name: 'footnoteReference',
    level: 'inline',
    start(src) {
        return src.indexOf('[^');
    },
    tokenizer(src) {
        const match = /^\[\^([^\]\s]+)\]/.exec(src);
        if (!match) return;
        return { type: 'footnoteReference', raw: match[0], id: match[1] };
    },
    renderer(token) {
        const number = footnoteOrder.indexOf(token.id) + 1 || footnoteOrder.length + 1;
        const occurrence = (footnoteReferences.get(token.id) || 0) + 1;
        footnoteReferences.set(token.id, occurrence);
        const fragment = safeFragmentId(token.id);
        return `<sup class="footnote-ref" id="fnref-${fragment}-${occurrence}">`
            + `<a href="#fn-${fragment}" aria-label="脚注 ${number}">[${number}]</a></sup>`;
    }
};

marked.use({
    extensions: [
        detailsExtension,
        admonitionExtension,
        youtubeExtension,
        mermaidExtension,
        blockMathExtension,
        inlineMathExtension,
        footnoteDefinitionExtension,
        footnoteReferenceExtension
    ]
});

marked.setOptions({ breaks: true, gfm: true });

function appendFootnotes(contentDiv) {
    if (footnoteOrder.length === 0) return;

    const section = document.createElement('section');
    section.className = 'footnotes';
    section.setAttribute('aria-label', '脚注');
    section.innerHTML = '<hr><h2>脚注</h2>';
    const list = document.createElement('ol');

    footnoteOrder.forEach((id) => {
        const item = document.createElement('li');
        const fragment = safeFragmentId(id);
        item.id = `fn-${fragment}`;
        item.innerHTML = DOMPurify.sanitize(marked.parseInline(footnoteDefinitions.get(id) || ''));
        const backLink = document.createElement('a');
        backLink.className = 'footnote-backref';
        backLink.href = `#fnref-${fragment}-1`;
        backLink.setAttribute('aria-label', '本文へ戻る');
        backLink.textContent = ' ↩';
        item.appendChild(backLink);
        list.appendChild(item);
    });

    section.appendChild(list);
    contentDiv.appendChild(section);
}

function createYoutubePlayers(contentDiv) {
    contentDiv.querySelectorAll('.youtube-placeholder[data-video-id]').forEach((placeholder) => {
        const videoId = placeholder.dataset.videoId;
        if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return;
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}`;
        iframe.title = 'YouTube video player';
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        placeholder.appendChild(iframe);
    });
}

function enhanceTables(contentDiv) {
    contentDiv.querySelectorAll('table').forEach((table) => {
        if (table.parentElement?.classList.contains('table-wrapper')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';
        wrapper.tabIndex = 0;
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
    });
}

function enhanceCodeBlocks(contentDiv) {
    contentDiv.querySelectorAll('pre:not(.mermaid) code').forEach((code) => {
        if (window.hljs) hljs.highlightElement(code);
        const pre = code.parentElement;
        if (pre.querySelector('.code-copy-button')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'code-copy-button';
        button.textContent = 'コピー';
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(code.textContent);
                button.textContent = 'コピーしました';
            } catch {
                button.textContent = 'コピーできませんでした';
            }
            window.setTimeout(() => { button.textContent = 'コピー'; }, 1600);
        });
        pre.appendChild(button);
    });
}

function slugifyHeading(text, index) {
    const slug = text.normalize('NFKC').trim().toLowerCase()
        .replace(/[\s　]+/g, '-')
        .replace(/[^\p{Letter}\p{Number}_-]/gu, '')
        .replace(/-+/g, '-');
    return slug || `header-${index}`;
}

function buildTableOfContents(contentDiv, tocList, tocSidebar) {
    const headers = contentDiv.querySelectorAll('h1, h2, h3');
    if (!tocList || !tocSidebar || headers.length === 0) {
        if (tocSidebar) tocSidebar.style.display = 'none';
        return;
    }

    tocList.replaceChildren();
    const usedIds = new Set();
    headers.forEach((header, index) => {
        let id = slugifyHeading(header.textContent, index);
        let suffix = 2;
        while (usedIds.has(id)) id = `${slugifyHeading(header.textContent, index)}-${suffix++}`;
        usedIds.add(id);
        header.id = id;

        const anchor = document.createElement('a');
        anchor.className = 'heading-anchor';
        anchor.href = `#${id}`;
        anchor.setAttribute('aria-label', `${header.textContent}へのリンク`);
        anchor.textContent = '#';
        header.appendChild(anchor);

        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${id}`;
        link.textContent = header.childNodes[0]?.textContent?.trim() || header.textContent.replace(/#$/, '').trim();
        link.className = `toc-${header.tagName.toLowerCase()}`;
        li.appendChild(link);
        tocList.appendChild(li);
    });
}

function enhanceLinks(contentDiv) {
    contentDiv.querySelectorAll('a[href]').forEach((link) => {
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
    });
}

async function renderMermaid(contentDiv) {
    const nodes = [...contentDiv.querySelectorAll('.mermaid')];
    if (nodes.length === 0 || !window.mermaid) return;
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        flowchart: { htmlLabels: false, useMaxWidth: true }
    });
    try {
        await mermaid.run({ nodes });
    } catch (error) {
        console.error('Mermaidの描画に失敗しました:', error);
        nodes.forEach((node) => node.classList.add('mermaid-error'));
    }
}

async function renderMarkdown(markdownText, contentDiv) {
    resetRenderState();
    const parsed = marked.parse(markdownText);
    contentDiv.innerHTML = DOMPurify.sanitize(parsed, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ['aria-label', 'role', 'data-video-id']
    });

    appendFootnotes(contentDiv);
    createYoutubePlayers(contentDiv);
    enhanceTables(contentDiv);
    enhanceCodeBlocks(contentDiv);
    enhanceLinks(contentDiv);
    await renderMermaid(contentDiv);
}

document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const fileId = params.get('id');
    const contentDiv = document.getElementById('content');
    const tocList = document.getElementById('toc-list');
    const tocSidebar = document.getElementById('toc-sidebar');

    if (!contentDiv) return;
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
        contentDiv.innerHTML = '<h1>記事を選択してください</h1><p>正しい記事IDを指定してください。</p>';
        if (tocSidebar) tocSidebar.style.display = 'none';
        return;
    }

    try {
        const response = await fetch(`./${encodeURIComponent(fileId)}.md?t=${Date.now()}`);
        if (!response.ok) throw new Error(`記事が見つかりませんでした (Status: ${response.status})`);
        await renderMarkdown(await response.text(), contentDiv);

        const h1 = contentDiv.querySelector('h1');
        document.title = `${h1?.childNodes[0]?.textContent?.trim() || fileId} | DPI-Bot`;
        buildTableOfContents(contentDiv, tocList, tocSidebar);

        if (window.location.hash) {
            document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
        }
    } catch (error) {
        console.error(error);
        contentDiv.replaceChildren();
        const box = document.createElement('div');
        box.className = 'admonition alert';
        const title = document.createElement('div');
        title.className = 'admonition-title';
        title.textContent = 'エラー';
        const message = document.createElement('p');
        message.textContent = error instanceof Error ? error.message : '記事を読み込めませんでした。';
        box.append(title, message);
        contentDiv.appendChild(box);
        if (tocSidebar) tocSidebar.style.display = 'none';
    }
});
