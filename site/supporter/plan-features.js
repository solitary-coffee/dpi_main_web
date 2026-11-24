// Single source of truth for paid-plan feature flags.
// Imported by the Worker (worker/supporter-billing.js, supporter-geo.js, supporter.js,
// supporter-custom.js, supporter-snapshot.js, supporter-image-rules.js), by the dashboard
// (site/supporter/app.js) and by the admin screen (site/supporter-admin/app.js), so the server
// checks and the client UI can never drift apart. Keep this file dependency-free.
export const ACTIVE_PLAN_STATUSES = Object.freeze(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
// Admin-issued custom contracts never grant access while past_due/unpaid.
const CUSTOM_ACTIVE_STATUSES = Object.freeze(['active', 'trialing']);
const PLAN_RANK = Object.freeze({supporter: 0, plus: 1, pro: 2});

// Every grantable feature. `plan` = the cheapest standard plan that includes it
// (supporter = Basic). `requires` = at least one of these must also be granted
// (a custom contract that breaks this is rejected by the admin API).
// `section` groups the admin checkboxes; labels are shown to administrators as is.
export const FEATURE_SECTIONS = Object.freeze([
 ['text', '文字の通知ルール'],
 ['eew-map', '緊急地震速報（警報）の図'],
 ['weather-map', '気象警報（図）'],
 ['warning-table', '警報・注意報の表'],
 ['hires-radar', '雨雲レーダー（高解像度版）'],
 ['tsunami-map', '津波警報・注意報・津波観測（地図・表）'],
 ['earthquake-map', '地震情報（図）'],
]);
export const FEATURE_DEFINITIONS = Object.freeze([
 // --- text rules (earthquake / eew / weather / rain-radar) ---
 {name: 'rainfallThreshold', section: 'text', plan: 'plus', label: '雨雲レーダー：1時間降水量の閾値指定'},
 {name: 'prefectureScope', section: 'text', plan: 'plus', label: '都道府県単位の指定'},
 {name: 'municipalityScope', section: 'text', plan: 'pro', label: '市区町村単位の指定', requires: ['prefectureScope']},
 {name: 'strictMunicipality', section: 'text', plan: 'pro', label: '指定した市区町村だけの本文抽出', requires: ['municipalityScope']},
 {name: 'complexConditions', section: 'text', plan: 'pro', label: 'AND・OR・追加条件'},
 {name: 'multiDestination', section: 'text', plan: 'pro', label: '1つのルールから複数チャンネルへ配信'},
 // --- eew-map: 緊急地震速報（警報）の図 (VXSE43) ---
 {name: 'eewMap', section: 'eew-map', plan: 'supporter', label: '全国：警報が発表されたら配信'},
 {name: 'eewMapRegion', section: 'eew-map', plan: 'plus', label: '地方を選んで、その地方が対象になったときだけ配信', requires: ['eewMap']},
 // --- weather-map: 気象警報の図 ---
 {name: 'weatherMap', section: 'weather-map', plan: 'plus', label: '全国・地方の選択'},
 {name: 'weatherMunicipality', section: 'weather-map', plan: 'pro', label: '都道府県・市区町村の指定と市区町村の詳細', requires: ['weatherMap']},
 // --- warning-table: 警報・注意報の表 (VPWS50 / VPWP50) ---
 {name: 'warningTableNational', section: 'warning-table', plan: 'plus', label: '全国の表'},
 {name: 'warningTableRegional', section: 'warning-table', plan: 'pro', label: '地方の表（地方を選ぶ）'},
 {name: 'warningTableTimeseries', section: 'warning-table', plan: 'pro', label: '時系列の表（地方を選ぶ・複数可）'},
 {name: 'warningTableEvery', section: 'warning-table', plan: 'pro', label: '発表のたびに毎回配信（「内容が変わったときだけ」はどの表でも利用可）', requires: ['warningTableNational', 'warningTableRegional', 'warningTableTimeseries']},
 // --- hires-radar: 雨雲レーダー（高解像度版） ---
 {name: 'hiresRadar', section: 'hires-radar', plan: 'plus', label: '全国・地方の選択・定時配信・線状降水帯の表示'},
 {name: 'hiresRadarThreshold', section: 'hires-radar', plan: 'pro', label: '閾値以上で配信（10・20・30・50・80mm/h）', requires: ['hiresRadar']},
 // --- tsunami-map: 津波警報・注意報の図・表 ---
 {name: 'tsunamiMapNational', section: 'tsunami-map', plan: 'supporter', label: '全国の地図だけ'},
 {name: 'tsunamiMap', section: 'tsunami-map', plan: 'plus', label: '全国・地方の選択（地図・表・津波観測の表）'},
 {name: 'tsunamiEnlarged', section: 'tsunami-map', plan: 'pro', label: '発表地域の拡大図', requires: ['tsunamiMap']},
 // --- earthquake-map: 地震情報の図 ---
 {name: 'earthquakeMap', section: 'earthquake-map', plan: 'plus', label: 'すべての地震情報（種類を選択）'},
 {name: 'earthquakeMapFilter', section: 'earthquake-map', plan: 'pro', label: '震度・長周期地震動階級のしきい値と地図の中心の指定', requires: ['earthquakeMap']},
].map(item => Object.freeze({...item, requires: Object.freeze(item.requires || [])})));

export const FEATURE_NAMES = Object.freeze(FEATURE_DEFINITIONS.map(item => item.name));
const FEATURE_SET = new Set(FEATURE_NAMES);
const DEFINITION = new Map(FEATURE_DEFINITIONS.map(item => [item.name, item]));

// Image rule type -> features that allow creating that type at all (any one is enough).
export const IMAGE_TYPE_FEATURES = Object.freeze({
 'eew-map': Object.freeze(['eewMap']),
 'hires-radar': Object.freeze(['hiresRadar']),
 'tsunami-map': Object.freeze(['tsunamiMap', 'tsunamiMapNational']),
 'weather-map': Object.freeze(['weatherMap']),
 'earthquake-map': Object.freeze(['earthquakeMap']),
 'warning-table': Object.freeze(['warningTableNational', 'warningTableRegional', 'warningTableTimeseries']),
});
const IMAGE_BASE_FEATURES = [...new Set(Object.values(IMAGE_TYPE_FEATURES).flat())];

export function sortFeatureNames(names) {
 return [...new Set((Array.isArray(names) ? names : []).filter(name => FEATURE_SET.has(name)))].sort();
}

// Feature names of a legacy custom contract (saved before per-contract feature flags existed):
// every image feature (custom used to match Pro) plus the rainfall threshold, and the text
// features its old columns allowed. migrations/0032 writes exactly this list into features_json.
export function legacyCustomFeatureNames(flags = {}) {
 const branching = flags.municipalityBranching === true;
 // tsunamiMapNational は tsunamiMap に含まれる（従来のカスタム契約の一覧 = migrations/0032 は変えない）
 const names = FEATURE_DEFINITIONS.filter(item => item.section !== 'text' && item.name !== 'tsunamiMapNational').map(item => item.name);
 names.push('rainfallThreshold');
 if (branching) names.push('prefectureScope', 'municipalityScope');
 if (branching && flags.contentExtraction === true) names.push('strictMunicipality');
 if (flags.complexConditions === true) names.push('complexConditions');
 if (flags.multiDestination === true) names.push('multiDestination');
 return sortFeatureNames(names);
}

// Adds the derived legacy flag `imageDelivery` (= at least one image rule type is available).
// It is kept so older call sites keep working; it is never a grantable feature by itself.
function withDerived(flags) {
 return Object.freeze({...flags, imageDelivery: IMAGE_BASE_FEATURES.some(name => flags[name] === true)});
}
const featureSet = enabled => withDerived(Object.fromEntries(FEATURE_NAMES.map(name => [name, enabled.includes(name)])));
const upTo = plan => FEATURE_DEFINITIONS.filter(item => PLAN_RANK[item.plan] <= PLAN_RANK[plan]).map(item => item.name);

export const NO_FEATURES = featureSet([]);
// Feature names per standard plan (also used by the admin presets).
export const PLAN_FEATURE_NAMES = Object.freeze({
 supporter: Object.freeze(upTo('supporter')),
 plus: Object.freeze(upTo('plus')),
 pro: Object.freeze(upTo('pro')),
});
export const PLAN_FEATURES = Object.freeze({
 supporter: featureSet(PLAN_FEATURE_NAMES.supporter),
 plus: featureSet(PLAN_FEATURE_NAMES.plus),
 pro: featureSet(PLAN_FEATURE_NAMES.pro),
 // Fallback for a custom contract without per-contract flags (legacy columns all off).
 custom: featureSet(legacyCustomFeatureNames({})),
});

// The first broken dependency in a list of feature names ({name, requires}), or null.
export function missingFeatureDependency(names) {
 const set = new Set(names);
 for (const name of FEATURE_NAMES) {
  if (!set.has(name)) continue;
  const requires = DEFINITION.get(name).requires;
  if (requires.length && !requires.some(item => set.has(item))) return {name, requires};
 }
 return null;
}

export function featureLabel(name) {
 const item = DEFINITION.get(name);
 if (!item) return name;
 const section = FEATURE_SECTIONS.find(([id]) => id === item.section)?.[1] || '';
 return `${section}：${item.label}`;
}

function isCustom(item) {
 return item?.managedCustom === true || item?.planId === 'custom';
}

// Per-contract feature names of a custom subscription summary (enrichCustomSubscriptions sets
// `customFeatures`); falls back to the legacy column flags for older data.
function customFeatureNames(item) {
 if (Array.isArray(item?.customFeatures)) return sortFeatureNames(item.customFeatures);
 return legacyCustomFeatureNames(item || {});
}

// Features granted by one subscription summary, or null when it grants nothing.
export function subscriptionFeatures(item) {
 if (!item || item.recognizedPlan === false || !ACTIVE_PLAN_STATUSES.includes(item.status)) return null;
 if (isCustom(item)) {
  if (!CUSTOM_ACTIVE_STATUSES.includes(item.status) || (item.managedCustom !== true && item.recognizedPlan !== true)) return null;
  return featureSet(customFeatureNames(item));
 }
 return PLAN_FEATURES[item.planId] || null;
}

// Union of the features of every active subscription of one account.
export function planFeatures(subscriptions = []) {
 const result = {...NO_FEATURES};
 for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
  const features = subscriptionFeatures(item);
  if (!features) continue;
  for (const name of FEATURE_NAMES) if (features[name] === true) result[name] = true;
 }
 return withDerived(result);
}

export function hasFeature(features, name) {
 return features?.[name] === true;
}

// Sorted names of the granted features (sent to the home server as `features` on image rules).
export function featureList(features) {
 return FEATURE_NAMES.filter(name => features?.[name] === true).sort();
}

// True when the features allow creating at least the basic form of an image rule type.
export function imageTypeAllowed(features, type) {
 return (IMAGE_TYPE_FEATURES[type] || []).some(name => features?.[name] === true);
}

// Best plan tier for image rules ("supporter" | "plus" | "pro" | "custom"), or '' when the
// account has no image delivery. Sent to the home server as `tier` (fallback for home servers
// that do not read `features` yet; "supporter" only ever accompanies an eew-map rule or a national tsunami-map rule).
export function imageTier(subscriptions = []) {
 const rank = {supporter: 1, plus: 2, pro: 3, custom: 4};
 let best = '';
 for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
  const features = subscriptionFeatures(item);
  if (!features?.imageDelivery) continue;
  const tier = isCustom(item) ? 'custom' : item.planId;
  if (rank[tier] && (!best || rank[tier] > rank[best])) best = tier;
 }
 return best;
}
