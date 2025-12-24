// functions/posts/_middleware.js

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const fileId = url.searchParams.get('id');

    // 1. URLに "?id=..." がなければ、何もしないでそのままページを表示
    if (!fileId) {
        return context.next();
    }

    // 2. 記事のMarkdownファイルを取得しに行く
    // (自分自身のサイトのURLから取得)
    const mdUrl = `${url.origin}/posts/${fileId}.md`;
    
    // 内部通信で取得を試みる
    const mdResponse = await fetch(mdUrl);

    if (!mdResponse.ok) {
        return context.next(); // 記事がなければそのまま
    }

    const mdText = await mdResponse.text();

    // 3. Markdownからタイトル(# )と、最初の画像(![])を探し出す
    // 正規表現で # タイトル... を探す
    const titleMatch = mdText.match(/^#\s+(.*)$/m);
    // 正規表現で ![...](画像URL) を探す
    const imgMatch = mdText.match(/!\[.*?\]\((.*?)\)/);

    // タイトルが見つかればそれを使う。なければデフォルト。
    const title = titleMatch ? titleMatch[1] : 'DPI-Bot 記事';
    
    // 画像が見つかれば、絶対パスに変換して使う。なければデフォルト。
    let image = 'https://dpi-bot.com/img/dpi.png'; // ★デフォルト画像のURL
    if (imgMatch) {
        let imgPath = imgMatch[1];
        // 相対パス(../img/...)を絶対パス(https://...)に変換
        if (imgPath.startsWith('../')) {
            image = `${url.origin}/${imgPath.replace('../', '')}`;
        } else if (imgPath.startsWith('http')) {
            image = imgPath;
        } else if (imgPath.startsWith('/')) {
            image = `${url.origin}${imgPath}`;
        }
    }

    // 4. 元のHTMLページ（posts/index.html）を取得
    const response = await context.next();

    // 5. HTMLRewriterを使って、METAタグを書き換えてからユーザーに返す
    return new HTMLRewriter()
      .on('title', {
        element(e) { e.setInnerContent(title + " | DPI-Bot"); }
      })
      .on('meta[property="og:title"]', {
        element(e) { e.setAttribute('content', title); }
      })
      .on('meta[property="og:image"]', {
        element(e) { e.setAttribute('content', image); }
      })
      .on('meta[name="twitter:title"]', {
        element(e) { e.setAttribute('content', title); }
      })
      .on('meta[name="twitter:image"]', {
        element(e) { e.setAttribute('content', image); }
      })
      .transform(response);
}