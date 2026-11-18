// Paid image delivery rules (snapshot schemaVersion 4): hires-radar / tsunami-map / weather-map / earthquake-map.
// The home server (dpi_code Di/supporter_image_rules.py) re-validates every field and
// re-checks Pro-only options against `tier`; these definitions must stay in sync with it.
import { PREFECTURES } from './supporter-geo.js';
import { hasFeature } from '../site/supporter/plan-features.js';

export const IMAGE_RULE_TYPES = Object.freeze(['hires-radar', 'tsunami-map', 'weather-map', 'earthquake-map']);
export const IMAGE_RULE_TYPE_SET = new Set(IMAGE_RULE_TYPES);
export const IMAGE_RULE_TYPE_OPTIONS = Object.freeze([
 ['hires-radar', '雨雲レーダー（高解像度版）'],
 ['tsunami-map', '津波警報・注意報（図・表）'],
 ['weather-map', '気象警報（図）'],
 ['earthquake-map', '地震情報（図）'],
]);
export const IMAGE_REGION_IDS = Object.freeze(['all', 'hokkaido', 'tohoku', 'kanto-koshin', 'hokuriku', 'tokai', 'kinki', 'chugoku', 'shikoku', 'kyushu-north', 'kyushu-south-amami', 'okinawa']);
export const HIRES_RADAR_CONDITIONS = Object.freeze([
 ['scheduled', '定時配信'],
 ['rainfall-threshold', '1時間降水量が閾値以上'],
]);
export const HIRES_RADAR_THRESHOLDS = Object.freeze([10, 20, 30, 50, 80].map(value => [String(value), `${value}mm/h以上`]));
export const HIRES_RADAR_INTERVALS = Object.freeze([1, 2, 3, 6, 12, 24].map(value => [String(value), `${value}時間ごと`]));
export const WEATHER_MAP_PRODUCTS = Object.freeze([
 ['VPWW55', '大雨'],
 ['VPWW56', '土砂災害'],
 ['VPWW57', '高潮'],
 ['VPWW58', '暴風雪・暴風'],
 ['VPWW59', '波浪'],
 ['VPWW60', '大雪'],
 // Opt-in extras (Plus+): never part of the default selection. VPWW61 is delivered as a
 // table; VPHW50 (VPHW51 sightings included) and VPBS50 are delivered as maps.
 ['VPWW61', 'その他注意報（一覧表）'],
 ['VPHW50', '竜巻注意情報（気象防災速報）'],
 ['VPBS50', '線状降水帯（発生・直前予測）'],
]);
// Initial selection for a new weather-map rule: the VPWW55..VPWW60 warning maps only.
export const WEATHER_MAP_DEFAULT_PRODUCTS = Object.freeze(['VPWW55', 'VPWW56', 'VPWW57', 'VPWW58', 'VPWW59', 'VPWW60']);
export const WEATHER_MAP_SEVERITIES = Object.freeze([
 ['warning', '警報以上'],
 ['advisory', '注意報以上'],
]);
export const MAX_WEATHER_MUNICIPALITIES = 50;
// earthquake-map (地震情報の図). Plus+: every earthquake info of the selected kinds.
// Pro+ (feature earthquakeMapFilter): national / per-region intensity thresholds and the
// municipality at the map centre. Intensity ids are exactly what the home server parses
// (Di/supporter_image_rules.py EARTHQUAKE_INTENSITIES: "5-" = 5弱, "5+" = 5強 ...).
export const EARTHQUAKE_MAP_PRODUCTS = Object.freeze([
 ['VXSE51', '震度速報'],
 ['VXSE52', '震源に関する情報'],
 ['VXSE53', '震源・震度に関する情報（各地の震度）'],
 ['VXSE62', '長周期地震動に関する観測情報'],
]);
// Pro: 長周期地震動階級のしきい値（VXSE62 だけに効き、震度のしきい値と OR）。Di/supporter_image_rules.py minLgInt と同じ値。
export const EARTHQUAKE_MAP_LG_CLASSES = Object.freeze([
 ['1', '長周期地震動階級1以上'], ['2', '長周期地震動階級2以上'], ['3', '長周期地震動階級3以上'], ['4', '長周期地震動階級4'],
]);
export const EARTHQUAKE_MAP_INTENSITIES = Object.freeze([
 ['1', '震度1以上'], ['2', '震度2以上'], ['3', '震度3以上'], ['4', '震度4以上'],
 ['5-', '震度5弱以上'], ['5+', '震度5強以上'], ['6-', '震度6弱以上'], ['6+', '震度6強以上'], ['7', '震度7'],
]);
// Region thresholds use the image region ids except "all" (the national threshold is minIntensity).
export const EARTHQUAKE_MAP_REGION_IDS = Object.freeze(IMAGE_REGION_IDS.filter(id => id !== 'all'));
// Static list of the 7-digit 市町村等 codes accepted as centerMunicipality (built by
// scripts/build-earthquake-municipalities.mjs from dpi_code Di/jma_earthquake_areas.json).
export const EARTHQUAKE_MUNICIPALITIES_PATH = '/site/supporter/earthquake-municipalities.json';

const REGIONS = new Set(IMAGE_REGION_IDS);
const THRESHOLDS = new Set(HIRES_RADAR_THRESHOLDS.map(([id]) => Number(id)));
const INTERVALS = new Set(HIRES_RADAR_INTERVALS.map(([id]) => Number(id)));
const PRODUCTS = WEATHER_MAP_PRODUCTS.map(([id]) => id);
const PRODUCT_SET = new Set(PRODUCTS);
const SEVERITIES = new Set(WEATHER_MAP_SEVERITIES.map(([id]) => id));
const EQ_PRODUCTS = EARTHQUAKE_MAP_PRODUCTS.map(([id]) => id);
const EQ_PRODUCT_SET = new Set(EQ_PRODUCTS);
const EQ_INTENSITY_SET = new Set(EARTHQUAKE_MAP_INTENSITIES.map(([id]) => id));
const EQ_REGION_SET = new Set(EARTHQUAKE_MAP_REGION_IDS);
const EQ_LG_SET = new Set(EARTHQUAKE_MAP_LG_CLASSES.map(([id]) => id));
const reject = message => { throw Object.assign(new Error(message), {status: 400}); };
const clean = value => typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');

// Default off: the paid image rules must stay hidden until every home server and the
// AWS Lambda understand schemaVersion 4 (old home servers reject the whole snapshot).
export function imageRulesEnabled(env) {
 return clean(env?.SUPPORTER_IMAGE_RULES_ENABLED) === '1';
}

export function isImageRuleType(type) {
 return IMAGE_RULE_TYPE_SET.has(clean(type));
}

export function imageRuleOptions() {
 return {
  imageRuleTypes: IMAGE_RULE_TYPE_OPTIONS,
  imageRegions: IMAGE_REGION_IDS,
  hiresRadarConditions: HIRES_RADAR_CONDITIONS,
  hiresRadarThresholds: HIRES_RADAR_THRESHOLDS,
  hiresRadarIntervals: HIRES_RADAR_INTERVALS,
  weatherMapProducts: WEATHER_MAP_PRODUCTS,
  weatherMapDefaultProducts: WEATHER_MAP_DEFAULT_PRODUCTS,
  weatherMapSeverities: WEATHER_MAP_SEVERITIES,
  maxWeatherMunicipalities: MAX_WEATHER_MUNICIPALITIES,
  earthquakeMapProducts: EARTHQUAKE_MAP_PRODUCTS,
  earthquakeMapIntensities: EARTHQUAKE_MAP_INTENSITIES,
  earthquakeMapLgClasses: EARTHQUAKE_MAP_LG_CLASSES,
  earthquakeMapRegions: EARTHQUAKE_MAP_REGION_IDS,
  earthquakeMunicipalitiesPath: EARTHQUAKE_MUNICIPALITIES_PATH,
 };
}

let earthquakeCache = null;
// Parse the static municipality list into Map(code -> {name, prefectureCode}).
export function parseEarthquakeMunicipalities(data) {
 const codes = new Map();
 for (const [prefectureCode, list] of Object.entries(data?.prefectures || {})) {
  if (!/^\d{2}$/.test(prefectureCode) || !Array.isArray(list)) continue;
  for (const entry of list) {
   const [code, name] = Array.isArray(entry) ? entry : [];
   if (typeof code === 'string' && /^\d{7}$/.test(code) && code.startsWith(prefectureCode) && typeof name === 'string') codes.set(code, {name, prefectureCode});
  }
 }
 if (codes.size < 1000) throw Object.assign(new Error('地震情報の市区町村一覧を確認できません。時間をおいて再試行してください。'), {status: 503});
 return codes;
}

// Loaded from the static asset only when a rule names a centre municipality (fail closed).
export async function loadEarthquakeMunicipalities(env, requestUrl) {
 if (earthquakeCache) return earthquakeCache;
 let data;
 try {
  const response = await env.ASSETS.fetch(new Request(new URL(EARTHQUAKE_MUNICIPALITIES_PATH, requestUrl)));
  if (!response.ok) throw new Error('unavailable');
  data = await response.json();
 } catch { throw Object.assign(new Error('地震情報の市区町村一覧を取得できません。時間をおいて再試行してください。'), {status: 503}); }
 earthquakeCache = parseEarthquakeMunicipalities(data);
 return earthquakeCache;
}

function earthquakeIntensity(value, message) {
 const text = clean(value);
 if (!text || text === 'all') return null;
 if (!EQ_INTENSITY_SET.has(text)) reject(message);
 return text;
}

// earthquake-map fields. `region` is not used by the home server for this type; it is fixed to "all".
function normalizeEarthquakeMapFields(rule, limits, catalogue) {
 let products = [...EQ_PRODUCTS];
 if (rule?.products !== undefined && rule?.products !== null) {
  const requested = Array.isArray(rule.products) ? rule.products.map(clean) : [];
  if (!requested.length || requested.some(id => !EQ_PRODUCT_SET.has(id))) reject('地震情報（図）で送る情報の種類を1つ以上選択してください。');
  products = EQ_PRODUCTS.filter(id => requested.includes(id));
 }
 const minIntensity = earthquakeIntensity(rule?.minIntensity, '地震情報（図）の震度のしきい値を確認してください。');
 const rawRegions = rule?.regionMinIntensity ?? {};
 if (!rawRegions || typeof rawRegions !== 'object' || Array.isArray(rawRegions)) reject('地震情報（図）の地方別の震度しきい値を確認してください。');
 const regionMinIntensity = {};
 for (const [region, value] of Object.entries(rawRegions)) {
  if (!EQ_REGION_SET.has(region)) reject('地震情報（図）の地方別の震度しきい値を確認してください。');
  const threshold = earthquakeIntensity(value, '地震情報（図）の地方別の震度しきい値を確認してください。');
  if (threshold) regionMinIntensity[region] = threshold;
 }
 const ordered = Object.fromEntries(EARTHQUAKE_MAP_REGION_IDS.filter(id => id in regionMinIntensity).map(id => [id, regionMinIntensity[id]]));
 const lgText = clean(rule?.minLgInt);
 const minLgInt = lgText && lgText !== 'all' ? lgText : null;
 if (minLgInt && !EQ_LG_SET.has(minLgInt)) reject('地震情報（図）の長周期地震動階級のしきい値を確認してください。');
 const centerText = clean(rule?.centerMunicipality);
 const centerMunicipality = centerText && centerText !== 'all' ? centerText : null;
 if ((minIntensity || Object.keys(ordered).length || minLgInt || centerMunicipality) && !hasFeature(limits, 'earthquakeMapFilter'))
  reject('地震情報（図）の震度・長周期地震動階級のしきい値・地方別のしきい値・地図の中心にする市区町村はPro以上のプランで利用できます。');
 if (centerMunicipality) {
  const known = catalogue?.earthquakeMunicipalities;
  if (!/^\d{7}$/.test(centerMunicipality) || !(known instanceof Map) || !known.has(centerMunicipality))
   reject('地図の中心にする市区町村を一覧から選び直してください。');
 }
 return {region: 'all', products, minIntensity, regionMinIntensity: ordered, minLgInt, centerMunicipality};
}

function bool(value, fallback = false) {
 if (value === undefined || value === null || value === '') return fallback;
 if (value === true || value === false) return value;
 reject('画像配信ルールのON/OFF設定を確認してください。');
}

// Validate the type-specific fields of an image rule against the account's features.
// `limits` carries the plan features (planFeatures()) merged into supporterLimits().
export function normalizeImageRuleFields(rule, type, limits = {}, catalogue = null) {
 if (!hasFeature(limits, 'imageDelivery')) reject('画像配信ルールはPlus以上のプランで利用できます。');
 if (type === 'earthquake-map') return normalizeEarthquakeMapFields(rule, limits, catalogue);
 const region = clean(rule?.region) || 'all';
 if (!REGIONS.has(region)) reject('画像配信の対象地方を確認してください。');
 if (type === 'hires-radar') {
  const radarCondition = clean(rule?.radarCondition) || 'scheduled';
  if (!['scheduled', 'rainfall-threshold'].includes(radarCondition)) reject('雨雲レーダー（高解像度版）の配信条件を確認してください。');
  if (radarCondition === 'rainfall-threshold' && !hasFeature(limits, 'hiresRadarThreshold')) reject('雨雲レーダー（高解像度版）の閾値配信はPro以上のプランで利用できます。');
  const intervalText = clean(rule?.deliveryIntervalHours) || '1';
  const deliveryIntervalHours = Number(intervalText);
  if (!/^\d+$/.test(intervalText) || !INTERVALS.has(deliveryIntervalHours)) reject('雨雲レーダー（高解像度版）の配信頻度を確認してください。');
  let rainfallThresholdMmPerHour = null;
  if (radarCondition === 'rainfall-threshold') {
   const thresholdText = clean(rule?.rainfallThresholdMmPerHour);
   rainfallThresholdMmPerHour = Number(thresholdText);
   if (!/^\d+$/.test(thresholdText) || !THRESHOLDS.has(rainfallThresholdMmPerHour)) reject('1時間降水量の閾値は10・20・30・50・80mm/hから選択してください。');
  }
  return {region, linearRainband: bool(rule?.linearRainband), radarCondition, rainfallThresholdMmPerHour, deliveryIntervalHours};
 }
 if (type === 'tsunami-map') {
  const enlargedArea = bool(rule?.enlargedArea);
  if (enlargedArea && !hasFeature(limits, 'tsunamiEnlarged')) reject('津波の発表地域拡大版はPro以上のプランで利用できます。');
  return {region, includeTables: bool(rule?.includeTables, true), enlargedArea};
 }
 if (type !== 'weather-map') reject('情報種別を確認してください。');
 const requested = Array.isArray(rule?.products) ? rule.products.map(clean) : [];
 if (!requested.length || requested.some(id => !PRODUCT_SET.has(id))) reject('気象警報（図）の対象を1つ以上選択してください。');
 const products = PRODUCTS.filter(id => requested.includes(id));
 const minSeverity = clean(rule?.minSeverity) || 'warning';
 if (!SEVERITIES.has(minSeverity)) reject('気象警報（図）の配信基準を確認してください。');
 const prefectureText = clean(rule?.prefecture);
 const prefecture = prefectureText && prefectureText !== 'all' ? prefectureText : null;
 const municipalities = [...new Set((Array.isArray(rule?.municipalities) ? rule.municipalities : []).map(clean).filter(Boolean))];
 const municipalityDetail = bool(rule?.municipalityDetail);
 if ((prefecture || municipalities.length || municipalityDetail) && !hasFeature(limits, 'weatherMunicipality'))
  reject('気象警報（図）の都道府県・市区町村の指定と市区町村の詳細はPro以上のプランで利用できます。');
 if (prefecture) {
  const pref = PREFECTURES.find(item => item.code === prefecture);
  if (!pref || (region !== 'all' && pref.region !== region)) reject('気象警報（図）の都道府県と対象地方を確認してください。');
 }
 if (municipalities.length) {
  if (!prefecture) reject('市区町村を指定する場合は都道府県を選択してください。');
  if (municipalities.length > MAX_WEATHER_MUNICIPALITIES) reject(`市区町村は${MAX_WEATHER_MUNICIPALITIES}件まで指定できます。`);
  const known = new Map((catalogue?.municipalities || []).map(item => [item.code, item]));
  if (municipalities.some(code => !/^\d{7}$/.test(code) || known.get(code)?.prefectureCode !== prefecture))
   reject('市区町村の気象庁コードと都道府県を確認してください。');
 }
 return {region, products, minSeverity, prefecture, municipalities, municipalityDetail};
}

// Fields sent in the delivery snapshot, or null when the rule must be suspended
// because the current contract no longer covers it. Never silently widen a paid
// filter (threshold / prefecture / municipalities); purely additive extras
// (enlarged tsunami map, municipality detail) are dropped instead.
export function imageRuleSnapshotFields(rule, features, tier) {
 const type = clean(rule?.type);
 if (!IMAGE_RULE_TYPE_SET.has(type) || !tier || !hasFeature(features, 'imageDelivery')) return null;
 if (type === 'earthquake-map') return earthquakeMapSnapshotFields(rule, features, tier);
 const region = REGIONS.has(clean(rule?.region)) ? clean(rule.region) : null;
 if (!region) return null;
 if (type === 'hires-radar') {
  const threshold = rule?.radarCondition === 'rainfall-threshold';
  if (threshold && !hasFeature(features, 'hiresRadarThreshold')) return null;
  return {
   region, tier, linearRainband: rule?.linearRainband === true,
   radarCondition: threshold ? 'rainfall-threshold' : 'scheduled',
   ...(threshold ? {rainfallThresholdMmPerHour: Number(rule?.rainfallThresholdMmPerHour)} : {}),
   deliveryIntervalHours: Number(rule?.deliveryIntervalHours) || 1,
  };
 }
 if (type === 'tsunami-map') {
  return {region, tier, includeTables: rule?.includeTables !== false, enlargedArea: rule?.enlargedArea === true && hasFeature(features, 'tsunamiEnlarged')};
 }
 const prefecture = clean(rule?.prefecture);
 const municipalities = Array.isArray(rule?.municipalities) ? rule.municipalities.map(clean).filter(Boolean) : [];
 const scoped = (prefecture && prefecture !== 'all') || municipalities.length > 0;
 const municipalityAllowed = hasFeature(features, 'weatherMunicipality');
 if (scoped && !municipalityAllowed) return null;
 const products = Array.isArray(rule?.products) ? rule.products.filter(id => PRODUCT_SET.has(id)) : [];
 // The home server treats an empty list as "all products"; never send that by accident.
 if (!products.length) return null;
 return {
  region, tier, products,
  minSeverity: SEVERITIES.has(rule?.minSeverity) ? rule.minSeverity : 'warning',
  ...(scoped ? {prefecture, municipalities} : {}),
  municipalityDetail: rule?.municipalityDetail === true && municipalityAllowed,
 };
}

// earthquake-map snapshot fields. Pro-only keys are emitted only when set and only for a
// Pro/custom account: the home server drops a Plus rule that carries any of them.
// Thresholds narrow the delivery, so a downgraded rule with thresholds is suspended (never
// widened to "every earthquake"); the centre municipality only changes the framing and is dropped.
function earthquakeMapSnapshotFields(rule, features, tier) {
 const products = Array.isArray(rule?.products) ? EQ_PRODUCTS.filter(id => rule.products.includes(id)) : [...EQ_PRODUCTS];
 // The home server treats an empty list as "all products"; never send that by accident.
 if (!products.length) return null;
 const minText = clean(rule?.minIntensity);
 const minIntensity = minText && minText !== 'all' ? minText : null;
 if (minIntensity && !EQ_INTENSITY_SET.has(minIntensity)) return null;
 const rawRegions = rule?.regionMinIntensity && typeof rule.regionMinIntensity === 'object' && !Array.isArray(rule.regionMinIntensity) ? rule.regionMinIntensity : {};
 const regionMinIntensity = {};
 for (const [region, value] of Object.entries(rawRegions)) {
  const threshold = clean(value);
  if (!threshold || threshold === 'all') continue;
  if (!EQ_REGION_SET.has(region) || !EQ_INTENSITY_SET.has(threshold)) return null;
  regionMinIntensity[region] = threshold;
 }
 const regions = EARTHQUAKE_MAP_REGION_IDS.filter(id => id in regionMinIntensity);
 const lgText = clean(rule?.minLgInt);
 const minLgInt = lgText && lgText !== 'all' ? lgText : null;
 if (minLgInt && !EQ_LG_SET.has(minLgInt)) return null;
 const pro = hasFeature(features, 'earthquakeMapFilter') && (tier === 'pro' || tier === 'custom');
 if ((minIntensity || regions.length || minLgInt) && !pro) return null;
 const centre = clean(rule?.centerMunicipality);
 const centerMunicipality = pro && /^\d{7}$/.test(centre) ? centre : null;
 return {
  region: 'all', tier, products,
  ...(minIntensity ? {minIntensity} : {}),
  ...(regions.length ? {regionMinIntensity: Object.fromEntries(regions.map(id => [id, regionMinIntensity[id]]))} : {}),
  ...(minLgInt ? {minLgInt} : {}),
  ...(centerMunicipality ? {centerMunicipality} : {}),
 };
}
