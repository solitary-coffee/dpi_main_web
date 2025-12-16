/**
 * 1. カスタム拡張機能 (:::note info 等)
 */
const admonitionExtension = {
    name: 'admonition',
    level: 'block',
    start(src) { return src.match(/^:::/)?.index; },
    tokenizer(src) {
        // :::type title の形式を解析
        const rule = /^:::([a-zA-Z0-9]+)(?:[ \t]+(.*?))?\n([\s\S]*?)\n:::/;
        const match = rule.exec(src);
        if (match) {
            const token = {
                type: 'admonition',
                raw: match[0],
                kind: match[1], // note
                style: match[2]?.trim() || 'info', // info, warn, alert
                text: match[3].trim(), // 本文
                tokens: [] 
            };
            
            // ★修正点: ここで中身のMarkdownを解析しておく
            this.lexer.blockTokens(token.text, token.tokens);
            
            return token;
        }
    },
    renderer(token) {
        // ★修正点: 解析済みのトークンを使ってHTMLにする
        const html = this.parser.parse(token.tokens);
        
        return `<div class="admonition ${token.style}">
                    <span class="admonition-title">${token.style}</span>
                    ${html}
                </div>`;
    }
};

// markedに拡張機能を登録
marked.use({ extensions: [admonitionExtension] });


/**
 * 2. メイン処理
 */
document.addEventListener('DOMContentLoaded', async () => {
    
    // URLパラメータからファイルIDを取得 (?id=filename)
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
        // Markdownファイルを取得
        const response = await fetch(`./${fileId}.md?t=${new Date().getTime()}`);
        
        if (!response.ok) {
            throw new Error(`記事が見つかりませんでした (Status: ${response.status})`);
        }

        const markdownText = await response.text();

        // 変換して表示
        contentDiv.innerHTML = marked.parse(markdownText);

        // ページタイトルを更新 (H1があればそれを使用)
        const h1 = contentDiv.querySelector('h1');
        if(h1) {
            document.title = h1.innerText + " | DPI-Bot";
        } else {
            document.title = fileId + " | DPI-Bot";
        }

        // ---------------------------------------------------
        // 目次 (TOC) 生成
        // ---------------------------------------------------
        const headers = contentDiv.querySelectorAll('h1, h2, h3');
        
        if (headers.length === 0) {
            if(tocSidebar) tocSidebar.style.display = 'none';
        } else {
            headers.forEach((header, index) => {
                // ID付与
                const anchorId = `header-${index}`;
                header.id = anchorId;

                // リストアイテム作成
                const li = document.createElement('li');
                const a = document.createElement('a');
                
                a.href = `#${anchorId}`;
                a.innerText = header.innerText;
                a.className = `toc-${header.tagName.toLowerCase()}`;
                
                // スムーズスクロール
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