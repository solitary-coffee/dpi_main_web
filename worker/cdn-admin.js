// 有料画像CDN（R2 / S3 + CloudFront）の管理画面API。
// Bot（dpi_code の Di/supporter_image_cdn_stats.py）が1時間ごとに R2 バケット dpi-image-cdn の
// 非公開 R2 バケット dpi-image-cdn-meta の admin-stats.json へ保存した集計と、アップロードWorkerのCronが6時間ごとに
// 保存する usage.json を、R2 バインディング IMAGE_CDN_META から読み取り専用で返す（書き込み・一覧・削除はしない）。
// 画像の公開バケット（dpi-image-cdn）はバインドしない。
// 認証は admin-center.js（Cloudflare Access + ADMIN_EMAILS）で済ませてから呼ぶこと。

const STATS_KEY = 'admin-stats.json';
const USAGE_KEY = 'usage.json';
const MAX_OBJECT_BYTES = 2 * 1024 * 1024;

export class CdnAdminError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.publicMessage = message;
        this.code = code;
    }
}

export async function cdnAdminStats(env, admin) {
    const bucket = env.IMAGE_CDN_META;
    if (!bucket || typeof bucket.get !== 'function') {
        throw new CdnAdminError(503, '画像CDNのメタデータ用R2バインディング（IMAGE_CDN_META）が設定されていません。', 'image_cdn_not_configured');
    }
    const [stats, usage] = await Promise.all([readJsonObject(bucket, STATS_KEY), readJsonObject(bucket, USAGE_KEY)]);
    return {
        success: true,
        admin: admin?.email || '',
        fetchedAt: new Date().toISOString(),
        stats: stats.value,
        statsSavedAt: stats.savedAt,
        statsError: stats.error,
        usage: usage.value,
        usageSavedAt: usage.savedAt,
        usageError: usage.error,
    };
}

async function readJsonObject(bucket, key) {
    let object;
    try {
        object = await bucket.get(key);
    } catch {
        return { value: null, savedAt: null, error: 'R2から読み取れませんでした。' };
    }
    if (!object) return { value: null, savedAt: null, error: null };
    const savedAt = object.uploaded ? new Date(object.uploaded).toISOString() : null;
    if (Number(object.size) > MAX_OBJECT_BYTES) return { value: null, savedAt, error: '集計ファイルが大きすぎます。' };
    try {
        const value = JSON.parse(await object.text());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
        return { value, savedAt, error: null };
    } catch {
        return { value: null, savedAt, error: '集計ファイルを解析できませんでした。' };
    }
}

export const __test = Object.freeze({ STATS_KEY, USAGE_KEY, MAX_OBJECT_BYTES });
