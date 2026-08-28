const TOPICS = Object.freeze({
    bot_issue: 'BOTの不具合',
    bug_report: 'Webサイトのバグ報告',
    buy_report: '支援について',
    other: 'その他のお問い合わせ',
});

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

class ContactError extends Error {
    constructor(status, publicMessage, code) {
        super(publicMessage);
        this.name = 'ContactError';
        this.status = status;
        this.publicMessage = publicMessage;
        this.code = code;
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';

        if (pathname === '/api/contact/config' && request.method === 'GET') {
            return contactConfig(env);
        }

        if (pathname === '/api/contact' && request.method === 'POST') {
            return handleContactRequest(request, env);
        }

        if (pathname === '/api/contact' || pathname === '/api/contact/config') {
            return jsonResponse(
                { success: false, message: '許可されていない操作です。' },
                405,
                { Allow: pathname.endsWith('/config') ? 'GET' : 'POST' },
            );
        }

        return env.ASSETS.fetch(request);
    },
};

function contactConfig(env) {
    const siteKey = cleanConfigValue(env.RECAPTCHA_SITE_KEY);
    return jsonResponse({
        success: true,
        configured: Boolean(siteKey),
        siteKey: siteKey || null,
    });
}

export async function handleContactRequest(request, env) {
    const reference = createReference();

    try {
        assertConfigured(env);
        assertSameOrigin(request);

        const contentType = request.headers.get('content-type') || '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
            throw new ContactError(415, '送信形式が正しくありません。', 'invalid_content_type');
        }

        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
            throw new ContactError(413, '送信データが大きすぎます。', 'request_too_large');
        }

        const rawBody = await readBodyWithLimit(request.body, MAX_REQUEST_BYTES);
        const formData = await parseMultipartFormData(request.url, contentType, rawBody);

        // Botには受付成功と見せますが、メールは送信しません。
        if (getString(formData, 'website').trim()) {
            return jsonResponse({ success: true, reference });
        }

        assertReasonableSubmissionTime(getString(formData, 'formStartedAt'));

        const name = validateName(getString(formData, 'name'));
        const email = validateEmail(getString(formData, 'email'));
        const topic = validateTopic(getString(formData, 'topic'));
        const message = validateMessage(getString(formData, 'message'));

        if (getString(formData, 'privacyConsent') !== 'agreed') {
            throw new ContactError(
                400,
                'プライバシーポリシーへの同意が必要です。',
                'privacy_consent_required',
            );
        }

        const recaptchaToken = getString(formData, 'recaptchaToken');
        await verifyRecaptcha(recaptchaToken, request, env);

        const uploadedFiles = formData
            .getAll('attachments')
            .filter((value) => isUploadedFile(value) && value.size > 0);
        const attachments = await prepareAttachments(uploadedFiles);

        const receivedAt = new Date().toISOString();
        const topicLabel = TOPICS[topic];
        const attachmentSummary = attachments.length
            ? attachments.map((item) => `- ${item.originalName} → ${item.filename}`).join('\n')
            : 'なし';

        const mailText = [
            'DPI-Bot お問い合わせフォーム',
            '',
            `受付番号: ${reference}`,
            `受付時刻: ${receivedAt}`,
            `概要: ${topicLabel}`,
            `お名前: ${name}`,
            `メールアドレス: ${email}`,
            '添付ファイル:',
            attachmentSummary,
            '',
            '本文',
            '----------------------------------------',
            message,
        ].join('\n');

        await env.CONTACT_EMAIL.send({
            to: cleanConfigValue(env.CONTACT_TO_EMAIL),
            from: cleanConfigValue(env.CONTACT_FROM_EMAIL),
            replyTo: email,
            subject: `[DPI-Bot お問い合わせ] ${topicLabel} (${reference})`,
            text: mailText,
            attachments: attachments.map((item) => ({
                content: item.bytes.buffer,
                filename: item.filename,
                type: item.type,
                disposition: 'attachment',
            })),
        });

        return jsonResponse({ success: true, reference });
    } catch (error) {
        if (error instanceof ContactError) {
            return jsonResponse(
                { success: false, message: error.publicMessage, code: error.code, reference },
                error.status,
            );
        }

        // 入力本文・メールアドレス・添付内容はログへ出しません。
        console.error('Contact form processing failed', {
            reference,
            errorName: error?.name || 'Error',
            errorCode: error?.code || 'unknown',
        });
        return jsonResponse(
            {
                success: false,
                message: '送信処理に失敗しました。時間をおいて再度お試しください。',
                code: 'internal_error',
                reference,
            },
            500,
        );
    }
}

function assertConfigured(env) {
    const required = [
        ['CONTACT_EMAIL', env.CONTACT_EMAIL],
        ['CONTACT_FROM_EMAIL', cleanConfigValue(env.CONTACT_FROM_EMAIL)],
        ['CONTACT_TO_EMAIL', cleanConfigValue(env.CONTACT_TO_EMAIL)],
        ['RECAPTCHA_SITE_KEY', cleanConfigValue(env.RECAPTCHA_SITE_KEY)],
        ['RECAPTCHA_SECRET_KEY', cleanConfigValue(env.RECAPTCHA_SECRET_KEY)],
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);

    if (missing.length) {
        console.error('Contact form configuration is incomplete', { missing });
        throw new ContactError(
            503,
            'お問い合わせフォームは現在設定中です。メールでお問い合わせください。',
            'service_not_configured',
        );
    }
}

function assertSameOrigin(request) {
    const origin = request.headers.get('origin');
    const expectedOrigin = new URL(request.url).origin;
    if (!origin || origin !== expectedOrigin) {
        throw new ContactError(403, 'このページ以外からは送信できません。', 'invalid_origin');
    }
}

async function readBodyWithLimit(body, limit) {
    if (!body) {
        throw new ContactError(400, '送信内容がありません。', 'empty_body');
    }

    const reader = body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new ContactError(413, '送信データが大きすぎます。', 'request_too_large');
        }
        chunks.push(value);
    }

    const bodyBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bodyBytes;
}

async function parseMultipartFormData(url, contentType, rawBody) {
    try {
        const parsedRequest = new Request(url, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: rawBody,
        });
        return await parsedRequest.formData();
    } catch {
        throw new ContactError(400, '送信内容を読み取れませんでした。', 'invalid_form_data');
    }
}

function assertReasonableSubmissionTime(rawStartedAt) {
    const startedAt = Number(rawStartedAt);
    const now = Date.now();
    const elapsed = now - startedAt;

    if (!Number.isFinite(startedAt) || elapsed < 1_500 || elapsed > 2 * 60 * 60 * 1_000) {
        throw new ContactError(
            400,
            'フォームの有効時間が切れました。ページを再読み込みしてください。',
            'invalid_form_time',
        );
    }
}

function getString(formData, key) {
    const value = formData.get(key);
    return typeof value === 'string' ? value : '';
}

function normalizeText(value) {
    return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function validateName(rawName) {
    const name = normalizeText(rawName).trim();
    if (!name || name.length > 80 || /[\n\u0000-\u001f\u007f]/u.test(name)) {
        throw new ContactError(400, 'お名前は80文字以内で入力してください。', 'invalid_name');
    }
    return name;
}

function validateEmail(rawEmail) {
    const email = rawEmail.trim();
    const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
    const [localPart = '', domain = ''] = email.split('@');
    if (
        !email
        || email.length > 254
        || localPart.length > 64
        || localPart.startsWith('.')
        || localPart.endsWith('.')
        || localPart.includes('..')
        || domain.length > 253
        || /[\r\n\u0000]/u.test(email)
        || !emailPattern.test(email)
    ) {
        throw new ContactError(
            400,
            '有効なメールアドレスを入力してください。',
            'invalid_email',
        );
    }
    return email;
}

function validateTopic(rawTopic) {
    if (!Object.hasOwn(TOPICS, rawTopic)) {
        throw new ContactError(400, 'お問い合わせの概要を選択してください。', 'invalid_topic');
    }
    return rawTopic;
}

function validateMessage(rawMessage) {
    const message = normalizeText(rawMessage).trim();
    if (!message || message.length > 5_000 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)) {
        throw new ContactError(400, '本文は5,000文字以内で入力してください。', 'invalid_message');
    }
    return message;
}

async function verifyRecaptcha(token, request, env) {
    if (!token || token.length > 4_096) {
        throw new ContactError(
            400,
            'reCAPTCHAの確認を完了してください。',
            'recaptcha_required',
        );
    }

    const params = new URLSearchParams({
        secret: cleanConfigValue(env.RECAPTCHA_SECRET_KEY),
        response: token,
    });
    const remoteIp = request.headers.get('CF-Connecting-IP');
    if (remoteIp) params.set('remoteip', remoteIp);

    let response;
    try {
        response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: params,
        });
    } catch {
        throw new ContactError(
            503,
            'reCAPTCHAの確認に失敗しました。時間をおいて再度お試しください。',
            'recaptcha_unavailable',
        );
    }

    if (!response.ok) {
        throw new ContactError(
            503,
            'reCAPTCHAの確認に失敗しました。時間をおいて再度お試しください。',
            'recaptcha_unavailable',
        );
    }

    const result = await response.json();
    const requestHostname = new URL(request.url).hostname.toLowerCase();
    const configuredHostnames = cleanConfigValue(env.RECAPTCHA_ALLOWED_HOSTS)
        .split(',')
        .map((hostname) => hostname.trim().toLowerCase())
        .filter(Boolean);
    const allowedHostnames = new Set(configuredHostnames.length ? configuredHostnames : [requestHostname]);
    const challengeTime = Date.parse(result.challenge_ts || '');
    const challengeIsFresh = Number.isFinite(challengeTime)
        && Math.abs(Date.now() - challengeTime) <= 5 * 60 * 1_000;

    if (
        result.success !== true
        || !allowedHostnames.has(String(result.hostname || '').toLowerCase())
        || !challengeIsFresh
    ) {
        throw new ContactError(
            400,
            'reCAPTCHAの確認に失敗しました。もう一度お試しください。',
            'recaptcha_failed',
        );
    }
}

function isUploadedFile(value) {
    return value
        && typeof value === 'object'
        && typeof value.name === 'string'
        && typeof value.size === 'number'
        && typeof value.arrayBuffer === 'function';
}

async function prepareAttachments(files) {
    if (files.length > MAX_FILES) {
        throw new ContactError(400, '添付できるファイルは3個までです。', 'too_many_files');
    }

    const rawTotal = files.reduce((sum, file) => sum + file.size, 0);
    if (rawTotal > MAX_TOTAL_FILE_BYTES) {
        throw new ContactError(
            413,
            '添付ファイルは合計3MB以内にしてください。',
            'attachments_too_large',
        );
    }

    const prepared = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (file.size > MAX_FILE_BYTES) {
            throw new ContactError(
                413,
                '添付ファイルは1個につき2MB以内にしてください。',
                'file_too_large',
            );
        }

        const originalName = safeOriginalFilename(file.name);
        const extension = originalName.includes('.')
            ? originalName.slice(originalName.lastIndexOf('.')).toLowerCase()
            : '';
        const suppliedType = String(file.type || '').toLowerCase();
        const rawBytes = new Uint8Array(await file.arrayBuffer());

        if (extension === '.png' && ['', 'image/png'].includes(suppliedType)) {
            prepared.push({
                originalName,
                filename: `attachment-${String(index + 1).padStart(2, '0')}.png`,
                type: 'image/png',
                bytes: sanitizePng(rawBytes),
            });
            continue;
        }

        if (['.jpg', '.jpeg'].includes(extension) && ['', 'image/jpeg'].includes(suppliedType)) {
            prepared.push({
                originalName,
                filename: `attachment-${String(index + 1).padStart(2, '0')}.jpg`,
                type: 'image/jpeg',
                bytes: sanitizeJpeg(rawBytes),
            });
            continue;
        }

        if (['.txt', '.log'].includes(extension) && ['', 'text/plain', 'application/octet-stream'].includes(suppliedType)) {
            prepared.push({
                originalName,
                filename: `attachment-${String(index + 1).padStart(2, '0')}.txt`,
                type: 'text/plain; charset=utf-8',
                bytes: sanitizePlainText(rawBytes),
            });
            continue;
        }

        throw new ContactError(
            400,
            '添付できるのはPNG・JPEG・TXT・LOGファイルのみです。',
            'unsupported_file_type',
        );
    }

    return prepared;
}

function safeOriginalFilename(rawName) {
    const name = normalizeText(rawName)
        .replace(/[\\/\u0000-\u001f\u007f]/gu, '_')
        .trim()
        .slice(0, 100);
    return name || 'unnamed';
}

function sanitizePlainText(bytes) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new ContactError(
            400,
            'テキストファイルはUTF-8形式で保存してください。',
            'invalid_text_encoding',
        );
    }

    text = normalizeText(text);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
        throw new ContactError(
            400,
            'テキストファイルに使用できない制御文字が含まれています。',
            'unsafe_text_file',
        );
    }

    // 拡張子・MIMEタイプを強制的にtext/plainへ固定し、コードが実行されない形にします。
    return new TextEncoder().encode(text);
}

function sanitizePng(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value)) {
        throw unsafeImageError();
    }

    const keptChunks = [bytes.slice(0, 8)];
    const allowedCriticalChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    const retainedChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
    let offset = 8;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;

    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) throw unsafeImageError();
        const dataLength = readUint32(bytes, offset);
        const chunkEnd = offset + 12 + dataLength;
        if (dataLength > MAX_FILE_BYTES || chunkEnd > bytes.length) throw unsafeImageError();

        const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
        if (!/^[A-Za-z]{4}$/u.test(type)) throw unsafeImageError();

        const expectedCrc = readUint32(bytes, chunkEnd - 4);
        const actualCrc = crc32(bytes.slice(offset + 4, chunkEnd - 4));
        if (expectedCrc !== actualCrc) throw unsafeImageError();

        if (!sawHeader) {
            if (type !== 'IHDR' || dataLength !== 13) throw unsafeImageError();
            const width = readUint32(bytes, offset + 8);
            const height = readUint32(bytes, offset + 12);
            assertSafeImageDimensions(width, height);
            sawHeader = true;
        } else if (type === 'IHDR') {
            throw unsafeImageError();
        }

        const isCritical = type[0] === type[0].toUpperCase();
        if (isCritical && !allowedCriticalChunks.has(type)) throw unsafeImageError();
        if (type === 'PLTE' && (dataLength === 0 || dataLength > 768 || dataLength % 3 !== 0)) {
            throw unsafeImageError();
        }
        if (type === 'tRNS' && dataLength > 256) throw unsafeImageError();
        if (type === 'IDAT') sawImageData = true;

        if (retainedChunks.has(type)) keptChunks.push(bytes.slice(offset, chunkEnd));
        offset = chunkEnd;

        if (type === 'IEND') {
            if (dataLength !== 0 || offset !== bytes.length) throw unsafeImageError();
            sawEnd = true;
            break;
        }
    }

    if (!sawHeader || !sawImageData || !sawEnd) throw unsafeImageError();
    return concatBytes(keptChunks);
}

function sanitizeJpeg(bytes) {
    if (
        bytes.length < 16
        || bytes[0] !== 0xff
        || bytes[1] !== 0xd8
        || bytes[bytes.length - 2] !== 0xff
        || bytes[bytes.length - 1] !== 0xd9
    ) {
        throw unsafeImageError();
    }

    const output = [bytes.slice(0, 2)];
    const startOfFrameMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);
    const allowedSegmentMarkers = new Set([
        ...startOfFrameMarkers,
        0xc4, // Huffman table
        0xcc, // Arithmetic coding table
        0xda, // Start of scan
        0xdb, // Quantization table
        0xdc, // Number of lines
        0xdd, // Restart interval
    ]);
    let offset = 2;
    let sawFrame = false;
    let sawScan = false;
    let sawEnd = false;

    while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) throw unsafeImageError();
        const markerStart = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) throw unsafeImageError();

        const marker = bytes[offset];
        offset += 1;

        if (marker === 0xd9) {
            if (offset !== bytes.length) throw unsafeImageError();
            output.push(Uint8Array.of(0xff, 0xd9));
            sawEnd = true;
            break;
        }

        if (marker === 0xd8 || marker === 0x00) throw unsafeImageError();
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            output.push(bytes.slice(markerStart, offset));
            continue;
        }

        if (offset + 2 > bytes.length) throw unsafeImageError();
        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
        const segmentEnd = offset + segmentLength;
        if (segmentLength < 2 || segmentEnd > bytes.length) throw unsafeImageError();

        if (startOfFrameMarkers.has(marker)) {
            if (segmentLength < 11) throw unsafeImageError();
            const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
            const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
            assertSafeImageDimensions(width, height);
            sawFrame = true;
        }

        const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
        if (!isMetadata && !allowedSegmentMarkers.has(marker)) throw unsafeImageError();

        if (marker === 0xda) {
            sawScan = true;
            output.push(bytes.slice(markerStart, segmentEnd));

            const nextMarker = findNextJpegMarker(bytes, segmentEnd);
            if (nextMarker < 0) throw unsafeImageError();
            output.push(bytes.slice(segmentEnd, nextMarker));
            offset = nextMarker;
            continue;
        }

        if (!isMetadata) output.push(bytes.slice(markerStart, segmentEnd));
        offset = segmentEnd;
    }

    if (!sawFrame || !sawScan || !sawEnd) throw unsafeImageError();
    return concatBytes(output);
}

function findNextJpegMarker(bytes, start) {
    let offset = start;
    while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.length) return -1;

        const marker = bytes[markerOffset];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset = markerOffset + 1;
            continue;
        }
        return offset;
    }
    return -1;
}

function assertSafeImageDimensions(width, height) {
    if (
        !Number.isInteger(width)
        || !Number.isInteger(height)
        || width < 1
        || height < 1
        || width > 10_000
        || height > 10_000
        || width * height > MAX_IMAGE_PIXELS
    ) {
        throw unsafeImageError();
    }
}

function unsafeImageError() {
    return new ContactError(
        400,
        '画像ファイルが壊れているか、安全に処理できない形式です。',
        'unsafe_image',
    );
}

function readUint32(bytes, offset) {
    return (
        ((bytes[offset] << 24) >>> 0)
        | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8)
        | bytes[offset + 3]
    ) >>> 0;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
    const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function createReference() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const random = crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    return `CONTACT-${date}-${random}`;
}

function cleanConfigValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

export const __test = Object.freeze({
    prepareAttachments,
    sanitizeJpeg,
    sanitizePlainText,
    sanitizePng,
    validateMessage,
});
