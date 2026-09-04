const ACCESS_CERT_CACHE_MS = 60 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;
const accessKeyCache = new Map();

export class AccessAuthError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'AccessAuthError';
        this.status = status;
        this.code = code;
        this.publicMessage = message;
    }
}

export async function authenticateNewsletterAdmin(request, env) {
    const audience = cleanConfigValue(env.ACCESS_AUD);
    const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    const allowedEmails = new Set(
        cleanConfigValue(env.MAIL_ADMIN_EMAILS)
            .split(',')
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean),
    );

    if (!audience || !teamDomain || allowedEmails.size === 0) {
        throw new AccessAuthError(
            503,
            'admin_not_configured',
            '配信管理画面の認証設定が完了していません。',
        );
    }

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token || token.length > 16_384) {
        throw new AccessAuthError(403, 'access_required', 'Cloudflare Accessでの認証が必要です。');
    }

    try {
        const { header, payload, signingInput, signature } = parseJwt(token);
        const now = Math.floor(Date.now() / 1_000);

        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
            throw new Error('unsupported_jwt_header');
        }
        if (payload.iss !== teamDomain || !audienceMatches(payload.aud, audience)) {
            throw new Error('invalid_jwt_claims');
        }
        if (
            !Number.isFinite(payload.exp)
            || payload.exp < now - CLOCK_SKEW_SECONDS
            || (Number.isFinite(payload.nbf) && payload.nbf > now + CLOCK_SKEW_SECONDS)
            || (Number.isFinite(payload.iat) && payload.iat > now + CLOCK_SKEW_SECONDS)
        ) {
            throw new Error('expired_or_future_jwt');
        }

        const jwk = await getSigningKey(teamDomain, header.kid);
        const cryptoKey = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        );
        const signatureIsValid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            cryptoKey,
            signature,
            new TextEncoder().encode(signingInput),
        );
        if (!signatureIsValid) throw new Error('invalid_jwt_signature');

        const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
        if (!email || !allowedEmails.has(email)) {
            throw new AccessAuthError(403, 'admin_not_allowed', 'このアカウントには配信権限がありません。');
        }

        return { email, subject: typeof payload.sub === 'string' ? payload.sub : '' };
    } catch (error) {
        if (error instanceof AccessAuthError) throw error;
        throw new AccessAuthError(403, 'invalid_access_token', 'Cloudflare Accessの認証を確認できませんでした。');
    }
}

function normalizeTeamDomain(value) {
    const configured = cleanConfigValue(value);
    if (!configured) return '';

    try {
        const url = new URL(configured.includes('://') ? configured : `https://${configured}`);
        if (
            url.protocol !== 'https:'
            || !url.hostname.toLowerCase().endsWith('.cloudflareaccess.com')
            || url.username
            || url.password
            || url.port
            || (url.pathname !== '/' && url.pathname !== '')
            || url.search
            || url.hash
        ) {
            return '';
        }
        return url.origin;
    } catch {
        return '';
    }
}

function parseJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('malformed_jwt');

    const header = parseJwtJson(parts[0]);
    const payload = parseJwtJson(parts[1]);
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
        throw new Error('invalid_jwt_json');
    }

    return {
        header,
        payload,
        signingInput: `${parts[0]}.${parts[1]}`,
        signature: decodeBase64Url(parts[2]),
    };
}

function parseJwtJson(value) {
    const bytes = decodeBase64Url(value);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
}

function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid_base64url');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
        + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function audienceMatches(claim, expected) {
    if (typeof claim === 'string') return claim === expected;
    return Array.isArray(claim) && claim.some((item) => item === expected);
}

async function getSigningKey(teamDomain, kid) {
    let cached = accessKeyCache.get(teamDomain);
    if (!cached || cached.expiresAt <= Date.now()) {
        cached = await fetchSigningKeys(teamDomain);
    }

    let key = cached.keys.find((item) => item?.kid === kid && item?.kty === 'RSA');
    if (!key) {
        cached = await fetchSigningKeys(teamDomain, true);
        key = cached.keys.find((item) => item?.kid === kid && item?.kty === 'RSA');
    }
    if (!key) throw new Error('unknown_signing_key');
    return key;
}

async function fetchSigningKeys(teamDomain, force = false) {
    if (!force) {
        const cached = accessKeyCache.get(teamDomain);
        if (cached && cached.expiresAt > Date.now()) return cached;
    }

    const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
        headers: { Accept: 'application/json' },
        cf: { cacheTtl: 3_600, cacheEverything: true },
    });
    if (!response.ok) throw new Error('access_certs_unavailable');

    const body = await response.json();
    if (!Array.isArray(body?.keys) || body.keys.length === 0) {
        throw new Error('invalid_access_certs');
    }

    const cached = { keys: body.keys, expiresAt: Date.now() + ACCESS_CERT_CACHE_MS };
    accessKeyCache.set(teamDomain, cached);
    return cached;
}

function cleanConfigValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export const __test = Object.freeze({
    audienceMatches,
    normalizeTeamDomain,
    parseJwt,
});
