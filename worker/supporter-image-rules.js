// Paid image delivery rules (snapshot schemaVersion 4): hires-radar / tsunami-map / weather-map /
// earthquake-map / eew-map / warning-table.
// The home server (dpi_code Di/supporter_image_rules.py) re-validates every field and re-checks
// the paid options against `features` (sorted feature names of the owner, see plan-features.js)
// or, on an older home server, against `tier`; these definitions must stay in sync with it.
import { PREFECTURES } from './supporter-geo.js';
import { hasFeature, imageTypeAllowed, featureList } from '../site/supporter/plan-features.js';

export const IMAGE_RULE_TYPES = Object.freeze(['hires-radar', 'tsunami-map', 'weather-map', 'earthquake-map', 'eew-map', 'warning-table']);
export const IMAGE_RULE_TYPE_SET = new Set(IMAGE_RULE_TYPES);
// Types that need a home server and AWS Lambda that know them (SUPPORTER_IMAGE_RULES_V2_ENABLED).
export const IMAGE_RULE_TYPES_V2 = Object.freeze(['eew-map', 'warning-table']);
const V2_TYPE_SET = new Set(IMAGE_RULE_TYPES_V2);
export const IMAGE_RULE_TYPE_OPTIONS = Object.freeze([
 ['hires-radar', '雨雲レーダー（高解像度版）'],
 ['tsunami-map', '津波警報・注意報・津波観測（地図・表）'],
 ['weather-map', '気象警報（図）'],
 ['earthquake-map', '地震情報（図）'],
 ['eew-map', '緊急地震速報（警報）の図'],
 ['warning-table', '警報・注意報の表'],
]);
// tsunami-map outputs: the map, the tables and the observations can go to different channels by separate rules.
export const TSUNAMI_MAP_OUTPUTS = Object.freeze([['map', '地図'], ['table', '表（満潮時刻を含む）'], ['observation', '津波観測の表（沖合・沿岸）']]);
// warning-table: national / regional = VPWS50（集約通報）, timeseries = VPWP50（時系列）.
export const WARNING_TABLE_KINDS = Object.freeze([
 ['national', '全国の表'],
 ['regional', '地方の表'],
 ['timeseries', '時系列の表'],
]);
export const WARNING_TABLE_DELIVER_ON = Object.freeze([
 ['changed', '内容が変わったときだけ'],
 ['every', '発表のたびに毎回'],
]);
const WARNING_TABLE_FEATURE = Object.freeze({national: 'warningTableNational', regional: 'warningTableRegional', timeseries: 'warningTableTimeseries'});
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
// Legacy hidden option: VXSE43（緊急地震速報（警報））inside earthquake-map. Never offered any more
// (use the eew-map type); kept valid so rules saved with it keep working (needs eewMap).
const EEW_WARNING_PRODUCT = 'VXSE43';
const EQ_PRODUCTS_WITH_LEGACY = [...EQ_PRODUCTS, EEW_WARNING_PRODUCT];
const EQ_PRODUCT_SET = new Set(EQ_PRODUCTS_WITH_LEGACY);
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

// Default off: eew-map / warning-table are offered and published only once every home server
// and the AWS Lambda validator know these types (an unknown type rejects the WHOLE snapshot).
export function imageRulesV2Enabled(env) {
 return clean(env?.SUPPORTER_IMAGE_RULES_V2_ENABLED) === '1';
}

export function isImageRuleType(type) {
 return IMAGE_RULE_TYPE_SET.has(clean(type));
}

export function isImageRuleV2Type(type) {
 return V2_TYPE_SET.has(clean(type));
}

export function imageRuleOptions(v2 = false) {
 return {
  imageRuleTypes: v2 ? IMAGE_RULE_TYPE_OPTIONS : IMAGE_RULE_TYPE_OPTIONS.filter(([id]) => !V2_TYPE_SET.has(id)),
  tsunamiMapOutputs: TSUNAMI_MAP_OUTPUTS,
  warningTableKinds: WARNING_TABLE_KINDS,
  warningTableDeliverOn: WARNING_TABLE_DELIVER_ON,
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
  products = EQ_PRODUCTS_WITH_LEGACY.filter(id => requested.includes(id));
  if (products.includes(EEW_WARNING_PRODUCT) && !hasFeature(limits, 'eewMap')) reject('緊急地震速報（警報）の図は「緊急地震速報（警報）の図」の配信ルールで設定してください。');
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

function regionList(value, message) {
 if (value === undefined || value === null) return [];
 if (!Array.isArray(value)) reject(message);
 const requested = value.map(clean).filter(id => id && id !== 'all');
 if (requested.some(id => !EQ_REGION_SET.has(id))) reject(message);
 return EARTHQUAKE_MAP_REGION_IDS.filter(id => requested.includes(id));
}

// eew-map: the same map image for every rule; `regions` only decides WHEN it is sent.
// [] = every 緊急地震速報（警報）(national, Basic+); regions = only when one of them becomes a
// target area (also when a later report adds it; Plus+ feature eewMapRegion).
function normalizeEewMapFields(rule, limits) {
 const regions = regionList(rule?.regions, '緊急地震速報（警報）の図の対象地方を確認してください。');
 if (regions.length && !hasFeature(limits, 'eewMapRegion')) reject('緊急地震速報（警報）の図で地方を選ぶ設定はPlus以上のプランで利用できます。');
 return {region: 'all', regions};
}

// warning-table: tables ⊆ national/regional/timeseries, regions for regional/timeseries,
// deliverOn changed (default) | every (Pro+), showAllAreas.
function normalizeWarningTableFields(rule, limits) {
 const requested = Array.isArray(rule?.tables) ? rule.tables.map(clean) : [];
 const kinds = WARNING_TABLE_KINDS.map(([id]) => id);
 if (!requested.length || requested.some(id => !kinds.includes(id))) reject('警報・注意報の表で送る表を1つ以上選択してください。');
 const tables = kinds.filter(id => requested.includes(id));
 for (const table of tables) {
  if (!hasFeature(limits, WARNING_TABLE_FEATURE[table])) reject(table === 'national' ? '警報・注意報の表（全国）はPlus以上のプランで利用できます。' : '警報・注意報の表の地方の表・時系列の表はPro以上のプランで利用できます。');
 }
 const needsRegions = tables.includes('regional') || tables.includes('timeseries');
 const regions = needsRegions ? regionList(rule?.regions, '警報・注意報の表の対象地方を確認してください。') : [];
 if (needsRegions && !regions.length) reject('地方の表・時系列の表を送る地方を1つ以上選択してください。');
 const deliverOn = clean(rule?.deliverOn) || 'changed';
 if (!WARNING_TABLE_DELIVER_ON.some(([id]) => id === deliverOn)) reject('警報・注意報の表の配信のタイミングを確認してください。');
 if (deliverOn === 'every' && !hasFeature(limits, 'warningTableEvery')) reject('警報・注意報の表を毎回配信する設定はPro以上のプランで利用できます。');
 return {region: 'all', tables, regions, deliverOn, showAllAreas: bool(rule?.showAllAreas)};
}

const TSUNAMI_OUTPUT_IDS = TSUNAMI_MAP_OUTPUTS.map(([id]) => id);

// What a rule sends. `tsunamiOutputs` is the current field; rules saved before it have `outputs`
// (["map"] / ["table"] / both; absent = both, legacy includeTables:false = map only), where the
// table always came with the observations.
export function savedTsunamiOutputs(rule) {
 if (Array.isArray(rule?.tsunamiOutputs)) return TSUNAMI_OUTPUT_IDS.filter(id => rule.tsunamiOutputs.map(clean).includes(id));
 const outputs = Array.isArray(rule?.outputs) ? rule.outputs.map(clean) : (rule?.includeTables === false ? ['map'] : ['map', 'table']);
 return TSUNAMI_OUTPUT_IDS.filter(id => outputs.includes(id === 'observation' ? 'table' : id));
}

// Fields stored in the rule and sent in the snapshot. `outputs` / `includeTables` stay for receivers that do
// not know tsunamiOutputs yet (an observation-only rule is a table rule there).
function tsunamiOutputFields(chosen) {
 const outputs = ['map', 'table'].filter(id => chosen.includes(id) || (id === 'table' && chosen.includes('observation')));
 return {tsunamiOutputs: chosen, outputs, includeTables: outputs.includes('table')};
}

function tsunamiOutputs(rule) {
 if (rule?.tsunamiOutputs !== undefined && rule?.tsunamiOutputs !== null) {
  const requested = Array.isArray(rule.tsunamiOutputs) ? rule.tsunamiOutputs.map(clean) : [];
  if (!requested.length || requested.some(id => !TSUNAMI_OUTPUT_IDS.includes(id))) reject('津波警報・注意報で送るもの（地図・表・津波観測の表）を1つ以上選択してください。');
  return TSUNAMI_OUTPUT_IDS.filter(id => requested.includes(id));
 }
 if (rule?.outputs !== undefined && rule?.outputs !== null) {
  const requested = Array.isArray(rule.outputs) ? rule.outputs.map(clean) : [];
  if (!requested.length || requested.some(id => !['map', 'table'].includes(id))) reject('津波警報・注意報で送るもの（地図・表・津波観測の表）を1つ以上選択してください。');
 }
 return savedTsunamiOutputs({...rule, includeTables: bool(rule?.includeTables, true)});
}

const TYPE_UPGRADE_MESSAGE = Object.freeze({
 'eew-map': '緊急地震速報（警報）の図は現在の契約では利用できません。',
 'warning-table': '警報・注意報の表はPlus以上のプランで利用できます。',
});

// Validate the type-specific fields of an image rule against the account's features.
// `limits` carries the plan features (planFeatures()) merged into supporterLimits().
export function normalizeImageRuleFields(rule, type, limits = {}, catalogue = null) {
 if (!IMAGE_RULE_TYPE_SET.has(type)) reject('情報種別を確認してください。');
 if (!imageTypeAllowed(limits, type)) reject(TYPE_UPGRADE_MESSAGE[type] || 'この画像配信ルールはPlus以上のプランで利用できます。');
 if (type === 'earthquake-map') return normalizeEarthquakeMapFields(rule, limits, catalogue);
 if (type === 'eew-map') return normalizeEewMapFields(rule, limits);
 if (type === 'warning-table') return normalizeWarningTableFields(rule, limits);
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
  const outputs = tsunamiOutputs(rule);
  // The enlarged images are maps: they are only attached to a rule that sends the map.
  const enlargedArea = bool(rule?.enlargedArea) && outputs.includes('map');
  if (enlargedArea && !hasFeature(limits, 'tsunamiEnlarged')) reject('津波の発表地域拡大版はPro以上のプランで利用できます。');
  return {region, ...tsunamiOutputFields(outputs), enlargedArea};
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
// Every returned object carries `tier` (older home servers) and `features` (the owner's sorted
// feature names; newer home servers check paid options against it instead of tier).
export function imageRuleSnapshotFields(rule, features, tier) {
 const fields = imageRuleSnapshotFieldsOnly(rule, features, tier);
 return fields ? {...fields, features: featureList(features)} : null;
}

function imageRuleSnapshotFieldsOnly(rule, features, tier) {
 const type = clean(rule?.type);
 if (!IMAGE_RULE_TYPE_SET.has(type) || !tier || !imageTypeAllowed(features, type)) return null;
 if (type === 'earthquake-map') return earthquakeMapSnapshotFields(rule, features, tier);
 if (type === 'eew-map') {
  const regions = Array.isArray(rule?.regions) ? rule.regions.map(clean).filter(id => id && id !== 'all') : [];
  if (regions.some(id => !EQ_REGION_SET.has(id))) return null;
  // Never widen a region-limited rule to every warning after a downgrade.
  if (regions.length && !hasFeature(features, 'eewMapRegion')) return null;
  return {region: 'all', tier, regions: EARTHQUAKE_MAP_REGION_IDS.filter(id => regions.includes(id))};
 }
 if (type === 'warning-table') return warningTableSnapshotFields(rule, features, tier);
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
  const outputs = savedTsunamiOutputs(rule);
  if (!outputs.length) return null;
  return {region, tier, ...tsunamiOutputFields(outputs), enlargedArea: rule?.enlargedArea === true && outputs.includes('map') && hasFeature(features, 'tsunamiEnlarged')};
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
// warning-table snapshot fields. Tables the contract no longer covers are dropped (fewer images,
// never wider); "every" falls back to "changed" (fewer deliveries) when warningTableEvery is gone.
function warningTableSnapshotFields(rule, features, tier) {
 const requested = Array.isArray(rule?.tables) ? rule.tables : [];
 const tables = WARNING_TABLE_KINDS.map(([id]) => id).filter(id => requested.includes(id) && hasFeature(features, WARNING_TABLE_FEATURE[id]));
 if (!tables.length) return null;
 const rawRegions = Array.isArray(rule?.regions) ? rule.regions.map(clean).filter(id => id && id !== 'all') : [];
 if (rawRegions.some(id => !EQ_REGION_SET.has(id))) return null;
 const needsRegions = tables.includes('regional') || tables.includes('timeseries');
 const regions = needsRegions ? EARTHQUAKE_MAP_REGION_IDS.filter(id => rawRegions.includes(id)) : [];
 if (needsRegions && !regions.length) return null;
 const deliverOn = rule?.deliverOn === 'every' && hasFeature(features, 'warningTableEvery') ? 'every' : 'changed';
 return {region: 'all', tier, tables, regions, deliverOn, showAllAreas: rule?.showAllAreas === true};
}

function earthquakeMapSnapshotFields(rule, features, tier) {
 const allowedProducts = hasFeature(features, 'eewMap') ? EQ_PRODUCTS_WITH_LEGACY : EQ_PRODUCTS;
 const products = Array.isArray(rule?.products) ? allowedProducts.filter(id => rule.products.includes(id)) : [...EQ_PRODUCTS];
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
