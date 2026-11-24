// 有料プランのデバッグ配信ルールを作る（開発用サーバーのチャンネル用の内部登録。何も送らない・保存しない）。
// プランと設定の組み合わせを、利用者の保存と同じ検証（normalizeSupporterRules）と配信データの生成
// （buildSupporterSnapshot）に通し、自宅の tools/supporter_test_channels.py が読む JSON を標準出力へ書く。
//   node scripts/build-test-rules.mjs > test-rules.json
// 同時に確かめること: 下のプランでは保存できない（または、その設定を使えない）・上のプランでも同じ設定を保存できる。
import { normalizeSupporterRules } from '../worker/supporter.js';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';
import { geographicEntitlements, PREFECTURES } from '../worker/supporter-geo.js';
import { planFeatures } from '../site/supporter/plan-features.js';
import { EARTHQUAKE_DETAILS, EEW_DETAILS, WEATHER_DETAILS } from '../worker/supporter.js';

const GUILD = '12345678901234567', ORDER = ['supporter', 'plus', 'pro'];
const PLAN_LABEL = {supporter: 'Basic', plus: 'Plus', pro: 'Pro', custom: 'カスタム'};
const ENV = {SUPPORTER_IMAGE_RULES_ENABLED: '1', SUPPORTER_IMAGE_RULES_V2_ENABLED: '1'};
const LIMITS = {supporter: {servers: 1, channels: 2, rules: 5}, plus: {servers: 3, channels: 10, rules: 15}, pro: {servers: 5, channels: 20, rules: 30}, custom: {servers: 5, channels: 20, rules: 30}};
const REGIONS = ['hokkaido', 'tohoku', 'kanto-koshin', 'hokuriku', 'tokai', 'kinki', 'chugoku', 'shikoku', 'kyushu-north', 'kyushu-south-amami', 'okinawa'];
const TEINE = {code: '0110900', name: '札幌市手稲区', prefectureCode: '01'};
const CATALOGUE = {prefectures: PREFECTURES, municipalities: [TEINE], districts: [], earthquakeMunicipalities: new Map([['0110900', {}], ['1310100', {}]])};
const WEATHER6 = ['VPWW55', 'VPWW56', 'VPWW57', 'VPWW58', 'VPWW59', 'VPWW60'];

const E = [];
// 既存の試験チャンネル（自宅の data/supporter_image_test_targets.json）と同じ条件は作らない（重複させない）。
// channel = チャンネル名、rules = 設定（1 つ以上）、opt.features = カスタム契約の機能、opt.same = 下のプランでも保存できる設定（確認を省く）
const EXISTING = {'地震-すべて': '文字-地震', '速報-すべて': '文字-緊急地震速報', '気象-市区町村': '文字-気象-手稲区'};
const add = (plan, group, channel, topic, rules, opt = {}) => E.push({plan, group, channel, topic, rules: [].concat(rules),
 ...(group === '文字' && EXISTING[channel] ? {existing: ['有料テスト｜文字配信', EXISTING[channel]]} : {}), ...opt});
const each = make => REGIONS.map(make);

// --- 画像: Basic
add('supporter', '画像', '津波-地図-全国', '津波の地図・全国', {type: 'tsunami-map', region: 'all', tsunamiOutputs: ['map']});
// --- 画像: Plus
add('plus', '画像', '緊急地震速報-地方', '緊急地震速報（警報）の図・11地方を1地方ずつ（対象になった地方だけ）', each(id => ({type: 'eew-map', regions: [id]})));
const weather = {type: 'weather-map', region: 'all', products: WEATHER6, minSeverity: 'warning'};
add('plus', '画像', '気象地図-地方-警報以上', '気象警報・注意報の地図・11地方・警報以上', each(region => ({...weather, region})));
for (const [id, name] of [['VPWW55', '大雨'], ['VPWW56', '土砂災害'], ['VPWW57', '高潮'], ['VPWW58', '暴風'], ['VPWW59', '波浪'], ['VPWW60', '大雪']])
 add('plus', '画像', `気象地図-${name}だけ`, `気象警報・注意報の地図・全国・${name}だけ（注意報以上）`, {...weather, products: [id], minSeverity: 'advisory'});
add('plus', '画像', '気象表-全国', '気象警報・注意報の表・全国・内容が変わったときだけ', {type: 'warning-table', tables: ['national']});
add('plus', '画像', '気象表-全国-発表なしも', '気象警報・注意報の表・全国・発表のない区域も載せる', {type: 'warning-table', tables: ['national'], showAllAreas: true});
const radar = {type: 'hires-radar', region: 'all'};
const tsunami = {type: 'tsunami-map', region: 'all'};
add('plus', '画像', '津波-地図-地方', '津波の地図・11地方', each(region => ({...tsunami, region, tsunamiOutputs: ['map']})));
add('plus', '画像', '津波-表-全国', '津波の表（満潮時刻を含む）・全国', {...tsunami, tsunamiOutputs: ['table']});
add('plus', '画像', '津波-表-地方', '津波の表（満潮時刻を含む）・11地方', each(region => ({...tsunami, region, tsunamiOutputs: ['table']})));
add('plus', '画像', '津波-観測-全国', '津波観測の表（沖合・沿岸）・全国', {...tsunami, tsunamiOutputs: ['observation']});
add('plus', '画像', '津波-観測-地方', '津波観測の表（沖合・沿岸）・11地方', each(region => ({...tsunami, region, tsunamiOutputs: ['observation']})));
add('plus', '画像', '津波-地図と表', '津波の地図＋表・全国（1つのルール）', {...tsunami, tsunamiOutputs: ['map', 'table']});
add('plus', '画像', '津波-表と観測', '津波の表＋津波観測の表・全国（1つのルール）', {...tsunami, tsunamiOutputs: ['table', 'observation']});
add('plus', '画像', '津波-すべて', '津波の地図＋表＋津波観測の表・全国（1つのルール）', {...tsunami, tsunamiOutputs: ['map', 'table', 'observation']});
const quake = {type: 'earthquake-map'};
const QUAKES = [['VXSE51', '震度速報'], ['VXSE52', '震源'], ['VXSE53', '各地の震度'], ['VXSE62', '長周期']];
for (const [id, name] of QUAKES.filter(([id]) => id === 'VXSE52')) add('plus', '画像', `地震図-${name}だけ`, `地震情報の図・${name}だけ`, {...quake, products: [id]});
// --- 画像: Pro
add('pro', '画像', '緊急地震速報-複数チャンネル', '緊急地震速報（警報）の図・全国（1ルールから複数チャンネル。もう1つは「複数チャンネル-2」）', {type: 'eew-map'}, {channels: 2});
add('pro', '画像', '気象地図-全国-詳細', '気象警報・注意報の地図・全国＋市区町村の詳細（警報以上）', {...weather, municipalityDetail: true});
add('pro', '画像', '気象表-地方', '気象警報・注意報の表・11地方・内容が変わったときだけ', {type: 'warning-table', tables: ['regional'], regions: REGIONS});
add('pro', '画像', '気象表-全国と地方', '気象警報・注意報の表・全国＋北海道地方（1つのルール）', {type: 'warning-table', tables: ['national', 'regional'], regions: ['hokkaido']});
add('pro', '画像', '時系列予想', '気象警報・注意報の時系列予想・北海道地方・内容が変わったときだけ', {type: 'warning-timeseries', regions: ['hokkaido']});
add('pro', '画像', '時系列予想-複数地方', '気象警報・注意報の時系列予想・東北＋近畿', {type: 'warning-timeseries', regions: ['tohoku', 'kinki']});
for (const mm of ['10', '20', '50', '80'])
 add('pro', '画像', `雨雲-${mm}mm以上`, `雨雲レーダー（高解像度版）・全国・1時間降水量${mm}mm以上・1時間ごと`, {...radar, radarCondition: 'rainfall-threshold', rainfallThresholdMmPerHour: mm, deliveryIntervalMinutes: 60});
add('pro', '画像', '雨雲-地方-30mm以上', '雨雲レーダー（高解像度版）・11地方・1時間降水量30mm以上・3時間ごと', each(region => ({...radar, region, radarCondition: 'rainfall-threshold', rainfallThresholdMmPerHour: '30', deliveryIntervalMinutes: 180})));
add('pro', '画像', '雨雲予想-全国', '雨雲レーダー（高解像度版）の予想（GIF）・全国・1時間ごと', {...radar, radarContents: ['forecast'], forecastIntervalMinutes: 60});
add('pro', '画像', '雨雲予想-地方', '雨雲レーダー（高解像度版）の予想（GIF）・11地方・6時間ごと', each(region => ({...radar, region, radarContents: ['forecast'], forecastIntervalMinutes: 360})));
add('pro', '画像', '雨雲-現在と予想', '雨雲レーダー（高解像度版）・全国・現在の図30分ごと＋予想（GIF）3時間ごと（1つのルール）', {...radar, radarContents: ['current', 'forecast'], deliveryIntervalMinutes: 30, forecastIntervalMinutes: 180});
add('pro', '画像', '雨雲予想-30mm以上', '雨雲レーダー（高解像度版）の予想（GIF）・全国・1時間降水量30mm以上を観測したとき・1時間ごと', {...radar, radarContents: ['forecast'], radarCondition: 'rainfall-threshold', rainfallThresholdMmPerHour: '30', forecastIntervalMinutes: 60});
add('pro', '画像', '津波-拡大図-全国', '津波の地図・全国＋発表地域の拡大図', {...tsunami, tsunamiOutputs: ['map'], enlargedArea: true});
add('pro', '画像', '津波-拡大図-地方', '津波の地図・11地方＋発表地域の拡大図', each(region => ({...tsunami, region, tsunamiOutputs: ['map'], enlargedArea: true})));
const allQuakes = {...quake, products: QUAKES.map(([id]) => id)};
for (const [id, name] of [['1', '震度1'], ['4', '震度4'], ['5-', '震度5弱'], ['6+', '震度6強']]) add('pro', '画像', `地震図-${name}以上`, `地震情報の図・全国で${name}以上`, {...allQuakes, minIntensity: id});
add('pro', '画像', '地震図-地方別しきい値', '地震情報の図・北海道で震度1以上、東北で震度3以上、関東甲信で震度4以上', {...allQuakes, regionMinIntensity: {hokkaido: '1', tohoku: '3', 'kanto-koshin': '4'}});
for (const id of ['1', '2', '3', '4']) add('pro', '画像', `地震図-長周期階級${id}以上`, `地震情報の図・長周期地震動階級${id}以上`, {...allQuakes, minLgInt: id});
add('pro', '画像', '地震図-中心と震度3以上', '地震情報の図・東京都千代田区中心・震度3以上', {...allQuakes, centerMunicipality: '1310100', minIntensity: '3'});
// --- 画像: カスタム（機能を 1 つずつ許可した契約）
add('custom', '画像', '個別-緊急地震速報だけ', 'カスタム：緊急地震速報（警報）の図だけを許可', {type: 'eew-map'}, {features: ['eewMap']});
add('custom', '画像', '個別-時系列予想だけ', 'カスタム：時系列予想だけを許可（北海道地方）', {type: 'warning-timeseries', regions: ['hokkaido']}, {features: ['warningTableTimeseries']});
add('custom', '画像', '個別-雨雲予想だけ', 'カスタム：雨雲レーダー（高解像度版）＋予想だけを許可', {...radar, radarContents: ['forecast'], forecastIntervalMinutes: 360}, {features: ['hiresRadar', 'hiresRadarForecast']});
add('custom', '画像', '個別-地震図だけ', 'カスタム：地震情報の図だけを許可', allQuakes, {features: ['earthquakeMap']});
add('custom', '画像', '個別-津波全国だけ', 'カスタム：津波の全国の地図だけを許可', {...tsunami, tsunamiOutputs: ['map']}, {features: ['tsunamiMapNational']});

// --- 文字: Basic
const text = {region: 'all', detail: 'all'};
for (const [id, name] of EARTHQUAKE_DETAILS) add('supporter', '文字', `地震-${id === 'all' ? 'すべて' : name.slice(0, 18)}`, `テキスト：${name}`, {...text, type: 'earthquake', detail: id});
for (const [id, name] of [['3', '震度3'], ['5-', '震度5弱']]) add('supporter', '文字', `地震-${name}以上`, `テキスト：地震情報・${name}以上`, {...text, type: 'earthquake', intensityMode: 'threshold', intensity: id});
add('supporter', '文字', '地震-m4以上', 'テキスト：地震情報・M4以上', {...text, type: 'earthquake', magnitudeMode: 'threshold', magnitudeMin: '4'});
add('supporter', '文字', '地震-地方', 'テキスト：地震情報・北海道地方', {...text, type: 'earthquake', region: 'hokkaido'});
for (const [id, name] of EEW_DETAILS) add('supporter', '文字', `速報-${{all: 'すべて', forecast: '予報', warning: '警報'}[id]}`, `テキスト：${name}`, {...text, type: 'eew', detail: id});
add('supporter', '文字', '速報-最終報なし', 'テキスト：緊急地震速報・最終報は震度が変わったときだけ', {...text, type: 'eew', sendFinalReport: false});
add('supporter', '文字', '速報-対象地方だけ', 'テキスト：緊急地震速報（警報）・関東甲信が対象のときだけ', {...text, type: 'eew', detail: 'warning', region: 'kanto-koshin', eewWarningAreaMode: 'target-only'});
for (const [id, name] of WEATHER_DETAILS) add('supporter', '文字', `気象-${id === 'all' ? 'すべて' : name.replace(/（|）|・/g, '-').slice(0, 18)}`, `テキスト：${name}`, {...text, type: 'weather', detail: id});
add('supporter', '文字', '簡略版-定時', 'テキスト設定：雨雲レーダー（簡略版）・関東甲信・6時間ごと', {...text, type: 'rain-radar', region: 'kanto-koshin', radarCondition: 'all', deliveryIntervalHours: '6'});
add('supporter', '文字', '簡略版-降雨検知', 'テキスト設定：雨雲レーダー（簡略版）・関東甲信・降雨を検出・3時間ごと', {...text, type: 'rain-radar', region: 'kanto-koshin', radarCondition: 'rain-detected', deliveryIntervalHours: '3'});
// --- 文字: Plus
add('plus', '文字', '地震-都道府県', 'テキスト：地震情報・北海道（都道府県の指定）', {...text, type: 'earthquake', region: 'hokkaido', prefecture: '01'});
add('plus', '文字', '気象-都道府県', 'テキスト：気象情報・北海道（都道府県の指定）', {...text, type: 'weather', region: 'hokkaido', prefecture: '01'});
add('plus', '文字', '簡略版-しきい値', 'テキスト設定：雨雲レーダー（簡略版）・全国・5mm/h以上', {...text, type: 'rain-radar', radarCondition: 'rainfall-threshold', rainfallThresholdMmPerHour: '5', deliveryIntervalHours: '3'});
// --- 文字: Pro
add('pro', '文字', '地震-市区町村', 'テキスト：地震情報・札幌市手稲区', {...text, type: 'earthquake', region: 'hokkaido', prefecture: '01', municipality: '0110900'});
add('pro', '文字', '気象-市区町村', 'テキスト：気象情報・札幌市手稲区', {...text, type: 'weather', region: 'hokkaido', prefecture: '01', municipality: '0110900'});
add('pro', '文字', '気象-市区町村-抽出', 'テキスト：気象情報・札幌市手稲区（その市区町村だけの本文）', {...text, type: 'weather', region: 'hokkaido', prefecture: '01', municipality: '0110900', strictMunicipality: true});
add('pro', '文字', '地震-and条件', 'テキスト：地震情報・震度3以上 かつ M4以上', {...text, type: 'earthquake', intensityMode: 'threshold', intensity: '3', conditions: [{kind: 'magnitude', value: '4'}]});
add('pro', '文字', '地震-or条件', 'テキスト：地震情報・震度3以上 または M4以上', {...text, type: 'earthquake', conditionLogic: 'or', intensityMode: 'threshold', intensity: '3', conditions: [{kind: 'magnitude', value: '4'}]});
add('pro', '文字', '地震-複数チャンネル', 'テキスト：地震情報・1ルールから複数チャンネル', {...text, type: 'earthquake'}, {channels: 2});

const subscription = (plan, features) => plan === 'custom'
 ? {status: 'active', recognizedPlan: true, planId: 'custom', managedCustom: true, customFeatures: features, complexConditions: false, multiDestination: false, ...LIMITS.custom}
 : {status: 'active', recognizedPlan: true, planId: plan, ...LIMITS[plan]};
const limitsOf = sub => ({...LIMITS[sub.planId], ...planFeatures([sub]), ...geographicEntitlements([sub])});
const save = (rules, sub) => normalizeSupporterRules(rules, [{id: GUILD, name: 'test'}], limitsOf(sub), CATALOGUE, {imageRules: true, imageRulesV2: true});
const database = rules => ({prepare: sql => ({all: async () => sql.includes('supporter_custom_plans') ? {results: []}
 : {results: [{discord_user_id: '637850681666961408', customer_id: 'cus_1', revision: 1, settings_json: JSON.stringify({rules})}]}})});
const snapshot = async (rules, sub) => (await buildSupporterSnapshot(database(rules), ENV, async () => new Map([['cus_1', [sub]]]))).rules;

const entries = [], problems = [], checks = {saved: 0, higher: 0, refused: 0};
for (const [number, entry] of E.entries()) {
 const channelIds = Array.from({length: entry.channels || 1}, (_, index) => String(90000000000000000n + BigInt(number * 10 + index)));
 const label = `${PLAN_LABEL[entry.plan]}・${entry.channel}`;
 const raw = entry.rules.map((rule, index) => ({...rule, name: `デバッグ ${label}${entry.rules.length > 1 ? `（${index + 1}）` : ''}`.slice(0, 80), guildId: GUILD, channelId: channelIds[0], channelIds}));
 const sub = subscription(entry.plan, entry.features);
 try {
  const delivered = await snapshot(save(raw, sub), sub);
  if (delivered.length !== raw.length) problems.push(`${label}: 保存 ${raw.length} 件に対し配信データ ${delivered.length} 件`);
  checks.saved += delivered.length;
  entries.push({key: `${entry.plan}-${number}`, plan: PLAN_LABEL[entry.plan], group: entry.group, channel: entry.channel, topic: entry.topic, ...(entry.existing ? {existing: entry.existing} : {}), channelIds, rules: delivered});
 } catch (error) { problems.push(`${label}: 保存できません（${error.message}）`); continue; }
 if (entry.plan === 'custom') continue;
 for (const plan of ORDER) {
  if (plan === entry.plan) continue;
  const other = subscription(plan);
  if (ORDER.indexOf(plan) > ORDER.indexOf(entry.plan)) {
   try { if ((await snapshot(save(raw, other), other)).length === raw.length) checks.higher += raw.length; else problems.push(`${label}: ${PLAN_LABEL[plan]} では配信されない`); }
   catch (error) { problems.push(`${label}: ${PLAN_LABEL[plan]} で保存できません（${error.message}）`); }
  } else {
   let refused = false;
   try { save(raw.slice(0, 1), other); } catch { refused = true; }
   if (refused) checks.refused += 1; else problems.push(`${label}: ${PLAN_LABEL[plan]} でも保存できてしまう`);
  }
 }
}
process.stdout.write(JSON.stringify({generatedAt: new Date().toISOString(), checks, problems, entries}, null, 1) + '\n');
