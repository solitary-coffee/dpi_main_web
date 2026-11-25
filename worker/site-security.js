const PUBLIC_HOSTS = new Set(['dpi-bot.com', 'www.dpi-bot.com']);

const SECURITY_HEADERS = Object.freeze({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), payment=(self "https://checkout.stripe.com")',
});

export async function withSiteSecurity(request, handler) {
    const redirect = httpRedirect(request);
    const response = redirect || await handler();
    return addSiteSecurityHeaders(request, response);
}

export function httpRedirect(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return null;
    const url = new URL(request.url);
    if (!PUBLIC_HOSTS.has(url.hostname.toLowerCase()) || requestScheme(request, url) !== 'http') return null;
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
}

export function addSiteSecurityHeaders(request, response) {
    if (!response?.headers) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (!headers.has(name)) headers.set(name, value);
    }
    if (requestScheme(request) === 'https' && !headers.has('Strict-Transport-Security')) {
        headers.set('Strict-Transport-Security', 'max-age=15552000');
    }
    if (isHtml(headers) && !headers.has('Content-Security-Policy')) {
        headers.set('Content-Security-Policy', "frame-ancestors 'self'");
    }

    // 101 は WebSocket を保持するため Response を作り直さない。
    if (response.status === 101) {
        try {
            for (const [name, value] of headers) {
                if (!response.headers.has(name)) response.headers.set(name, value);
            }
        } catch {
            // プラットフォームが不変ヘッダーを返す場合はハンドシェイクを優先する。
        }
        return response;
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function requestScheme(request, parsedUrl = new URL(request.url)) {
    const visitor = request.headers.get('cf-visitor');
    if (visitor) {
        try {
            const scheme = JSON.parse(visitor)?.scheme?.toLowerCase();
            if (scheme === 'https') return 'https';
            if (scheme === 'http') return 'http';
        } catch {
            // 不正な cf-visitor は URL のプロトコルへフォールバックする。
        }
    }
    return parsedUrl.protocol === 'https:' ? 'https' : parsedUrl.protocol === 'http:' ? 'http' : '';
}

function isHtml(headers) {
    return /^text\/html(?:\s*;|$)/iu.test(headers.get('content-type') || '');
}

export const __test = Object.freeze({ requestScheme, isHtml });
