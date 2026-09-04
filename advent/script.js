/**
 * 1. カスタム拡張機能 (:::note info 等)
 */
/**
 * 1. カスタム拡張機能 (:::summary や :::note info 等)
 */
const admonitionExtension = {
    name: 'admonition',
    level: 'block',
    start(src) { return src.match(/^:::/)?.index; },
    tokenizer(src) {
        // :::kind title の形式を解析
        const rule = /^:::([a-zA-Z0-9]+)(?:[ \t]+(.*?))?\n([\s\S]*?)\n:::/;
        const match = rule.exec(src);
        if (match) {
            const kind = match[1]; // summary, note など
            let style = match[2]?.trim(); // info, warn など
            
            // ★追加: もし "summary" だったら、スタイルも "summary" に強制する
            if (kind === 'summary') {
                style = 'summary';
            }
            // スタイル指定がない場合のデフォルトは info
            if (!style) {
                style = 'info';
            }

            const token = {
                type: 'admonition',
                raw: match[0],
                kind: kind,
                style: style,
                text: match[3].trim(),
                tokens: [] 
            };
            
            this.lexer.blockTokens(token.text, token.tokens);
            return token;
        }
    },
    renderer(token) {
        const html = this.parser.parse(token.tokens);
        
        // summaryの場合はタイトルを「あらすじ」や「概要」にする（任意で変更可）
        let titleDisplay = token.style;
        if (token.style === 'summary') {
            titleDisplay = '📝 概要'; // ここで表示文字を変えられます
        }

        return `<div class="admonition ${token.style}">
                    <span class="admonition-title">${titleDisplay}</span>
                    ${html}
                </div>`;
    }
};

// ... (以下、youtubeExtension や marked.use, DOMContentLoaded はそのまま)

/**
 * ★追加: YouTube埋め込み拡張機能
 * URLだけの行 (https://youtube.com/watch?v=...) を検知して動画プレイヤーにします
 */
const youtubeExtension = {
    name: 'youtube',
    level: 'block',
    start(src) { return src.match(/^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/)?.index; },
    tokenizer(src) {
        // YouTubeのURL正規表現 (動画IDを取得)
        const rule = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)(?:&[^\s]*)?\n?/;
        const match = rule.exec(src);
        if (match) {
            return {
                type: 'youtube',
                raw: match[0],
                videoId: match[1]
            };
        }
    },
    renderer(token) {
        return `<div class="video-container">
                    <iframe src="https://www.youtube.com/embed/${token.videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                </div>`;
    }
};

// 拡張機能を登録
marked.use({ extensions: [admonitionExtension, youtubeExtension] });

// ★追加: 基本設定 (URLの自動リンク化 と 改行の有効化)
marked.setOptions({
    breaks: true, // 改行を <br> に変換
    gfm: true     // GitHub Flavored Markdown (URL自動リンクなど) を有効化
});

function renderMarkdownWithMath(markdownText, contentDiv) {
    const mathExpressions = [];
    const placeholderPattern = /@@LATEX_(\d+)@@/g;
    const protectedMarkdown = markdownText.replace(
        /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$([^$\n]+)\$/g,
        (match, displayDollar, displayBracket, inlineBracket, inlineDollar) => {
            const expression = displayDollar ?? displayBracket ?? inlineBracket ?? inlineDollar;
            const displayMode = displayDollar !== undefined || displayBracket !== undefined;
            const index = mathExpressions.push({ expression: expression.trim(), displayMode }) - 1;
            return `@@LATEX_${index}@@`;
        }
    );

    contentDiv.innerHTML = marked.parse(protectedMarkdown);
    const textNodes = [];
    const walker = document.createTreeWalker(contentDiv, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    textNodes.forEach((textNode) => {
        if (!placeholderPattern.test(textNode.nodeValue)) {
            return;
        }

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        placeholderPattern.lastIndex = 0;
        let match;
        while ((match = placeholderPattern.exec(textNode.nodeValue)) !== null) {
            fragment.append(textNode.nodeValue.slice(lastIndex, match.index));
            const math = mathExpressions[Number(match[1])];
            const mathElement = document.createElement('span');
            katex.render(math.expression, mathElement, {
                displayMode: math.displayMode,
                throwOnError: false
            });
            fragment.append(mathElement);
            lastIndex = match.index + match[0].length;
        }
        fragment.append(textNode.nodeValue.slice(lastIndex));
        textNode.replaceWith(fragment);
    });
}


/**
 * 2. メイン処理
 */
document.addEventListener('DOMContentLoaded', async () => {
    
    const params = new URLSearchParams(window.location.search);
    const fileId = params.get('id');
    
    const contentDiv = document.getElementById('content');
    const tocList = document.getElementById('toc-list');
    const tocSidebar = document.getElementById('toc-sidebar');

    if (!fileId) {
        contentDiv.innerHTML = '<h1>記事を選択してください</h1><p>URLの末尾に ?id=ファイル名 をつけてください。</p>';
        if(tocSidebar) tocSidebar.style.display = 'none';
        return;
    }

    try {
        const response = await fetch(`./${fileId}.md?t=${new Date().getTime()}`);
        
        if (!response.ok) {
            throw new Error(`記事が見つかりませんでした (Status: ${response.status})`);
        }

        const markdownText = await response.text();

        // 変換して表示
        renderMarkdownWithMath(markdownText, contentDiv);

        // タイトル更新
        const h1 = contentDiv.querySelector('h1');
        if(h1) {
            document.title = h1.innerText + " | DPI-Bot";
        } else {
            document.title = fileId + " | DPI-Bot";
        }

        // 目次生成
        const headers = contentDiv.querySelectorAll('h1, h2, h3');
        if (headers.length === 0) {
            if(tocSidebar) tocSidebar.style.display = 'none';
        } else {
            headers.forEach((header, index) => {
                const anchorId = `header-${index}`;
                header.id = anchorId;

                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = `#${anchorId}`;
                a.innerText = header.innerText;
                a.className = `toc-${header.tagName.toLowerCase()}`;
                
                a.onclick = (e) => {
                    e.preventDefault();
                    header.scrollIntoView({ behavior: 'smooth' });
                };

                li.appendChild(a);
                tocList.appendChild(li);
            });
        }

    } catch (error) {
        console.error(error);
        contentDiv.innerHTML = `<div class="admonition alert"><span class="admonition-title">Error</span><p>${error.message}</p></div>`;
        if(tocSidebar) tocSidebar.style.display = 'none';
    }
});